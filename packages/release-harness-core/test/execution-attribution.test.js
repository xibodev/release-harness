// Execution attribution: structural, never textual.
//
// These are the adversarial tests for the rule that a regex over stderr must
// never decide whether software deserves to be accused. The two that matter
// most are E-6 and E-7: a real subject that runs, fails its assertion, and
// happens to print "Cannot find module" or "Permission denied" must still be
// attributed to the product. Under the previous heuristic those were silently
// demoted to configuration problems -- a real finding lost to a string match.
//
// The inverse cases matter too, and are the reason the heuristic existed: a
// binding naming a script that does not exist must never be a product bug. The
// difference is now established before launch, from the filesystem, rather than
// afterwards from whatever the process printed.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeAssertion } from '../src/execute.js';
import { CAUSE } from '../src/attribution.js';

const results = [];
function pass(id, name) {
  results.push(id);
  console.log(`  ok  [${id}] ${name}`);
}

console.log('\nExecution attribution: structural, not textual\n');

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-attr-'));

/** Write a real script and return the command that runs it. */
function script(name, body) {
  const file = path.join(workspace, name);
  fs.writeFileSync(file, body);
  return `node ${name}`;
}

const assertion = (expect = { exit_code: 0 }) => ({ id: 'A1', kind: 'cli', target: 'cli', expect });

const run = (location, expect) =>
  executeAssertion(assertion(expect), { cli: location }, { cwd: workspace, timeoutMs: 10000 });

// ---------------------------------------------------------------------------
// E-1  A missing executable is a binding fault, established before launch.
// ---------------------------------------------------------------------------
{
  const r = await run('definitely-not-a-real-program-xyz --version');

  assert.strictEqual(r.cause, CAUSE.BINDING_INVALID, 'an unresolvable executable is a binding fault');
  assert.match(r.observed, /could not be found/i, 'and says so plainly');
  assert.strictEqual(r.detail.subject_reached, false, 'recording that the subject was never reached');

  pass('E-1', 'a missing executable is caught structurally, before anything runs');
}

// ---------------------------------------------------------------------------
// E-2  A missing declared script is a binding fault.
//
// This is the original defect: `node /missing.js` exits 1 like any failing
// program. The filesystem settles it before the process starts.
// ---------------------------------------------------------------------------
{
  const r = await run('node ./does-not-exist.js');

  assert.strictEqual(r.cause, CAUSE.BINDING_INVALID, 'a named file that is absent is a binding fault');
  assert.match(r.observed, /does not exist/i, 'naming what is missing');
  assert.notStrictEqual(r.cause, CAUSE.PRODUCT, 'and is never a product bug');
  assert.strictEqual(r.detail.subject_reached, false, 'the subject was not reached');

  pass('E-2', 'a declared script that does not exist is never a product bug');
}

// ---------------------------------------------------------------------------
// E-3  An invalid working directory is a binding fault.
// ---------------------------------------------------------------------------
{
  const r = await executeAssertion(
    assertion(),
    { cli: 'node --version' },
    { cwd: path.join(workspace, 'no', 'such', 'dir'), timeoutMs: 5000 }
  );

  assert.strictEqual(r.cause, CAUSE.BINDING_INVALID, 'a nonexistent cwd is a binding fault');
  assert.match(r.observed, /working directory/i, 'and is described as such');

  pass('E-3', 'a working directory that does not exist is a binding fault');
}

// ---------------------------------------------------------------------------
// E-4  A spawn ENOENT is classified from the errno, not from any text.
// ---------------------------------------------------------------------------
{
  // Bypass preflight by asking the module what it does with a raw spawn error,
  // through a binding whose executable vanishes between check and launch. The
  // reliable way to reach this branch is a directory: it exists (so preflight
  // passes) but cannot be executed.
  const dir = path.join(workspace, 'a-directory');
  fs.mkdirSync(dir, { recursive: true });

  const r = await run(`${path.join('.', 'a-directory')}`);

  // Whatever the platform reports, it must never be PRODUCT: nothing the
  // subject did is in evidence here.
  assert.notStrictEqual(r.cause, CAUSE.PRODUCT, 'a failure to start is never a product bug');
  assert.ok(
    [CAUSE.BINDING_INVALID, CAUSE.HARNESS_ENVIRONMENT, CAUSE.UNKNOWN].includes(r.cause),
    `a spawn failure must be a binding, environment or unknown cause (got ${r.cause})`
  );

  pass('E-4', 'a spawn failure is classified from its errno, never from output');
}

// ---------------------------------------------------------------------------
// E-5  A non-executable file is refused without accusing the subject.
// ---------------------------------------------------------------------------
{
  const data = path.join(workspace, 'not-a-program.dat');
  fs.writeFileSync(data, 'this is data, not a program\n');

  const r = await run(`${path.join('.', 'not-a-program.dat')}`);

  assert.notStrictEqual(r.cause, CAUSE.PRODUCT, 'an unrunnable file is not a product bug');
  assert.ok(
    [CAUSE.BINDING_INVALID, CAUSE.HARNESS_ENVIRONMENT, CAUSE.UNKNOWN].includes(r.cause),
    `must be attributed away from the product (got ${r.cause})`
  );

  pass('E-5', 'a file that cannot be executed is not blamed on the subject');
}

// ---------------------------------------------------------------------------
// E-6  THE DECISIVE ONE. A real subject printing "Cannot find module" and
//      failing its assertion is a PRODUCT finding.
//
// The previous heuristic matched this text and demoted it to a configuration
// problem, losing a real finding to a string match. The subject ran. Its own
// output is not evidence about who is responsible.
// ---------------------------------------------------------------------------
{
  const location = script(
    'prints-module-error.js',
    [
      "console.error('Error: Cannot find module \\'./config\\'');",
      "console.error('MODULE_NOT_FOUND');",
      'process.exit(1);',
      '',
    ].join('\n')
  );

  const r = await run(location);

  assert.strictEqual(
    r.cause,
    CAUSE.PRODUCT,
    'a subject that ran and failed is a product finding, whatever it printed'
  );
  assert.strictEqual(r.detail.subject_reached, true, 'because the subject was demonstrably reached');
  assert.match(r.detail.stderr, /Cannot find module/, 'the misleading text is recorded as evidence');
  assert.match(r.observed, /exit 1, expected 0/, 'and the observation is about the exit code');

  pass('E-6', 'a subject printing "Cannot find module" is still attributed to the product');
}

// ---------------------------------------------------------------------------
// E-7  The same for "Permission denied" and friends.
// ---------------------------------------------------------------------------
{
  for (const [name, text] of [
    ['permission', 'Permission denied'],
    ['enoent', "No such file or directory: '/tmp/whatever'"],
    ['notfound', 'bash: some-tool: command not found'],
    ['python', "ModuleNotFoundError: No module named 'requests'"],
  ]) {
    const location = script(
      `prints-${name}.js`,
      [`console.error(${JSON.stringify(text)});`, 'process.exit(3);', ''].join('\n')
    );

    const r = await run(location);
    assert.strictEqual(
      r.cause,
      CAUSE.PRODUCT,
      `a subject printing ${JSON.stringify(text)} must still be attributed to the product`
    );
  }

  pass('E-7', 'no infrastructure-looking phrase can launder a product failure');
}

// ---------------------------------------------------------------------------
// E-8  A wrapper whose child fails to launch cannot be attributed.
//
// The wrapper itself ran, so nothing structural establishes whether the
// intended subject did. Guessing either way would be dishonest.
// ---------------------------------------------------------------------------
{
  const location = script(
    'wrapper.js',
    [
      "const { spawnSync } = require('node:child_process');",
      "const r = spawnSync('definitely-not-real-xyz', [], { encoding: 'utf8' });",
      'process.exit(r.error ? 127 : r.status);',
      '',
    ].join('\n')
  );

  const r = await run(location);

  // The wrapper ran and exited non-zero of its own accord. Structurally this is
  // indistinguishable from the wrapper failing its own assertion, and that is
  // the honest position: it IS the subject we were pointed at.
  assert.strictEqual(r.detail.subject_reached, true, 'the wrapper itself was reached');
  assert.strictEqual(
    r.cause,
    CAUSE.PRODUCT,
    'the bound subject ran and exited non-zero; that is what was asserted about'
  );
  assert.strictEqual(r.detail.exit_code, 127, 'and the exit code is recorded for a reader');

  pass('E-8', "a wrapper's own failure is attributed to the wrapper, which is what was bound");
}

// ---------------------------------------------------------------------------
// E-9  A genuine assertion violation is a product finding.
// ---------------------------------------------------------------------------
{
  const location = script('exits-two.js', ['process.exit(2);', ''].join('\n'));

  const r = await run(location, { exit_code: 0 });
  assert.strictEqual(r.cause, CAUSE.PRODUCT, 'a real violation is a product finding');
  assert.strictEqual(r.passed, false, 'and does not pass');

  // And the converse: a subject that meets its assertion passes.
  const ok = await run(script('exits-zero.js', ["console.log('fine');", ''].join('\n')), {
    exit_code: 0,
    stdout_contains: 'fine',
  });
  assert.strictEqual(ok.passed, true, 'a subject meeting its assertion passes');
  assert.strictEqual(ok.cause, 'NONE', 'with no cause to report');

  pass('E-9', 'a genuine violation is attributed to the product, and a pass is a pass');
}

// ---------------------------------------------------------------------------
// E-10  A binding that cannot be decomposed yields UNKNOWN, never PRODUCT.
//
// Shell syntax means any stage could have failed. Nothing structural can say
// which, so nothing is claimed -- the ambiguity is reported rather than
// resolved by guessing.
// ---------------------------------------------------------------------------
{
  const r = await run('node exits-zero.js | grep nothing-matches-this');

  assert.strictEqual(r.cause, CAUSE.UNKNOWN, 'an undecomposable binding cannot support an accusation');
  assert.notStrictEqual(r.cause, CAUSE.PRODUCT, 'and must never become one');
  assert.match(r.observed, /shell syntax/i, 'the reason must be legible to the operator');
  assert.strictEqual(
    r.detail.subject_reached ?? 'not_established',
    'not_established',
    'and it must be recorded as not established, not as false'
  );

  pass('E-10', 'an ambiguous binding yields UNKNOWN rather than a guess');
}

// ---------------------------------------------------------------------------
// E-11  The regex vocabulary is gone from the source.
//
// A heuristic that is merely unused is a heuristic waiting to be re-enabled, so
// its absence is asserted rather than assumed.
// ---------------------------------------------------------------------------
{
  const source = fs.readFileSync(
    new URL('../src/execute.js', import.meta.url),
    'utf8'
  );

  // Strip comments: the file explains why the heuristic was removed, and that
  // explanation must not itself trip the check.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

  assert.ok(!/looksLikeItNeverRan/.test(code), 'the heuristic function must be gone');
  for (const phrase of [/Cannot find module/, /MODULE_NOT_FOUND/, /command not found/, /ModuleNotFoundError/]) {
    assert.ok(!phrase.test(code), `${phrase} must not appear in executable code`);
  }

  // stderr may be RECORDED as evidence; it may never be tested to decide a cause.
  assert.ok(/stderr: stderr\.slice/.test(code), 'stderr is still captured as evidence');

  // C4 draws a line this check previously did not need. There are two entirely
  // different acts that both touch stderr:
  //
  //   ATTRIBUTION  the harness reads stderr and decides whose fault a failure
  //                was. Banned, permanently. That was a regex deciding whether
  //                software deserved a PRODUCT accusation.
  //
  //   ASSERTION    an author writes `stderr_contains` and the executor checks
  //                it. The expectation came from a person who chose it; the
  //                harness is comparing against a stated promise, not guessing
  //                a cause from output it did not expect.
  //
  // So the ban is now expressed precisely: stderr may be compared ONLY against
  // a value the author supplied, and the cause must never be derived from it.
  const stderrReads = code.match(/stderr\.(includes|match|test)\([^)]*\)/g) ?? [];
  for (const read of stderrReads) {
    assert.ok(
      /errContains/.test(read),
      `stderr may only be compared against an author-supplied expectation; found: ${read}`
    );
  }
  assert.ok(!/\.test\(stderr\)/.test(code), 'no regex may be run over stderr');

  // And the cause must not be chosen by looking at stderr: every branch that
  // yields a cause reads exit codes, errnos or preflight facts.
  assert.ok(
    !/cause[^\n]*stderr|stderr[^\n]*CAUSE\./.test(code),
    'no cause may be derived from stderr'
  );

  pass('E-11', 'stderr is asserted only against an author expectation, never used to attribute');
}

fs.rmSync(workspace, { recursive: true, force: true });

console.log(`\n  ${results.length} execution-attribution checks passed\n`);
