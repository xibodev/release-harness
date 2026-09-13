/**
 * Executing assertions against resolved bindings.
 *
 * This is core, not CLI. Everything here is a rule a future API caller or
 * authoring agent would need applied identically -- what counts as a
 * structurally establishable binding fault, whether the subject was reached,
 * how a spawn failure is classified. It lived under `cli/` while the command
 * surface was being built, which is the kind of accident that turns into a
 * second implementation the first time something other than the CLI needs to
 * run an assertion.
 *
 * The hard problem here is not running things. It is knowing whether the
 * subject ran at all, because a process exit code alone cannot tell you.
 * `node /missing.js` exits 1 without the subject ever executing, and reading
 * that as "the assertion was violated" accuses software that was never reached.
 *
 * An earlier version of this file solved that by matching stderr against
 * phrases like "Cannot find module". That was wrong in both directions, and
 * dangerous in both:
 *
 *   - stderr is application-controlled. A subject that legitimately prints
 *     "Cannot find module" while failing its own assertion would have had a
 *     real product finding silently demoted to a configuration problem.
 *   - the vocabulary is not stable. Wording changes between runtime versions,
 *     locales and wrappers, so the classification would drift without anyone
 *     changing a line of code.
 *
 * A regex over application output must never decide whether software deserves
 * to be accused. So attribution here is established structurally, and the
 * distinction that makes it sound is this: the BINDING is operator-controlled
 * configuration, which may be inspected freely; the subject's OUTPUT is not
 * evidence about who is responsible.
 *
 * Four outcomes, in the order they can be established:
 *
 *   1. Preflight fails      -- something the binding names does not exist.
 *                              Checked before launching anything.
 *   2. Spawn fails          -- the OS says the child could not start, reported
 *                              through a structured errno, never through text.
 *   3. The subject ran      -- and only now may a failed assertion be a
 *                              product finding.
 *   4. Cannot be determined -- the binding could not be decomposed, or the
 *                              process did not exit normally. UNKNOWN.
 *
 * The asymmetry is deliberate and permanent: weakening an ambiguous accusation
 * to UNKNOWN is recoverable by reading the evidence; inventing a product
 * attribution is not.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { probeHttp } from './probes.js';
import { CAUSE } from './attribution.js';
import { EXECUTABLE_KINDS } from './contract.js';

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function parseHttpTarget(location) {
  let url;
  try {
    url = new URL(location);
  } catch {
    return { ok: false, reason: `"${location}" is not a URL` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `"${location}" is not an http(s) URL` };
  }
  return {
    ok: true,
    scheme: url.protocol.slice(0, -1),
    host: url.hostname,
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    basePath: url.pathname.replace(/\/$/, ''),
  };
}

async function executeHttp(assertion, location, timeoutMs) {
  const target = parseHttpTarget(location);
  if (!target.ok) {
    return { passed: false, cause: CAUSE.BINDING_INVALID, observed: target.reason, detail: { location } };
  }

  const expect = assertion.expect ?? {};
  const expectedStatus = typeof expect.status === 'number' ? expect.status : 200;
  const requestPath = `${target.basePath}${expect.path ?? '/'}` || '/';

  const result = await probeHttp({
    scheme: target.scheme,
    host: target.host,
    port: target.port,
    path: requestPath,
    method: expect.method ?? 'GET',
    expectedStatus,
    timeoutMs,
  });

  // HTTP has an advantage the process adapter does not: a response IS proof
  // the subject was reached. No response is proof it was not. The distinction
  // is structural and needs no interpretation of content.
  if (result.status === 0) {
    return {
      passed: false,
      cause: CAUSE.BINDING_INVALID,
      observed: `Nothing answered at ${target.scheme}://${target.host}:${target.port}${requestPath} (${result.message})`,
      detail: { location, request_path: requestPath, subject_reached: false },
    };
  }

  const statusMatched = result.status === expectedStatus;

  // D39. A body expectation is checked only when the author wrote one, so an
  // assertion that promises nothing about the body is unchanged by this.
  const wantsBody = typeof expect.body_contains === 'string' ? expect.body_contains : null;
  const body = typeof result.body === 'string' ? result.body : '';
  const bodyMatched = wantsBody === null || body.includes(wantsBody);

  const matched = statusMatched && bodyMatched;

  const detail = {
    location,
    request_path: requestPath,
    status: result.status,
    expected_status: expectedStatus,
    elapsed_ms: result.elapsedMs,
    subject_reached: true,
  };
  if (wantsBody !== null) {
    detail.expected_body_contains = wantsBody;
    // Evidence of what actually answered, bounded like every other capture.
    detail.body = body.slice(0, 4000);
  }

  const observed = !statusMatched
    ? `HTTP ${result.status} from ${requestPath}, expected ${expectedStatus}`
    : bodyMatched
      ? `HTTP ${result.status} from ${requestPath}`
      : `HTTP ${result.status} from ${requestPath}, but the body did not contain ${JSON.stringify(wantsBody)}`;

  return {
    passed: matched,
    cause: matched ? 'NONE' : CAUSE.PRODUCT,
    observed,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Process bindings: structural preflight
// ---------------------------------------------------------------------------

/**
 * Syntax that asks a shell to compose processes or redirect streams.
 *
 * The process adapter never invokes a shell. This check therefore does not
 * exist to escape punctuation; it catches a binding whose author meant a
 * pipeline or redirection, because passing those tokens literally to the first
 * executable would exercise something other than what they wrote.
 *
 * D42: the old character blacklist included backslash, quotes, parentheses,
 * wildcards and other characters that are ordinary path data. On Windows it
 * rejected every absolute executable path before `spawn(..., { shell:false })`
 * had a chance to preserve it. Structure decides this now: an exact path is one
 * executable, while actual composition operators are refused in command text.
 */
const SHELL_COMPOSITION = /(?:&&|\|\||[|&;<>]|\$\(|`|\r|\n)/;

/**
 * Is the whole binding structurally an executable path?
 *
 * `path.win32` is used explicitly so Windows paths remain recognisable in
 * cross-platform tests and tools. Existence is not required here: a missing
 * absolute executable still needs to reach preflight unchanged so it can be
 * reported as a structural binding failure rather than corrupted by parsing.
 */
function isExecutablePath(text, cwd, { allowMissingAbsolute = true } = {}) {
  const absolute = path.isAbsolute(text) || path.win32.isAbsolute(text);
  if (absolute && allowMissingAbsolute) return true;
  const candidate = absolute ? text : path.resolve(cwd, text);
  return fs.existsSync(candidate);
}

/** Split a direct-execution binding into an executable and its fixed operands. */
function decompose(location, cwd) {
  const text = String(location).trim();
  if (!text) return { ok: false, reason: 'the binding is empty' };

  // Exact path identity wins before any command-line tokenisation. Spaces,
  // backslashes, colons and parentheses are path data, and no shell ever sees
  // them. No transport-layer quotes are stored or needed.
  //
  // Existing bindings may also carry fixed operands after an executable path.
  // Find the longest whitespace-delimited prefix that is an existing
  // executable first; only when none exists can an absolute string containing
  // spaces be a missing executable path in its entirety.
  const boundaries = [...text.matchAll(/\s+/g)].map((m) => m.index);
  for (let i = boundaries.length - 1; i >= 0; i -= 1) {
    const executable = text.slice(0, boundaries[i]);
    if (!isExecutablePath(executable, cwd, { allowMissingAbsolute: false })) continue;
    const operands = text.slice(boundaries[i]).trim().split(/\s+/).filter(Boolean);
    return { ok: true, executable, operands };
  }

  if (isExecutablePath(text, cwd)) {
    return { ok: true, executable: text, operands: [] };
  }

  if (SHELL_COMPOSITION.test(text) || /["']/.test(text)) {
    return {
      ok: false,
      reason:
        'the binding uses shell syntax, so which stage failed cannot be established ' +
        'from outside',
    };
  }

  // Fixed arguments in an existing string binding retain the established
  // whitespace-token model. Assertion `expect.args` remains a string by design;
  // D42 does not expand that model into quoting or shell parsing.
  const parts = text.split(/\s+/);
  return { ok: true, executable: parts[0], operands: parts.slice(1) };
}

/**
 * Find an executable the way the OS would: a path is checked directly, a bare
 * name is searched along PATH (honouring PATHEXT on Windows).
 *
 * This is a filesystem question with a filesystem answer. Nothing here consults
 * anything the subject produced.
 */
function resolveExecutable(executable, cwd) {
  const hasSeparator = executable.includes('/') || executable.includes(path.sep);

  if (hasSeparator) {
    const full = path.resolve(cwd, executable);
    return fs.existsSync(full) ? { found: true, at: full } : { found: false, searched: [full] };
  }

  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, executable + ext);
      if (fs.existsSync(candidate)) return { found: true, at: candidate };
    }
  }
  return { found: false, searched: [`PATH (${dirs.length} entries)`] };
}

/**
 * Does this operand unambiguously name a file?
 *
 * Conservative on purpose: a path separator or a script extension is a
 * structural signal that the operator meant a file. A bare word like `there` is
 * an argument and is left alone, because flagging it would invent a binding
 * error out of an ordinary parameter.
 */
const SCRIPT_EXTENSIONS = /\.(js|mjs|cjs|ts|py|rb|sh|bash|php|pl|jar|exe)$/i;

function looksLikeFileOperand(operand) {
  if (operand.startsWith('-')) return false;
  if (operand.includes('=')) return false;
  return operand.includes('/') || operand.includes('\\') || SCRIPT_EXTENSIONS.test(operand);
}

/**
 * Establish, before launching anything, whether the binding names things that
 * exist. Returns either a refusal or the evidence that the subject is reachable.
 */
function preflight(location, cwd) {
  if (!fs.existsSync(cwd)) {
    return {
      ok: false,
      cause: CAUSE.BINDING_INVALID,
      observed: `The working directory ${cwd} does not exist`,
      detail: { location, cwd },
    };
  }

  const parts = decompose(location, cwd);
  if (!parts.ok) {
    // Not a filesystem problem -- the command may well be valid. What it is is
    // unattributable, which the caller turns into a refusal to execute.
    return { ok: true, decomposable: false, reason: parts.reason };
  }

  const resolved = resolveExecutable(parts.executable, cwd);
  if (!resolved.found) {
    return {
      ok: false,
      cause: CAUSE.BINDING_INVALID,
      observed: `The executable "${parts.executable}" could not be found`,
      detail: { location, searched: resolved.searched },
    };
  }

  // Every file the binding explicitly names must exist. This is the check that
  // catches `node /missing.js` before anything runs -- and it catches it by
  // asking the filesystem, not by reading what node printed afterwards.
  for (const operand of parts.operands) {
    if (!looksLikeFileOperand(operand)) continue;
    const full = path.resolve(cwd, operand);
    if (!fs.existsSync(full)) {
      return {
        ok: false,
        cause: CAUSE.BINDING_INVALID,
        observed: `The binding names "${operand}", which does not exist`,
        detail: { location, missing_path: full },
      };
    }
  }

  return {
    ok: true,
    decomposable: true,
    executable: parts.executable,
    executablePath: resolved.at,
    argv: parts.operands,
  };
}

/**
 * Classify a spawn failure from its errno.
 *
 * The error object is produced by the OS and the runtime, not by the subject,
 * so it is admissible where stderr is not.
 */
function causeForSpawnError(err) {
  switch (err.code) {
    case 'ENOENT':
      // The executable disappeared between preflight and launch, or was never
      // really there. Either way the subject was not reached.
      return { cause: CAUSE.BINDING_INVALID, observed: `Could not start "${err.path ?? ''}": not found` };
    case 'EACCES':
    case 'EPERM':
      return {
        cause: CAUSE.BINDING_INVALID,
        observed: `Could not start "${err.path ?? ''}": permission denied`,
      };
    case 'EMFILE':
    case 'ENOMEM':
    case 'EAGAIN':
      // The machine could not start a process. That is the environment, and it
      // says nothing about the subject.
      return { cause: CAUSE.HARNESS_ENVIRONMENT, observed: `Could not start the process: ${err.code}` };
    default:
      return { cause: CAUSE.UNKNOWN, observed: `The process could not be started (${err.code ?? err.message})` };
  }
}

async function executeProcess(assertion, location, timeoutMs, cwd) {
  const expect = assertion.expect ?? {};
  const expectedExit = typeof expect.exit_code === 'number' ? expect.exit_code : 0;

  const pre = preflight(location, cwd);
  if (!pre.ok) {
    return { passed: false, cause: pre.cause, observed: pre.observed, detail: { ...pre.detail, subject_reached: false } };
  }

  // A binding this adapter cannot decompose is refused rather than run.
  //
  // Running it anyway would be worse than useless: the arguments would be
  // passed literally to the first program (so `node app.js | grep x` hands
  // `|` and `grep` to node, which then waits on stdin forever), and whatever
  // came back could not be attributed to anything in particular. Declining is
  // the honest answer, and it names the missing capability rather than
  // producing a result the operator would have to distrust.
  if (!pre.decomposable) {
    return {
      passed: false,
      cause: CAUSE.UNKNOWN,
      observed:
        `"${location}" was not executed: ${pre.reason}. Nothing can be attributed, ` +
        'so nothing is claimed. Bind a single program, or wrap the pipeline in a ' +
        'script and bind that.',
      detail: { location, subject_reached: 'not_established', unattributable_because: pre.reason },
    };
  }

  const argv = [
    ...(pre.argv ?? []),
    ...(typeof expect.args === 'string' ? expect.args.trim().split(/\s+/).filter(Boolean) : []),
  ];

  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    let child;
    try {
      child = spawn(pre.executable, argv, { cwd, shell: false });
    } catch (err) {
      const { cause, observed } = causeForSpawnError(err);
      resolve({ passed: false, cause, observed, detail: { location, errno: err.code, subject_reached: false } });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({
        passed: false,
        cause: CAUSE.HARNESS_ENVIRONMENT,
        observed: `"${location}" did not finish within ${timeoutMs}ms`,
        detail: { location, timed_out: true, subject_reached: true },
      });
    }, timeoutMs);

    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const { cause, observed } = causeForSpawnError(err);
      resolve({ passed: false, cause, observed, detail: { location, errno: err.code, subject_reached: false } });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // Killed rather than exited. There is no exit code to judge, and no way
      // to know how far it got.
      if (code === null) {
        resolve({
          passed: false,
          cause: CAUSE.UNKNOWN,
          observed: `"${location}" was terminated by ${signal} without exiting`,
          detail: { location, signal, subject_reached: 'not_established' },
        });
        return;
      }

      const contains = typeof expect.stdout_contains === 'string' ? expect.stdout_contains : null;
      // D40. Asserted only when the author wrote the expectation. The streams
      // stay separately captured: stdout_contains never sees stderr, and
      // stderr_contains never sees stdout.
      const errContains = typeof expect.stderr_contains === 'string' ? expect.stderr_contains : null;
      const exitMatched = code === expectedExit;
      const textMatched = contains === null || stdout.includes(contains);
      const errMatched = errContains === null || stderr.includes(errContains);
      const passed = exitMatched && textMatched && errMatched;

      const detail = {
        location,
        exit_code: code,
        expected_exit_code: expectedExit,
        // D42: these are also structural evidence that parsing never changed
        // the executable identity before direct launch.
        executable_requested: pre.executable,
        executable_spawned: pre.executable,
        argv,
        shell: false,
        stdout: stdout.slice(0, 4000),
        stderr: stderr.slice(0, 4000),
        ...(contains === null ? {} : { expected_stdout_contains: contains }),
        ...(errContains === null ? {} : { expected_stderr_contains: errContains }),
        // Preflight proved the executable and every named file exist, and the
        // process ran to a normal exit. The subject was reached.
        subject_reached: true,
      };

      if (passed) {
        resolve({ passed: true, cause: 'NONE', observed: `exit ${code}`, detail });
        return;
      }

      const what = !exitMatched
        ? `exit ${code}, expected ${expectedExit}`
        : !textMatched
          ? `exit ${code}, but stdout did not contain ${JSON.stringify(contains)}`
          : `exit ${code}, but stderr did not contain ${JSON.stringify(errContains)}`;

      // The decisive branch. Preflight established that the executable and every
      // file the binding names exist, and the process ran to a normal exit --
      // so this exit code is the subject's own behaviour and may be attributed.
      // Note what stderr is still NOT used for: guessing a cause. The harness
      // never reads stderr to decide whether a failure is the product's fault
      // -- that regex-over-stderr attribution was removed from the trust
      // boundary on purpose. An author explicitly promising a diagnostic is a
      // different act: the expectation came from a person, not a pattern.
      // A subject that fails while printing "Cannot find module" is still a
      // subject that failed.
      resolve({ passed: false, cause: CAUSE.PRODUCT, observed: what, detail });
    });
  });
}

/** The assertion kinds this version can execute. */
// Re-exported from the contract model, which is where what a contract may
// promise is decided. Two lists would eventually disagree.
export { EXECUTABLE_KINDS as SUPPORTED_KINDS } from './contract.js';

/**
 * Execute one assertion.
 *
 * An unknown kind fails closed as a contract problem rather than being skipped:
 * a run that quietly ignores an assertion certifies less than it appears to,
 * and the gap is invisible in the result.
 */
export async function executeAssertion(assertion, resolvedTargets, { timeoutMs = 15000, cwd } = {}) {
  // An omitted working directory means "here", not a directory literally named
  // undefined. Without this the preflight existence check reported `The working
  // directory undefined does not exist` and attributed a BINDING_INVALID -- a
  // confusing accusation aimed at the caller for not passing an optional
  // argument the signature declares as optional.
  const workingDir = cwd ?? process.cwd();
  const location = resolvedTargets[assertion.target];

  if (location === undefined) {
    return {
      id: assertion.id,
      passed: false,
      cause: CAUSE.BINDING_INVALID,
      observed: `Target "${assertion.target}" is not bound.`,
      detail: { subject_reached: false },
    };
  }

  if (!EXECUTABLE_KINDS.includes(assertion.kind)) {
    return {
      id: assertion.id,
      passed: false,
      cause: CAUSE.CONTRACT_INVALID,
      observed:
        `Assertion kind "${assertion.kind}" cannot be executed by this version ` +
        `(supported: ${EXECUTABLE_KINDS.join(', ')}).`,
      detail: {},
    };
  }

  const outcome =
    assertion.kind === 'http'
      ? await executeHttp(assertion, location, timeoutMs)
      : await executeProcess(assertion, location, timeoutMs, workingDir);

  return { id: assertion.id, ...outcome };
}
