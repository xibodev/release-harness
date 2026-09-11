// CLI tests, through the actual executable.
//
// These spawn `release-harness` as a process against throwaway directories.
// Nothing here imports a core module to do the work, because the thing under
// test is the PRODUCT: a user gets the binary, not the library, and every
// guarantee this project makes has to survive the trip through it.
//
// That distinction is not academic. The library was correct and the shipped
// product still attributed a fabricated failure to its adopter, because the
// executable did not route through the good code. A test that imports
// acceptDraft() would have passed the whole time.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'release-harness.js');

const results = [];
function pass(id, name) {
  results.push(id);
  console.log(`  ok  [${id}] ${name}`);
}

console.log('\nCLI: the product, through its executable\n');

/** Run the CLI as a process. No imports, no shortcuts. */
function rh(cwd, args, { expectOk = false } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
  if (r.error) throw r.error;
  const result = {
    code: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    get all() {
      return this.stdout + this.stderr;
    },
    json() {
      return JSON.parse(this.stdout);
    },
  };
  if (expectOk && r.status !== 0) {
    throw new Error(`Expected success from \`${args.join(' ')}\`, got ${r.status}:\n${result.all}`);
  }
  return result;
}

function tmpProject(prefix = 'cli-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // A real subject to make promises about: a tiny CLI with a knowable
  // behaviour. Using a genuine executable rather than a mock means the probe
  // layer is exercised for real.
  fs.writeFileSync(
    path.join(dir, 'greet.js'),
    [
      "const who = process.argv[2] ?? 'world';",
      "if (who === 'fail') { console.error('nope'); process.exit(1); }",
      'console.log(`hello, ${who}`);',
      '',
    ].join('\n')
  );
  return dir;
}

const readJson = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
const writeJson = (dir, rel, v) =>
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(v, null, 2) + '\n');

const DRAFT = '.release-harness/drafts';

/** Author a complete, resolved draft the way an operator would: by editing files. */
function authorGreeterDraft(dir, { resolved = true } = {}) {
  rh(dir, ['draft', 'new', 'greeter'], { expectOk: true });

  const draft = readJson(dir, `${DRAFT}/greeter.draft.json`);
  draft.proposition.subject = { id: 'greeter', name: 'Greeter CLI' };
  draft.proposition.assertions = [
    {
      id: 'A1',
      kind: 'cli',
      target: 'cli',
      description: 'the CLI greets and exits cleanly',
      expect: { exit_code: 0, stdout_contains: 'hello' },
      supported_by: ['entrypoint'],
    },
  ];
  draft.questions = [
    {
      id: 'Q1',
      question: 'Should a missing argument be an error?',
      blocking: true,
      ...(resolved
        ? { resolution: 'No; it defaults to "world".', resolved_by: 'a.operator' }
        : {}),
    },
  ];
  writeJson(dir, `${DRAFT}/greeter.draft.json`, draft);

  const record = readJson(dir, `${DRAFT}/greeter.record.json`);
  record.authored_by = 'a.operator';
  record.claims = [
    {
      id: 'entrypoint',
      claim: 'greet.js prints a greeting and exits 0',
      status: 'observed',
      evidence: { source: 'greet.js:3' },
    },
  ];
  writeJson(dir, `${DRAFT}/greeter.record.json`, record);
}

// ---------------------------------------------------------------------------
// C1  Bootstrap is harmless.
//
// The old `init` wrote a topology claiming a browser app on port 3000 into
// repositories containing no such thing. This asserts the replacement invents
// nothing -- not by inspecting the code, but by reading every byte it wrote.
// ---------------------------------------------------------------------------
{
  const dir = tmpProject('cli-init-');
  const init = rh(dir, ['init'], { expectOk: true });

  assert.match(init.all, /does not inspect your project/i, 'init must say what it did not do');

  // Read everything created and prove no claim about the project is in it.
  const root = path.join(dir, '.release-harness');
  const created = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else created.push(full);
    }
  })(root);

  assert.ok(created.length > 0, 'init must create something');

  const runtimeFiles = created.filter((f) => !f.includes(`${path.sep}examples${path.sep}`));
  const blob = runtimeFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  // The specific fabrications the fixture found, plus the shapes they took.
  for (const forbidden of [/3000/, /localhost/i, /127\.0\.0\.1/, /Welcome/i, /topology/i, /origins/i, /browser/i]) {
    assert.ok(
      !forbidden.test(blob),
      `init must never write ${forbidden} into a runtime location (found in: ${runtimeFiles
        .filter((f) => forbidden.test(fs.readFileSync(f, 'utf8')))
        .map((f) => path.basename(f))
        .join(', ')})`
    );
  }

  // The subject id is the field a tool is most tempted to guess, because the
  // directory name is right there. It must not appear anywhere.
  assert.ok(
    !blob.includes(path.basename(dir)),
    'init must not derive any identity from the directory name'
  );

  // No contract, and no draft: nothing has been proposed, let alone agreed.
  assert.strictEqual(
    fs.readdirSync(path.join(root, 'accepted')).length,
    0,
    'init must create no accepted contract'
  );
  assert.strictEqual(
    fs.readdirSync(path.join(root, 'drafts')).length,
    0,
    'init must create no draft'
  );

  // And doctor must not claim readiness. This is the decisive Fixture A check.
  const doctor = rh(dir, ['doctor']);
  assert.match(doctor.all, /Can anything be certified right now\?\s*No/i, 'doctor must say No');
  assert.ok(!/\bReady\b/.test(doctor.all), 'the word "Ready" must not appear');
  assert.notStrictEqual(doctor.code, 0, 'and it must not exit 0 with nothing accepted');

  fs.rmSync(dir, { recursive: true, force: true });
  pass('C1', 'bootstrap creates no proposition and doctor does not claim readiness');
}

// ---------------------------------------------------------------------------
// C2  An unresolved draft cannot be accepted, and cannot certify.
// ---------------------------------------------------------------------------
{
  const dir = tmpProject('cli-unresolved-');
  rh(dir, ['init'], { expectOk: true });
  authorGreeterDraft(dir, { resolved: false });

  // Validation reports the draft as well-formed -- and says plainly that this
  // is not the same as being ready. Conflating the two is what let a
  // fabrication read as "valid... Ready".
  const validate = rh(dir, ['validate', '--draft', 'greeter']);
  assert.strictEqual(validate.code, 0, 'a well-formed draft validates');
  assert.match(validate.all, /well-formed/i, 'and is described as well-formed');
  assert.match(validate.all, /not ready to accept/i, 'while saying it is not ready');
  assert.match(validate.all, /Q1/, 'naming the unresolved question');

  const accept = rh(dir, ['accept', '--draft', 'greeter', '--by', 'a.operator']);
  assert.notStrictEqual(accept.code, 0, 'acceptance must be refused');
  assert.match(accept.all, /unresolved_question/, 'because a blocking question is open');

  assert.strictEqual(
    fs.readdirSync(path.join(dir, '.release-harness', 'accepted')).length,
    0,
    'and no contract may be written'
  );

  const run = rh(dir, ['bind', 'local', '--target', 'cli=node greet.js']);
  assert.strictEqual(run.code, 0, 'binding is independent of acceptance');
  const certify = rh(dir, ['run', '--binding', 'local']);
  assert.notStrictEqual(certify.code, 0, 'a certifying run must be refused with nothing accepted');

  fs.rmSync(dir, { recursive: true, force: true });
  pass('C2', 'an unresolved draft cannot be accepted and cannot certify');
}

// ---------------------------------------------------------------------------
// C3  The manual happy path, entirely through the executable.
//
// This is the vertical slice as a user experiences it: a person with a text
// editor goes from an empty directory to a verified certifying run.
// ---------------------------------------------------------------------------
{
  const dir = tmpProject('cli-happy-');

  rh(dir, ['init'], { expectOk: true });
  authorGreeterDraft(dir);
  rh(dir, ['validate'], { expectOk: true });

  const accept = rh(dir, ['accept', '--draft', 'greeter', '--by', 'a.operator'], { expectOk: true });
  assert.match(accept.all, /Accepted [0-9a-f]{16}/, 'acceptance reports the digest');

  rh(dir, ['bind', 'local', '--target', 'cli=node greet.js'], { expectOk: true });

  const doctor = rh(dir, ['doctor'], { expectOk: true });
  assert.match(doctor.all, /yes --/, 'doctor confirms something can be certified');

  const run = rh(dir, ['run', '--binding', 'local'], { expectOk: true });
  assert.match(run.all, /Certifying run/, 'the run certifies');
  assert.match(run.all, /Status: PASS/, 'and passes');

  const verify = rh(dir, ['verify'], { expectOk: true });
  assert.match(verify.all, /whole chain verifies/, 'and the chain verifies end to end');
  for (const link of ['contract', 'evidence', 'verdict']) {
    assert.ok(new RegExp(`ok\\s+${link}`).test(verify.all), `${link} must be verified`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  pass('C3', 'a person with a text editor reaches a verified certifying run');
}

// ---------------------------------------------------------------------------
// C4  An exploratory run executes, and can never certify.
// ---------------------------------------------------------------------------
{
  const dir = tmpProject('cli-explore-');
  rh(dir, ['init'], { expectOk: true });
  authorGreeterDraft(dir, { resolved: false });
  rh(dir, ['bind', 'local', '--target', 'cli=node greet.js'], { expectOk: true });

  // Exploratory mode must be asked for. It is never inferred from something
  // being incomplete, or the weakest outcome would become the automatic one.
  const implicit = rh(dir, ['run', '--draft', 'greeter', '--binding', 'local']);
  assert.notStrictEqual(implicit.code, 0, 'running a draft implicitly must be refused');
  assert.match(implicit.all, /--exploratory/, 'and must name the flag that says so');

  const explore = rh(dir, ['run', '--draft', 'greeter', '--exploratory', '--binding', 'local']);
  assert.match(explore.all, /NOT certifying/i, 'the output must say it cannot certify');

  const runId = fs.readdirSync(path.join(dir, '.release-harness', 'runs'))[0];
  const v = readJson(dir, `.release-harness/runs/${runId}/verdict.json`);

  // Every assertion passed, and the result is still not a PASS. That is the
  // whole point: nothing was accepted, so nothing can have been certified.
  assert.strictEqual(v.summary.failed, 0, 'the assertion actually passed');
  assert.strictEqual(v.status, 'UNPROVEN', 'yet the verdict is UNPROVEN, never PASS');
  assert.strictEqual(v.certifying, false, 'and the verdict says it was not certifying');
  assert.strictEqual(v.contract_digest, null, 'citing no contract, because there is none');
  assert.strictEqual(explore.code, 2, 'exit 2: nothing was proven');

  const manifest = readJson(dir, `.release-harness/runs/${runId}/manifest.json`);
  assert.strictEqual(manifest.contract, null, 'the manifest cites no contract');
  assert.strictEqual(manifest.certification.eligible, false, 'and is ineligible on its face');

  fs.rmSync(dir, { recursive: true, force: true });
  pass('C4', 'an exploratory run executes, passes, and still certifies nothing');
}

// ---------------------------------------------------------------------------
// C5  Eligibility precedes every side effect.
//
// Proven by observation, not by reading control flow: a refused run must leave
// no run directory, no evidence, and no trace of a probe having fired.
// ---------------------------------------------------------------------------
{
  const dir = tmpProject('cli-gate-');
  rh(dir, ['init'], { expectOk: true });
  authorGreeterDraft(dir);
  rh(dir, ['accept', '--draft', 'greeter', '--by', 'a.operator'], { expectOk: true });

  const runsDir = path.join(dir, '.release-harness', 'runs');
  const runsBefore = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).length : 0;

  // A binding that resolves nothing the contract names.
  rh(dir, ['bind', 'wrong', '--target', 'web=http://127.0.0.1:9'], { expectOk: true });
  const refused = rh(dir, ['run', '--binding', 'wrong']);

  assert.notStrictEqual(refused.code, 0, 'the run must be refused');
  assert.match(refused.all, /was not started/i, 'and must say it never started');
  assert.match(refused.all, /BINDINGS_UNRESOLVED/, 'naming the reason');

  const runsAfter = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).length : 0;
  assert.strictEqual(runsAfter, runsBefore, 'no run directory may be created');

  // And with nothing accepted at all.
  const dir2 = tmpProject('cli-gate2-');
  rh(dir2, ['init'], { expectOk: true });
  rh(dir2, ['bind', 'local', '--target', 'cli=node greet.js'], { expectOk: true });
  const noContract = rh(dir2, ['run', '--binding', 'local']);
  assert.notStrictEqual(noContract.code, 0, 'a run with no contract must be refused');
  assert.ok(
    !fs.existsSync(path.join(dir2, '.release-harness', 'runs')) ||
      fs.readdirSync(path.join(dir2, '.release-harness', 'runs')).length === 0,
    'and must create nothing'
  );

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
  pass('C5', 'a refused run creates no directory, no evidence and no probe');
}

// ---------------------------------------------------------------------------
// C6  One contract, two bindings, one identity.
// ---------------------------------------------------------------------------
{
  const dir = tmpProject('cli-bind-');
  rh(dir, ['init'], { expectOk: true });
  authorGreeterDraft(dir);
  rh(dir, ['accept', '--draft', 'greeter', '--by', 'a.operator'], { expectOk: true });

  rh(dir, ['bind', 'one', '--target', 'cli=node greet.js'], { expectOk: true });
  rh(dir, ['bind', 'two', '--target', 'cli=node greet.js there'], { expectOk: true });

  rh(dir, ['run', '--binding', 'one'], { expectOk: true });
  rh(dir, ['run', '--binding', 'two'], { expectOk: true });

  const runs = fs.readdirSync(path.join(dir, '.release-harness', 'runs')).sort();
  assert.strictEqual(runs.length, 2, 'two runs happened');

  const [m1, m2] = runs.map((r) => readJson(dir, `.release-harness/runs/${r}/manifest.json`));

  assert.strictEqual(
    m1.contract.digest,
    m2.contract.digest,
    'one proposition exercised twice keeps one contract identity'
  );
  assert.notStrictEqual(m1.bindings.digest, m2.bindings.digest, 'while the bindings differ');
  assert.notStrictEqual(m1.run_id, m2.run_id, 'and each run has its own identity');

  fs.rmSync(dir, { recursive: true, force: true });
  pass('C6', 'the same contract binds to two environments without its identity moving');
}

// ---------------------------------------------------------------------------
// C7  A normative reference participates in identity.
// ---------------------------------------------------------------------------
{
  const dir = tmpProject('cli-normative-');
  rh(dir, ['init'], { expectOk: true });
  authorGreeterDraft(dir);

  const accepted = rh(dir, ['accept', '--draft', 'greeter', '--by', 'a.operator'], { expectOk: true });
  const first = accepted.all.match(/Accepted ([0-9a-f]{16})/)[1];

  // Add a normative reference: something whose change would alter what these
  // assertions MEAN. Unlike a binding, it belongs to the proposition.
  const draft = readJson(dir, `${DRAFT}/greeter.draft.json`);
  draft.proposition.requires = [{ ref: 'greeting-format', digest: 'a'.repeat(64) }];
  writeJson(dir, `${DRAFT}/greeter.draft.json`, draft);

  const withRef = rh(dir, ['accept', '--draft', 'greeter', '--by', 'a.operator'], { expectOk: true });
  const second = withRef.all.match(/Accepted ([0-9a-f]{16})/)[1];
  assert.notStrictEqual(second, first, 'adding a normative reference changes the proposition');

  draft.proposition.requires = [{ ref: 'greeting-format', digest: 'b'.repeat(64) }];
  writeJson(dir, `${DRAFT}/greeter.draft.json`, draft);
  const moved = rh(dir, ['accept', '--draft', 'greeter', '--by', 'a.operator'], { expectOk: true });
  const third = moved.all.match(/Accepted ([0-9a-f]{16})/)[1];
  assert.notStrictEqual(third, second, 'changing which version is referenced changes it again');

  // Nothing was overwritten: three propositions, three files.
  assert.strictEqual(
    fs.readdirSync(path.join(dir, '.release-harness', 'accepted')).filter((f) =>
      f.endsWith('.contract.json')
    ).length,
    3,
    'each accepted proposition is kept; none is silently replaced'
  );

  fs.rmSync(dir, { recursive: true, force: true });
  pass('C7', 'normative references change proposition identity, and none is overwritten');
}

// ---------------------------------------------------------------------------
// C8  Tampering is detected at every link.
// ---------------------------------------------------------------------------
{
  const base = tmpProject('cli-tamper-');
  rh(base, ['init'], { expectOk: true });
  authorGreeterDraft(base);
  rh(base, ['accept', '--draft', 'greeter', '--by', 'a.operator'], { expectOk: true });
  rh(base, ['bind', 'local', '--target', 'cli=node greet.js'], { expectOk: true });
  rh(base, ['run', '--binding', 'local'], { expectOk: true });
  rh(base, ['verify'], { expectOk: true });

  const runId = fs.readdirSync(path.join(base, '.release-harness', 'runs'))[0];

  // Each mutation is applied to a pristine copy, so they are tested
  // independently rather than compounding into one unreadable failure.
  const mutations = {
    verdict: (dir) => {
      // The baseline run passed, so flipping `status` to PASS would be a
      // no-op that proves nothing. Change something that actually differs --
      // this is the forgery an attacker would attempt on a FAILING run, and
      // the assertion list is what a reader would be deceived by.
      const v = readJson(dir, `.release-harness/runs/${runId}/verdict.json`);
      v.assertions.push({ id: 'A2', status: 'PASS', observed: 'never happened' });
      v.summary.total = 2;
      v.summary.passed = 2;
      writeJson(dir, `.release-harness/runs/${runId}/verdict.json`, v);
    },
    evidence: (dir) => {
      fs.writeFileSync(
        path.join(dir, '.release-harness', 'runs', runId, 'evidence', 'probes', 'A1.json'),
        JSON.stringify({ assertion: 'A1', passed: true, faked: true }) + '\n'
      );
    },
    contract: (dir) => {
      const f = fs
        .readdirSync(path.join(dir, '.release-harness', 'accepted'))
        .find((x) => x.endsWith('.contract.json'));
      const c = readJson(dir, `.release-harness/accepted/${f}`);
      c.assertions[0].expect.exit_code = 99;
      writeJson(dir, `.release-harness/accepted/${f}`, c);
    },
    manifest: (dir) => {
      const m = readJson(dir, `.release-harness/runs/${runId}/manifest.json`);
      m.verdict.digest = 'f'.repeat(64);
      writeJson(dir, `.release-harness/runs/${runId}/manifest.json`, m);
    },
  };

  for (const [link, mutate] of Object.entries(mutations)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cli-tamper-${link}-`));
    fs.cpSync(base, dir, { recursive: true });

    assert.strictEqual(
      rh(dir, ['verify', runId]).code,
      0,
      `${link}: the untouched copy must verify first, or this proves nothing`
    );

    mutate(dir);

    const after = rh(dir, ['verify', runId]);
    assert.notStrictEqual(after.code, 0, `${link}: tampering must be detected`);
    assert.match(after.all, /BROKEN/, `${link}: and reported as broken`);

    fs.rmSync(dir, { recursive: true, force: true });
  }

  fs.rmSync(base, { recursive: true, force: true });
  pass('C8', 'tampering with contract, verdict, evidence or manifest is detected');
}

// ---------------------------------------------------------------------------
// C9  Fixture A, through the executable.
//
// This is the test that graduates the fixture from "model fixed" to "product
// fixed". The CLI is given every opportunity to recreate the original defect
// and must fail to.
// ---------------------------------------------------------------------------
{
  // The original ran in a directory whose name became the product slug, in a
  // repository serving nothing. Reproduce that shape exactly.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-harness-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"release-harness"}\n');

  rh(dir, ['init'], { expectOk: true });

  // 1. No product identity was invented from the folder name.
  const root = path.join(dir, '.release-harness');
  const runtime = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'examples') walk(full);
      } else runtime.push(full);
    }
  })(root);
  const blob = runtime.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  assert.ok(!/release-harness["']?\s*:/.test(blob), 'no slug derived from the directory');
  assert.ok(!/3000/.test(blob), 'no invented port');
  assert.ok(!/browser|chromium|playwright/i.test(blob), 'no invented browser app');
  assert.ok(!/Welcome/i.test(blob), 'no invented smoke assertion');

  // 2. doctor must not report readiness.
  const doctor = rh(dir, ['doctor']);
  assert.ok(!/\bReady\b/.test(doctor.all), '"Ready" must never be printed');
  assert.match(doctor.all, /certified right now\?\s*No/i, 'doctor must answer No');

  // 3. The decisive one. Even if someone hand-writes the exact fabricated
  //    proposition, probing a port nothing listens on must not accuse the
  //    product -- there is nothing there to have broken a promise.
  rh(dir, ['draft', 'new', 'fabricated'], { expectOk: true });
  const draft = readJson(dir, `${DRAFT}/fabricated.draft.json`);
  draft.proposition.subject = { id: 'release-harness' };
  draft.proposition.assertions = [
    {
      id: 'A1',
      kind: 'http',
      target: 'web',
      expect: { method: 'GET', path: '/', status: 200 },
      supported_by: ['guess'],
    },
  ];
  draft.questions = [];
  writeJson(dir, `${DRAFT}/fabricated.draft.json`, draft);

  const record = readJson(dir, `${DRAFT}/fabricated.record.json`);
  record.claims = [
    {
      id: 'guess',
      claim: 'this project serves a browser app on port 3000',
      status: 'inferred',
      evidence: { source: 'scaffold default' },
    },
  ];
  writeJson(dir, `${DRAFT}/fabricated.record.json`, record);

  // An inference cannot support an accepted assertion, so this is refused
  // before anything is ever probed.
  const accept = rh(dir, ['accept', '--draft', 'fabricated', '--by', 'a.operator']);
  assert.notStrictEqual(accept.code, 0, 'a proposition resting on a guess must not be accepted');
  assert.match(accept.all, /unsupported_claim/, 'because the claim is an inference');

  // Force it through anyway, exploratorily: the run happens, the port answers
  // nothing, and the result must still not be a product bug.
  rh(dir, ['bind', 'invented', '--target', 'web=http://127.0.0.1:3000'], { expectOk: true });
  const explore = rh(dir, ['run', '--draft', 'fabricated', '--exploratory', '--binding', 'invented']);

  const runId = fs.readdirSync(path.join(root, 'runs'))[0];
  const verdict = readJson(dir, `.release-harness/runs/${runId}/verdict.json`);

  // The assertion failed, and saying so is the point of exploratory mode --
  // an author needs to know their proposition did not hold. What must never
  // happen is that failure being dressed up as a finding about the product.
  assert.strictEqual(verdict.certifying, false, 'the run certifies nothing');
  assert.strictEqual(verdict.contract_digest, null, 'citing no contract, because none exists');
  for (const a of verdict.assertions) {
    // The one thing that must not happen. An authoritative BINDING_INVALID is
    // fine and useful -- "nothing is listening on 3000" is a fact about the
    // operator's own configuration, and an author drafting needs to hear it.
    // What may never be claimed is that the SUBJECT broke a promise, because
    // no promise was ever accepted.
    assert.notStrictEqual(a.cause, 'PRODUCT', 'no assertion may be blamed on the product');
  }
  assert.ok(!/PRODUCT_BUG/.test(explore.all), 'the words PRODUCT_BUG must not appear');
  assert.strictEqual(explore.code, 2, 'exit 2: nothing was proven');

  fs.rmSync(dir, { recursive: true, force: true });
  pass('C9', 'the CLI cannot recreate the self-adoption defect');
}

// ---------------------------------------------------------------------------
// C10  Attribution is honest about who failed.
//
// Found by running the CLI by hand: `node /missing.js` exits 1, which the first
// adapter read as a violated assertion. The subject never ran. A non-zero exit
// is ambiguous and must not resolve toward blaming the product.
// ---------------------------------------------------------------------------
{
  const dir = tmpProject('cli-attrib-');
  rh(dir, ['init'], { expectOk: true });
  authorGreeterDraft(dir);
  rh(dir, ['accept', '--draft', 'greeter', '--by', 'a.operator'], { expectOk: true });

  // The subject runs and genuinely breaks its promise.
  rh(dir, ['bind', 'broken', '--target', 'cli=node greet.js fail'], { expectOk: true });
  const broken = rh(dir, ['run', '--binding', 'broken']);
  assert.strictEqual(broken.code, 1, 'a real violation exits 1');
  assert.match(broken.all, /cause: PRODUCT/, 'and is attributed to the product');

  // The subject is never reached. Same non-zero exit, entirely different fact.
  rh(dir, ['bind', 'missing', '--target', 'cli=node /no/such/file.js'], { expectOk: true });
  const missing = rh(dir, ['run', '--binding', 'missing']);
  assert.match(missing.all, /BINDING_INVALID/, 'an unreachable subject is a binding fault');
  assert.ok(!/cause: PRODUCT\b/.test(missing.all), 'and must never be called a product bug');
  assert.strictEqual(missing.code, 3, 'exiting 3: your configuration, not your software');

  fs.rmSync(dir, { recursive: true, force: true });
  pass('C10', 'a subject that never ran is never blamed for failing');
}

// ---------------------------------------------------------------------------
// C11  The exit-code contract.
// ---------------------------------------------------------------------------
{
  const dir = tmpProject('cli-exit-');

  assert.strictEqual(rh(dir, ['doctor']).code, 3, '3: not installed is a usage problem');
  rh(dir, ['init'], { expectOk: true });
  assert.strictEqual(rh(dir, ['doctor']).code, 2, '2: installed, nothing proven');
  assert.strictEqual(rh(dir, ['nonsense']).code, 3, '3: unknown command');
  assert.strictEqual(rh(dir, ['help']).code, 0, '0: help succeeds');

  authorGreeterDraft(dir);
  rh(dir, ['accept', '--draft', 'greeter', '--by', 'a.operator'], { expectOk: true });
  rh(dir, ['bind', 'local', '--target', 'cli=node greet.js'], { expectOk: true });
  assert.strictEqual(rh(dir, ['run', '--binding', 'local']).code, 0, '0: a certifying pass');
  assert.strictEqual(rh(dir, ['doctor']).code, 0, '0: something can be certified');

  fs.rmSync(dir, { recursive: true, force: true });
  pass('C11', 'exit codes distinguish ok, product failure, unproven and usage');
}

console.log(`\n  ${results.length} CLI checks passed\n`);
