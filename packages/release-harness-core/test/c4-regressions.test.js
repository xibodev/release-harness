// C4 regressions: the defects the real transfer test found, and the ones the
// synthetic runs found, asserted as behaviour rather than as intentions.
//
// Each block names the defect it closes. A fix without a test here is a fix
// that will be undone by the next person who does not know why it was made.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { canonicalText, canonicalTextDigest, sameCanonicalText } from '../src/canonical-text.js';
import { executeAssertion } from '../src/execute.js';
import { describeAssertionKinds } from '../src/contract.js';

const results = [];
function pass(id, name) {
  results.push(id);
  console.log(`  ok  [${id}] ${name}`);
}

console.log('\nC4 regressions\n');

// ---------------------------------------------------------------------------
// D32  Text identity is line-ending independent -- but not whitespace-blind.
//
// A CRLF checkout produced an apparent tampering event on an identical
// protocol. The danger is over-correcting: an integrity check that normalises
// everything stops detecting real edits.
// ---------------------------------------------------------------------------
{
  const lf = 'line one\nline two\n';
  const crlf = 'line one\r\nline two\r\n';
  const cr = 'line one\rline two\r';
  const noTrailing = 'line one\nline two';
  const doubleTrailing = 'line one\nline two\n\n\n';
  const bom = '﻿line one\nline two\n';

  const base = canonicalTextDigest(lf);
  for (const [name, variant] of [
    ['CRLF', crlf],
    ['lone CR', cr],
    ['no trailing newline', noTrailing],
    ['extra trailing newlines', doubleTrailing],
    ['BOM', bom],
  ]) {
    assert.strictEqual(canonicalTextDigest(variant), base, `${name} must not change identity`);
  }

  // The other half: real changes must still be visible, including whitespace
  // changes that are not line endings.
  for (const [name, changed] of [
    ['a word', 'line one\nline TWO\n'],
    ['indentation', '  line one\nline two\n'],
    ['an internal blank line', 'line one\n\nline two\n'],
    ['trailing space on a line', 'line one \nline two\n'],
  ]) {
    assert.notStrictEqual(
      canonicalTextDigest(changed),
      base,
      `${name} is a real change and must change identity`
    );
  }

  assert.ok(sameCanonicalText(lf, crlf), 'sameCanonicalText compares logical identity');
  assert.strictEqual(canonicalText(crlf), lf, 'canonical form is LF with one terminator');

  pass('D32', 'text identity ignores line endings and a BOM, and nothing else');
}

// ---------------------------------------------------------------------------
// D32b  The shipped protocol and the installed copy have one identity.
// ---------------------------------------------------------------------------
{
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const canonical = fs.readFileSync(path.join(REPO, 'protocol', 'ADOPTION.md'));
  const asWindowsWouldWriteIt = Buffer.from(canonical.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');

  assert.ok(
    sameCanonicalText(canonical, asWindowsWouldWriteIt),
    'a CRLF-installed protocol must not read as tampered'
  );
  assert.notStrictEqual(
    canonicalTextDigest(canonical),
    canonicalTextDigest(canonical.toString('utf8') + 'an added sentence.\n'),
    'but an actual edit must still be detected'
  );

  pass('D32b', 'a CRLF install is not tampering; an edit still is');
}

// ---------------------------------------------------------------------------
// D40  stderr_contains -- asserting a CLI's failure REASON.
//
// The four cases that matter, including the one that proves the streams are
// not merged.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-stderr-'));
  const script = path.join(dir, 'refuse.js');
  fs.writeFileSync(
    script,
    [
      "process.stdout.write('STDOUT-MARKER: work attempted\\n');",
      "process.stderr.write('refusing: image is not pinned by digest\\n');",
      'process.exit(1);',
    ].join('\n')
  );

  // POSIX separators: a Windows backslash path is refused as shell syntax
  // (D42, recorded separately). Node accepts forward slashes on Windows.
  const posix = (p) => p.split(path.sep).join('/');
  const binding = { t: `${posix(process.execPath)} ${posix(script)}` };
  const run = (expect) =>
    executeAssertion({ id: 'A', kind: 'cli', target: 't', expect }, binding, { timeoutMs: 10000 });

  const right = await run({ exit_code: 1, stderr_contains: 'not pinned by digest' });
  assert.strictEqual(right.passed, true, 'the expected reason on stderr must PASS');

  const wrongReason = await run({ exit_code: 1, stderr_contains: 'disk full' });
  assert.strictEqual(wrongReason.passed, false, 'a different reason must FAIL');
  assert.match(wrongReason.observed, /stderr did not contain/, 'and must say stderr was the miss');

  // The case the defect was really about: right exit code, wrong reason. An
  // exit-code-only assertion cannot tell these apart, which is why any
  // unrelated crash exiting 1 used to satisfy "it refused for reason X".
  const rightCodeWrongReason = await run({ exit_code: 1, stderr_contains: 'permission denied' });
  assert.strictEqual(rightCodeWrongReason.passed, false, 'correct exit + wrong reason must FAIL');

  // Streams stay separate in both directions.
  const crossed = await run({ exit_code: 1, stderr_contains: 'STDOUT-MARKER' });
  assert.strictEqual(crossed.passed, false, 'stderr_contains must not see stdout');
  const crossedBack = await run({ exit_code: 1, stdout_contains: 'refusing: image' });
  assert.strictEqual(crossedBack.passed, false, 'stdout_contains must not see stderr');

  // Both streams are still preserved as evidence regardless.
  assert.match(right.detail.stdout, /STDOUT-MARKER/, 'stdout is kept as evidence');
  assert.match(right.detail.stderr, /refusing/, 'stderr is kept as evidence');

  fs.rmSync(dir, { recursive: true, force: true });
  pass('D40', 'stderr_contains proves the reason, and the streams never bleed');
}

// ---------------------------------------------------------------------------
// D39  body_contains -- proving the deployed thing is the thing that shipped.
//
// The real transfer test found this was the highest-value proposition
// available anywhere in the estate and that it could not be written.
// ---------------------------------------------------------------------------
{
  const revision = 'c9cbff1916c297e2ce24c4a409abba7c44c057c8';
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', revision, image_digest: 'unknown' }));
      return;
    }
    res.writeHead(404);
    res.end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const binding = { t: `http://127.0.0.1:${port}` };
  const run = (expect) =>
    executeAssertion({ id: 'A', kind: 'http', target: 't', expect }, binding, { timeoutMs: 5000 });

  const shipped = await run({ path: '/health', status: 200, body_contains: revision });
  assert.strictEqual(shipped.passed, true, 'the deployed revision must PASS');

  const wrongRevision = await run({
    path: '/health',
    status: 200,
    body_contains: 'a'.repeat(40),
  });
  assert.strictEqual(wrongRevision.passed, false, 'a different revision must FAIL');
  assert.match(wrongRevision.observed, /body did not contain/, 'and must say the body was the miss');
  assert.strictEqual(wrongRevision.cause, 'PRODUCT', 'a reached subject serving the wrong thing is the product');

  // Liveness alone is exactly what the critique called vacuous: this passes
  // whether or not the right revision is deployed.
  const livenessOnly = await run({ path: '/health', status: 200 });
  assert.strictEqual(livenessOnly.passed, true, 'status-only assertions are unchanged by this feature');

  // Nothing answering is still a binding fault, not a product accusation.
  await new Promise((r) => server.close(r));
  const dead = await run({ path: '/health', status: 200, body_contains: revision });
  assert.strictEqual(dead.passed, false, 'a dead endpoint fails');
  assert.strictEqual(dead.cause, 'BINDING_INVALID', 'and is never blamed on the product');
  assert.strictEqual(dead.detail.subject_reached, false, 'the subject was not reached');

  pass('D39', 'body_contains proves deployed identity, and silence is still not an accusation');
}

// ---------------------------------------------------------------------------
// D26 / D36 / D41  The vocabulary carries types.
//
// Two independent agents read `args` as plural and wrote an array. The field
// list alone was not a vocabulary.
// ---------------------------------------------------------------------------
{
  const kinds = describeAssertionKinds();
  const byKind = Object.fromEntries(kinds.map((k) => [k.kind, k]));

  for (const k of kinds) {
    for (const field of k.expect) {
      assert.ok(field.type, `${k.kind}.${field.field} must publish a type`);
      assert.ok(field.description, `${k.kind}.${field.field} must publish a meaning`);
    }
  }

  const args = byKind.cli.expect.find((e) => e.field === 'args');
  assert.strictEqual(args.type, 'string', 'args is a string, and must say so -- this is the wrong guess');

  const exit = byKind.cli.expect.find((e) => e.field === 'exit_code');
  assert.match(exit.type, /integer/, 'exit_code publishes its range');

  const method = byKind.http.expect.find((e) => e.field === 'method');
  assert.match(method.type, /"GET"/, 'an enum publishes its permitted values');

  // The new primitives are discoverable by the same route, or they are as
  // undiscoverable as the fields that caused the defect.
  assert.ok(byKind.cli.expect.some((e) => e.field === 'stderr_contains'), 'stderr_contains is discoverable');
  assert.ok(byKind.http.expect.some((e) => e.field === 'body_contains'), 'body_contains is discoverable');

  pass('D26/D36/D41', 'every expect field publishes a type, a meaning, and is discoverable');
}

// ---------------------------------------------------------------------------
// D30 / D33  A scaffold may be incomplete. It may not invent intent.
// ---------------------------------------------------------------------------
{
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const BIN = path.join(HERE, '..', 'bin', 'release-harness.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-scaffold-'));
  const rh = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8' });

  rh('init');
  rh('draft', 'new', 'demo');

  const draft = JSON.parse(fs.readFileSync(path.join(dir, '.release-harness/drafts/demo.draft.json'), 'utf8'));
  const record = JSON.parse(fs.readFileSync(path.join(dir, '.release-harness/drafts/demo.record.json'), 'utf8'));

  assert.deepStrictEqual(draft.proposition.assertions, [], 'the scaffold asserts nothing');
  assert.deepStrictEqual(record.claims, [], 'and claims nothing');

  const v = rh('validate');
  const blockers = (v.stdout + v.stderr).split('\n').filter((l) => /^\s+\[/.test(l));

  // The point of the fix: no blocker may be about a field the tool invented.
  for (const b of blockers) {
    assert.ok(!/assertions\[0\]/.test(b), `no blocker may name a fabricated assertion: ${b.trim()}`);
    assert.ok(!/claims\[0\]/.test(b), `no blocker may name a fabricated claim: ${b.trim()}`);
  }

  // It is still blocked, and still for true reasons.
  assert.strictEqual(v.status, 2, 'an empty draft is not ready to accept');
  assert.ok(
    blockers.some((b) => /assertions/.test(b)),
    'asserting nothing is still a blocker -- a contract that promises nothing certifies nothing'
  );

  fs.rmSync(dir, { recursive: true, force: true });
  pass('D30/D33', 'the scaffold is honestly empty and blocks for real reasons only');
}

// ---------------------------------------------------------------------------
// D38  Refusing to accept must look like a decision, not a crash.
// ---------------------------------------------------------------------------
{
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const BIN = path.join(HERE, '..', 'bin', 'release-harness.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-accept-'));
  const rh = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: 'utf8' });

  rh('init');
  rh('draft', 'new', 'demo');
  const r = rh('accept', '--draft', 'demo', '--by', 'operator');
  const all = r.stdout + r.stderr;

  assert.match(all, /Acceptance refused/, 'the refusal names itself before listing anything');
  assert.ok(/\[incomplete\]|\[unresolved_question\]/.test(all), 'and shows the structured blockers');
  assert.notStrictEqual(r.status, 0, 'and does not exit 0');

  fs.rmSync(dir, { recursive: true, force: true });
  pass('D38', 'acceptance refusal is a stated decision with its reasons');
}

console.log(`\n  ${results.length} C4 regressions passed\n`);
