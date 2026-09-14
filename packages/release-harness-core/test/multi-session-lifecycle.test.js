// Three sessions, two checkouts, and conflict-induced stale review.
//
// This is the defining acceptance experiment for continuous lifecycle. It uses
// public CLI artifacts and real Git worktrees; no hidden memory crosses sessions.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'release-harness.js');

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}
function git(cwd, ...args) { return sh(cwd, 'git', args); }
function rh(cwd, ...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
function json(file) { return JSON.parse(fs.readFileSync(file)); }
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }

function authorContract(cwd) {
  assert.equal(rh(cwd, 'draft', 'new', 'tool').code, 0);
  const root = path.join(cwd, '.release-harness', 'drafts');
  const d = json(path.join(root, 'tool.draft.json'));
  d.proposition.subject = { id: 'tool', name: 'Tool' };
  d.proposition.assertions = [{ id: 'A1', kind: 'cli', target: 'tool', expect: { exit_code: 0, stdout_contains: 'hello' }, supported_by: ['C1'] }];
  d.questions = [];
  write(path.join(root, 'tool.draft.json'), d);
  const r = json(path.join(root, 'tool.record.json'));
  r.authored_by = 'session-a';
  r.claims = [{ id: 'C1', claim: 'tool.js prints hello', status: 'observed', evidence: { source: 'tool.js:1' } }];
  write(path.join(root, 'tool.record.json'), r);
  assert.equal(rh(cwd, 'accept', '--draft', 'tool', '--by', 'operator').code, 0);
  return fs.readdirSync(path.join(cwd, '.release-harness', 'accepted')).find((f) => f.endsWith('.contract.json')).split('.')[0];
}

function completeReview(cwd, name, action = 'reuse_contract') {
  const file = path.join(cwd, '.release-harness', 'reviews', `${name}.review.json`);
  const r = json(file);
  r.facts = [{ id: 'F1', claim: 'the changed implementation still prints hello in its committed test', status: 'observed', evidence: { source: 'test.js:1' } }];
  r.impact.assertions = r.impact.assertions.map((x) => ({ ...x, impact: action === 'reuse_contract' ? 'unchanged' : 'changed', supported_by: ['F1'] }));
  r.impact.requires = r.impact.requires.map((x) => ({ ...x, impact: 'unchanged', supported_by: ['F1'] }));
  r.conclusion = { action, summary: action === 'reuse_contract' ? 'The accepted proposition remains appropriate.' : 'The proposition must be reauthored.' };
  r.proposed = { by: 'session-b', at: '2026-01-01T00:00:00.000Z' };
  write(file, r);
}

console.log('\nThree-session lifecycle acceptance\n');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-three-session-'));
const origin = path.join(root, 'origin.git');
const a = path.join(root, 'session-a');
const b = path.join(root, 'session-b');
const c = path.join(root, 'session-c');

git(root, 'init', '--bare', origin);
git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
git(root, 'clone', origin, a);
git(a, 'config', 'user.name', 'Lifecycle Fixture');
git(a, 'config', 'user.email', 'fixture@example.invalid');
fs.writeFileSync(path.join(a, 'tool.js'), "console.log('hello');\n");
fs.writeFileSync(path.join(a, 'test.js'), "// asserts hello\n");
fs.writeFileSync(path.join(a, 'release.json'), '{"command":"node tool.js"}\n');
git(a, 'add', '.'); git(a, 'commit', '-m', 'initial'); git(a, 'branch', '-M', 'main'); git(a, 'push', '-u', 'origin', 'main');

// Session A -- capability activation, adoption, acceptance and baseline coverage.
assert.equal(rh(a, 'init', '--with-agent').code, 0);
git(a, 'add', 'AGENTS.md', '.agents', '.claude'); git(a, 'commit', '-m', 'install lifecycle');
const contractDigest = authorContract(a);
assert.equal(rh(a, 'review', 'start', 'baseline', '--contract', contractDigest).code, 0);
completeReview(a, 'baseline');
assert.equal(rh(a, 'review', 'confirm', 'baseline', '--by', 'operator').code, 0);
git(a, 'add', '-f', '.release-harness/config.json', '.release-harness/drafts', '.release-harness/accepted', '.release-harness/reviews');
git(a, 'commit', '-m', 'accept intent and baseline coverage'); git(a, 'push');
console.log('  ok  [MS-A] session A persisted accepted intent and separate baseline coverage');

// Session B -- a different checkout resumes state and reviews multiple classes.
git(root, 'clone', origin, b); git(b, 'config', 'user.name', 'Lifecycle Fixture'); git(b, 'config', 'user.email', 'fixture@example.invalid');
git(b, 'checkout', '-b', 'feature');
assert.equal(rh(b, 'lifecycle', 'status').code, 0);
assert.match(rh(b, 'lifecycle', 'status').all, /accepted contracts\s+1/);
fs.writeFileSync(path.join(b, 'tool.js'), "const value = 'hello'; console.log(value);\n");
fs.writeFileSync(path.join(b, 'test.js'), "// still asserts hello; stronger fixture\n");
fs.writeFileSync(path.join(b, 'release.json'), '{"command":"node ./tool.js"}\n');
fs.writeFileSync(path.join(b, 'dependency.txt'), 'upstream-contract=a'.repeat(2) + '\n');
git(b, 'add', '.'); git(b, 'commit', '-m', 'feature changes');
assert.equal(rh(b, 'review', 'start', 'feature', '--base', 'origin/main', '--contract', contractDigest).code, 0);
completeReview(b, 'feature');
assert.notEqual(rh(b, 'review', 'confirm', 'feature').code, 0, 'agent cannot confirm without attributable operator');
assert.equal(rh(b, 'review', 'confirm', 'feature', '--by', 'operator').code, 0);
git(b, 'add', '-f', '.release-harness/reviews'); git(b, 'commit', '-m', 'confirm feature review'); git(b, 'push', '-u', 'origin', 'feature');
console.log('  ok  [MS-B] session B resumed durable state and confirmed exact change impact');

// Session C -- merged source reuses the same accepted contract after fresh review.
git(a, 'checkout', 'main'); git(a, 'fetch', 'origin'); git(a, 'merge', '--no-ff', 'origin/feature');
git(a, 'add', '-f', '.release-harness/reviews'); git(a, 'commit', '--allow-empty', '-m', 'record merged review');
git(a, 'push');
git(root, 'clone', origin, c); git(c, 'config', 'user.name', 'Lifecycle Fixture'); git(c, 'config', 'user.email', 'fixture@example.invalid');
let stale = rh(c, 'lifecycle', 'check', '--contract', contractDigest);
assert.equal(fs.existsSync(path.join(c, '.release-harness', 'runs')), false, 'fresh checkout has no historical local runs');
assert.equal(stale.code, 0, stale.all);
assert.doesNotMatch(stale.all, /REVIEW_STALE/);
assert.equal(rh(c, 'review', 'start', 'merged', '--base', 'HEAD~1', '--contract', contractDigest).code, 0);
completeReview(c, 'merged');
assert.equal(rh(c, 'review', 'confirm', 'merged', '--by', 'operator').code, 0);
git(c, 'add', '-f', '.release-harness/reviews'); git(c, 'commit', '-m', 'cover merged source');
assert.equal(rh(c, 'bind', 'local', '--target', 'tool=node tool.js').code, 0);
let status = rh(c, 'lifecycle', 'check', '--contract', contractDigest);
assert.equal(status.code, 0, status.all);
assert.doesNotMatch(status.all, /REVIEW_STALE|REVIEW_MISSING|REVIEW_UNCONFIRMED/);
// Bindings are local by policy and warnings do not alter contract identity.
assert.equal(json(path.join(c, '.release-harness', 'accepted', `${contractDigest}.contract.json`)).digest, contractDigest);
console.log('  ok  [MS-C] session C reused the same contract across an exact clean merge');

// Mandatory conflict variant: a post-review conflict resolution changes source.
git(c, 'checkout', '-b', 'conflict-feature');
fs.writeFileSync(path.join(c, 'release.json'), '{"command":"node tool.js","mode":"feature"}\n');
git(c, 'add', 'release.json'); git(c, 'commit', '-m', 'reviewed branch tree');
assert.equal(rh(c, 'review', 'start', 'conflict', '--base', 'main', '--contract', contractDigest).code, 0);
completeReview(c, 'conflict');
assert.equal(rh(c, 'review', 'confirm', 'conflict', '--by', 'operator').code, 0);
git(c, 'add', '-f', '.release-harness/reviews'); git(c, 'commit', '-m', 'review conflict branch');
// Simulate merge resolution changing the release-sensitive file after review.
fs.writeFileSync(path.join(c, 'release.json'), '{"command":"node tool.js","mode":"resolved-differently"}\n');
git(c, 'add', 'release.json'); git(c, 'commit', '-m', 'resolve merge conflict');
const conflictState = rh(c, 'lifecycle', 'check', '--contract', contractDigest);
assert.equal(conflictState.code, 2);
assert.match(conflictState.all, /REVIEW_STALE/);
console.log('  ok  [MS-CONFLICT] conflict resolution invalidates branch review deterministically');

fs.rmSync(root, { recursive: true, force: true });
console.log('\n  4 multi-session acceptance checks passed\n');
