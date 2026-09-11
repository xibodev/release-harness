/**
 * Executing assertions against resolved bindings.
 *
 * This is the adapter layer between the contract model and the probe code that
 * already works. The probes are kept as they are; what changes is how they are
 * reached -- every input comes from an explicit binding passed in, and nothing
 * here consults the current working directory, a topology, or any notion of
 * "the product". An assertion says what must hold and names a symbol; the
 * caller says what that symbol resolves to. There is no third source of truth.
 *
 * Each execution returns an observation carrying its own cause. That matters
 * more than it looks: a probe that could not reach a binding reports
 * BINDING_INVALID, not silence, so nothing downstream has to guess what the
 * absence of a result meant. Under the old default, silence became a product
 * bug.
 */

import { spawn } from 'node:child_process';
import { probeHttp } from '../probes.js';
import { CAUSE } from '../attribution.js';

/** Parse a bound location into the pieces probeHttp needs. */
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
    return {
      passed: false,
      cause: CAUSE.BINDING_INVALID,
      observed: target.reason,
      detail: { location },
    };
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

  // Nothing answered. That is a statement about the binding, not about the
  // software: there may be nothing there to be broken.
  if (result.status === 0) {
    return {
      passed: false,
      cause: CAUSE.BINDING_INVALID,
      observed: `Nothing answered at ${target.scheme}://${target.host}:${target.port}${requestPath} (${result.message})`,
      detail: { location, request_path: requestPath },
    };
  }

  // Something answered, and said the wrong thing. This is a real observation of
  // the subject's behaviour, so it can carry a product attribution.
  const matched = result.status === expectedStatus;
  return {
    passed: matched,
    cause: matched ? 'NONE' : CAUSE.PRODUCT,
    observed: `HTTP ${result.status} from ${requestPath}, expected ${expectedStatus}`,
    detail: {
      location,
      request_path: requestPath,
      status: result.status,
      expected_status: expectedStatus,
      elapsed_ms: result.elapsedMs,
    },
  };
}

/**
 * Did this process fail to START, rather than run and report a failure?
 *
 * A non-zero exit is ambiguous, and resolving that ambiguity toward the product
 * is the exact defect this project exists to eliminate. `node /missing.js` exits
 * 1 without the subject ever running: the interpreter started, could not find
 * what it was asked to run, and gave up. Reading that as "the assertion was
 * violated" accuses software that was never reached.
 *
 * These signatures are conservative. A false positive here weakens a real
 * product finding to UNKNOWN, which is recoverable by reading the evidence; a
 * false negative fabricates an accusation, which is not. When the signal is
 * ambiguous, the harness must decline to accuse.
 */
function looksLikeItNeverRan(stderr, exitCode) {
  if (!stderr) return false;
  const signatures = [
    /Cannot find module/i,
    /MODULE_NOT_FOUND/,
    /No such file or directory/i,
    /command not found/i,
    /is not recognized as an internal or external command/i,
    /Permission denied/i,
    /cannot execute binary file/i,
    /ModuleNotFoundError/,
    /ImportError: /,
    /can't open file/i,
  ];
  // 126/127 are the shell's own "could not execute" / "not found" codes.
  if (exitCode === 126 || exitCode === 127) return true;
  return signatures.some((re) => re.test(stderr));
}

async function executeCli(assertion, location, timeoutMs, cwd) {
  const expect = assertion.expect ?? {};
  const expectedExit = typeof expect.exit_code === 'number' ? expect.exit_code : 0;

  // The bound location IS the command. An assertion never carries one, because
  // a command is a local fact about where things are installed.
  const parts = String(location).trim().split(/\s+/);
  const extra = typeof expect.args === 'string' ? expect.args.trim().split(/\s+/) : [];
  const argv = [...parts.slice(1), ...extra];

  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const child = spawn(parts[0], argv, { cwd, shell: false });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({
        passed: false,
        cause: CAUSE.HARNESS_ENVIRONMENT,
        observed: `"${location}" did not finish within ${timeoutMs}ms`,
        detail: { location },
      });
    }, timeoutMs);

    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The command could not be started at all: the binding points at nothing
      // runnable, which is not evidence about the subject.
      resolve({
        passed: false,
        cause: CAUSE.BINDING_INVALID,
        observed: `Could not run "${location}": ${err.message}`,
        detail: { location },
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // Before judging the exit code, ask whether the subject ran at all. A
      // command that could not be found produces a non-zero exit that says
      // nothing whatsoever about the software the assertion is about.
      if (code !== 0 && looksLikeItNeverRan(stderr, code)) {
        resolve({
          passed: false,
          cause: CAUSE.BINDING_INVALID,
          observed: `"${location}" could not be run (exit ${code}); the subject was never reached`,
          detail: {
            location,
            exit_code: code,
            stderr: stderr.slice(0, 4000),
          },
        });
        return;
      }

      const matched = code === expectedExit;
      const contains = typeof expect.stdout_contains === 'string' ? expect.stdout_contains : null;
      const textOk = contains === null || stdout.includes(contains);

      resolve({
        passed: matched && textOk,
        cause: matched && textOk ? 'NONE' : CAUSE.PRODUCT,
        observed: matched
          ? textOk
            ? `exit ${code}`
            : `exit ${code}, but stdout did not contain ${JSON.stringify(contains)}`
          : `exit ${code}, expected ${expectedExit}`,
        detail: {
          location,
          exit_code: code,
          expected_exit_code: expectedExit,
          stdout: stdout.slice(0, 4000),
          stderr: stderr.slice(0, 4000),
        },
      });
    });
  });
}

/** The assertion kinds this version can execute. */
export const SUPPORTED_KINDS = ['http', 'cli'];

/**
 * Execute one assertion.
 *
 * An unknown kind fails closed as a contract problem. It is not skipped: a run
 * that quietly ignores an assertion certifies less than it appears to, and the
 * gap is invisible in the result.
 */
export async function executeAssertion(assertion, resolvedTargets, { timeoutMs = 15000, cwd } = {}) {
  const location = resolvedTargets[assertion.target];

  if (location === undefined) {
    return {
      id: assertion.id,
      passed: false,
      cause: CAUSE.BINDING_INVALID,
      observed: `Target "${assertion.target}" is not bound.`,
      detail: {},
    };
  }

  if (!SUPPORTED_KINDS.includes(assertion.kind)) {
    return {
      id: assertion.id,
      passed: false,
      cause: CAUSE.CONTRACT_INVALID,
      observed:
        `Assertion kind "${assertion.kind}" cannot be executed by this version ` +
        `(supported: ${SUPPORTED_KINDS.join(', ')}).`,
      detail: {},
    };
  }

  const outcome =
    assertion.kind === 'http'
      ? await executeHttp(assertion, location, timeoutMs)
      : await executeCli(assertion, location, timeoutMs, cwd);

  return { id: assertion.id, ...outcome };
}
