// D42 -- executable paths are structured data, not shell command lines.
//
// The process adapter already launches with `spawn(executable, argv, {
// shell:false })`, but its parser destroyed that boundary before launch: it
// treated every backslash as shell syntax and split the whole binding on
// whitespace. On Windows that either refused every absolute path or turned
// `C:\Windows\System32\cmd.exe` into something else before spawn.
//
// These are execution tests, not parser snapshots. A parser can preserve a
// string in isolation and still hand a different value to the OS. The returned
// evidence therefore names both what was requested and what was passed to
// spawn, and the real Windows case proves the child was reached.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeAssertion } from '../src/execute.js';

const results = [];
function pass(id, name) {
  results.push(id);
  console.log(`  ok  [${id}] ${name}`);
}

const runCli = (location, expect, cwd = process.cwd()) =>
  executeAssertion(
    { id: 'A1', kind: 'cli', target: 'tool', expect },
    { tool: location },
    { timeoutMs: 10000, cwd }
  );

console.log('\nD42 -- direct executable bindings\n');

// ---------------------------------------------------------------------------
// D42-1  A real Windows absolute executable reaches the subject unchanged.
// ---------------------------------------------------------------------------
if (process.platform === 'win32') {
  const requested = String.raw`C:\Windows\System32\cmd.exe`;
  assert.ok(fs.existsSync(requested), `test host must provide ${requested}`);

  const r = await runCli(requested, {
    // The assertion vocabulary deliberately defines args as a string. D42 does
    // not redesign it; it proves the existing tokens survive direct launch.
    args: '/d /s /c exit 7',
    exit_code: 7,
  });

  assert.strictEqual(r.passed, true, r.observed);
  assert.strictEqual(r.cause, 'NONE');
  assert.strictEqual(r.detail.subject_reached, true);
  assert.strictEqual(r.detail.executable_requested, requested);
  assert.strictEqual(
    r.detail.executable_spawned,
    requested,
    'the executable passed to spawn must be byte/string-equivalent to what the binding requested'
  );
  assert.deepStrictEqual(
    r.detail.argv,
    ['/d', '/s', '/c', 'exit', '7'],
    'the existing string args model must preserve its tokens without a shell intermediary'
  );
  assert.strictEqual(r.detail.shell, false, 'normal bindings must never invoke a shell');

  pass('D42-1', 'a real Windows absolute executable reaches the subject unchanged');
} else {
  console.log('  skip [D42-1] real Windows executable (non-Windows host)');
}

// ---------------------------------------------------------------------------
// D42-2  Spaces belong to the executable path, not to an implicit tokenizer.
//
// Copy the current Node executable into a path with spaces and run that copy.
// This catches both old failures: refusal because the path contains backslashes
// and splitting `Example Tool` into an executable plus an operand.
// ---------------------------------------------------------------------------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd42-space-'));
  const dir = path.join(root, 'Example Tool');
  fs.mkdirSync(dir);
  const requested = path.join(dir, process.platform === 'win32' ? 'tool.exe' : 'tool');
  fs.copyFileSync(process.execPath, requested);
  if (process.platform !== 'win32') fs.chmodSync(requested, 0o755);

  try {
    const r = await runCli(requested, { args: '--version', exit_code: 0, stdout_contains: 'v' });
    assert.strictEqual(r.passed, true, r.observed);
    assert.strictEqual(r.detail.executable_requested, requested);
    assert.strictEqual(r.detail.executable_spawned, requested);
    assert.deepStrictEqual(r.detail.argv, ['--version']);
    assert.strictEqual(r.detail.shell, false);
    pass('D42-2', 'a path containing spaces remains one executable identity');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// D42-2b  Parentheses and other legal path punctuation remain path data.
// ---------------------------------------------------------------------------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd42-punct-'));
  const dir = path.join(root, 'Example (x64)');
  fs.mkdirSync(dir);
  const requested = path.join(dir, process.platform === 'win32' ? 'tool.exe' : 'tool');
  fs.copyFileSync(process.execPath, requested);
  if (process.platform !== 'win32') fs.chmodSync(requested, 0o755);

  try {
    const r = await runCli(requested, { args: '--version', exit_code: 0, stdout_contains: 'v' });
    assert.strictEqual(r.passed, true, r.observed);
    assert.strictEqual(r.detail.executable_spawned, requested);
    pass('D42-2b', 'legal path punctuation is data, not shell syntax');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// D42-3  A nonexistent Windows path is a structural binding failure.
// ---------------------------------------------------------------------------
if (process.platform === 'win32') {
  const requested = String.raw`C:\Definitely-Not-Release-Harness\Example Tool\missing.exe`;
  const r = await runCli(requested, { exit_code: 0 });

  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.cause, 'BINDING_INVALID');
  assert.strictEqual(r.detail.subject_reached, false);
  assert.match(r.observed, /could not be found/i);
  assert.ok(
    r.observed.includes(requested),
    `the untouched requested path must appear in diagnostics: ${r.observed}`
  );
  assert.ok(!r.observed.includes('C:Definitely'), 'path separators must never disappear in diagnostics');

  pass('D42-3', 'a missing Windows executable is a binding fault, never PRODUCT');
}

// ---------------------------------------------------------------------------
// D42-4  Existing portable forms stay working.
// ---------------------------------------------------------------------------
{
  const byPath = await runCli(process.execPath, { args: '--version', exit_code: 0, stdout_contains: 'v' });
  assert.strictEqual(byPath.passed, true, byPath.observed);
  assert.strictEqual(byPath.detail.executable_spawned, process.execPath);

  const byName = await runCli('node', { args: '--version', exit_code: 0, stdout_contains: 'v' });
  assert.strictEqual(byName.passed, true, byName.observed);
  assert.strictEqual(byName.detail.executable_spawned, 'node');

  if (process.platform !== 'win32' && fs.existsSync('/usr/bin/node')) {
    const posix = await runCli('/usr/bin/node', { args: '--version', exit_code: 0 });
    assert.strictEqual(posix.passed, true, posix.observed);
    assert.strictEqual(posix.detail.executable_spawned, '/usr/bin/node');
  }

  pass('D42-4', 'absolute paths and PATH commands retain their existing behaviour');
}

// ---------------------------------------------------------------------------
// D42-5  Real shell syntax stays out of the direct-execution path.
//
// Punctuation legal in paths -- backslash, colon, spaces and parentheses -- is
// not shell syntax. Operators that ask a shell to compose programs are.
// ---------------------------------------------------------------------------
{
  for (const location of [
    'foo && bar',
    'foo | bar',
    'foo > file',
    '$(command)',
    '`command`',
  ]) {
    const r = await runCli(location, { exit_code: 0 });
    assert.strictEqual(r.passed, false, `${location} must be refused`);
    assert.strictEqual(r.cause, 'UNKNOWN', `${location} cannot be attributed`);
    assert.strictEqual(r.detail.subject_reached, 'not_established');
    assert.match(r.observed, /was not executed/);
  }

  pass('D42-5', 'shell composition is refused without banning ordinary path punctuation');
}

console.log(`\n  ${results.length} D42 checks passed\n`);
