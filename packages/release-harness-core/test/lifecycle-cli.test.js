// CLI lifecycle: durable review, confirmation, freshness and Git diagnostics.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'release-harness.js');

function run(cwd, args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, all: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-lifecycle-cli-'));
  git(cwd, ['init', '-b', 'main']);
  git(cwd, ['config', 'user.name', 'Lifecycle CLI']);
  git(cwd, ['config', 'user.email', 'cli@example.invalid']);
  fs.writeFileSync(path.join(cwd, 'tool.js'), "console.log('ok');\n");
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'subject']);
  return cwd;
}

function commitCapability(cwd) {
  git(cwd, ['add', 'AGENTS.md', '.agents/skills/release-harness/SKILL.md', '.claude/skills/release-harness/SKILL.md']);
  git(cwd, ['commit', '-m', 'install lifecycle capability']);
}

function writeAccepted(cwd) {
  let r = run(cwd, ['draft', 'new', 'tool']);
  assert.equal(r.code, 0, r.all);
  const root = path.join(cwd, '.release-harness', 'drafts');
  const draftPath = path.join(root, 'tool.draft.json');
  const recordPath = path.join(root, 'tool.record.json');
  const draft = JSON.parse(fs.readFileSync(draftPath));
  draft.proposition.subject = { id: 'tool', name: 'Tool' };
  draft.proposition.assertions = [{ id: 'A1', kind: 'cli', target: 'tool', expect: { exit_code: 0 }, supported_by: ['C1'] }];
  draft.questions = [];
  fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2) + '\n');
  const record = JSON.parse(fs.readFileSync(recordPath));
  record.authored_by = 'fixture';
  record.claims = [{ id: 'C1', claim: 'tool.js exits 0', status: 'observed', evidence: { source: 'tool.js:1' } }];
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
  r = run(cwd, ['accept', '--draft', 'tool', '--by', 'fixture']);
  assert.equal(r.code, 0, r.all);
  return fs.readdirSync(path.join(cwd, '.release-harness', 'accepted')).find((f) => f.endsWith('.contract.json')).split('.')[0];
}

function authorReview(cwd, name, action = 'reuse_contract') {
  const file = path.join(cwd, '.release-harness', 'reviews', `${name}.review.json`);
  const value = JSON.parse(fs.readFileSync(file));
  const contractFile = fs.readdirSync(path.join(cwd, '.release-harness', 'accepted')).find((f) => f.endsWith('.contract.json'));
  const contract = JSON.parse(fs.readFileSync(path.join(cwd, '.release-harness', 'accepted', contractFile)));
  value.facts = [{ id: 'F1', claim: 'tool.js is present at the reviewed source', status: 'observed', evidence: { source: 'tool.js:1' } }];
  value.impact.assertions = contract.assertions.map((a) => ({ id: a.id, impact: 'unchanged', supported_by: ['F1'] }));
  value.impact.requires = (contract.requires ?? []).map((x) => ({ ...x, impact: 'unchanged', supported_by: ['F1'] }));
  value.conclusion = { action, summary: action === 'reuse_contract' ? 'The accepted proposition remains appropriate.' : 'Impact requires more work.' };
  value.proposed = { by: 'review-agent', at: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

console.log('\nLifecycle CLI\n');

// LC-1  Plain init keeps the old deterministic engine and does not require Git.
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-plain-'));
  const r = run(cwd, ['init']);
  assert.equal(r.code, 0, r.all);
  const config = JSON.parse(fs.readFileSync(path.join(cwd, '.release-harness', 'config.json')));
  assert.equal(config.lifecycle?.enabled, undefined);
  assert.equal(fs.existsSync(path.join(cwd, '.agents', 'skills', 'release-harness', 'SKILL.md')), false);
  fs.rmSync(cwd, { recursive: true, force: true });
  console.log('  ok  [LC-1] plain deterministic mode remains independent of Git lifecycle');
}

// LC-2  --with-agent installs one thin capability and an idempotent managed block.
{
  const cwd = fixture();
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# User instructions\n\nKeep this text.\n');
  let r = run(cwd, ['init', '--with-agent']);
  assert.equal(r.code, 0, r.all);
  const config = JSON.parse(fs.readFileSync(path.join(cwd, '.release-harness', 'config.json')));
  assert.equal(config.lifecycle.enabled, true);
  for (const f of ['.agents/skills/release-harness/SKILL.md', '.claude/skills/release-harness/SKILL.md']) {
    assert.ok(fs.existsSync(path.join(cwd, f)), f);
    const text = fs.readFileSync(path.join(cwd, f), 'utf8');
    assert.match(text, /\.release-harness\/protocol\/LIFECYCLE\.md/);
    assert.doesNotMatch(text, /reviewed_source_digest|reuse_contract|verdict rules/i);
  }
  const once = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8');
  assert.match(once, /Keep this text/);
  assert.equal((once.match(/release-harness:managed:start/g) ?? []).length, 1);
  r = run(cwd, ['init', '--with-agent', '--force']);
  assert.equal(r.code, 0, r.all);
  const twice = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8');
  assert.equal((twice.match(/release-harness:managed:start/g) ?? []).length, 1);
  assert.match(twice, /Keep this text/);
  assert.ok(fs.existsSync(path.join(cwd, '.release-harness', 'protocol', 'LIFECYCLE.md')));
  fs.rmSync(cwd, { recursive: true, force: true });
  console.log('  ok  [LC-2] one persistent capability installs idempotently without owning user instructions');
}

// LC-3  Initial coverage is a baseline review, not expanded acceptance.
{
  const cwd = fixture();
  assert.equal(run(cwd, ['init', '--with-agent']).code, 0);
  commitCapability(cwd);
  const digest = writeAccepted(cwd);
  let r = run(cwd, ['review', 'start', 'baseline', '--contract', digest]);
  assert.equal(r.code, 0, r.all);
  authorReview(cwd, 'baseline');
  r = run(cwd, ['review', 'validate', 'baseline']);
  assert.equal(r.code, 0, r.all);
  r = run(cwd, ['review', 'confirm', 'baseline', '--by', 'release owner']);
  assert.equal(r.code, 0, r.all);
  const accepted = JSON.parse(fs.readFileSync(path.join(cwd, '.release-harness', 'accepted', `${digest}.contract.json`)));
  assert.ok(!('sources' in accepted) && !('coverage' in accepted));
  const reviewFiles = fs.readdirSync(path.join(cwd, '.release-harness', 'reviews', 'confirmed'));
  assert.equal(reviewFiles.filter((f) => f.endsWith('.review.json')).length, 1);
  fs.rmSync(cwd, { recursive: true, force: true });
  console.log('  ok  [LC-3] baseline source coverage is separate from acceptance');
}

// LC-4  Status/check enforce exact review freshness only when lifecycle is enabled.
{
  const cwd = fixture();
  assert.equal(run(cwd, ['init', '--with-agent']).code, 0);
  commitCapability(cwd);
  const digest = writeAccepted(cwd);
  let r = run(cwd, ['lifecycle', 'check', '--contract', digest]);
  assert.equal(r.code, 2);
  assert.match(r.all, /review.*missing/i);
  assert.equal(run(cwd, ['review', 'start', 'baseline', '--contract', digest]).code, 0);
  authorReview(cwd, 'baseline');
  assert.equal(run(cwd, ['review', 'confirm', 'baseline', '--by', 'owner']).code, 0);
  r = run(cwd, ['lifecycle', 'check', '--contract', digest]);
  assert.equal(r.code, 2, r.all);
  assert.doesNotMatch(r.all, /REVIEW_MISSING|REVIEW_STALE|REVIEW_UNCONFIRMED/);
  assert.match(r.all, /only in this checkout/i);
  fs.writeFileSync(path.join(cwd, 'tool.js'), "console.log('changed');\n");
  git(cwd, ['add', 'tool.js']);
  git(cwd, ['commit', '-m', 'change source']);
  r = run(cwd, ['lifecycle', 'check', '--contract', digest]);
  assert.equal(r.code, 2);
  assert.match(r.all, /REVIEW_STALE/);
  fs.rmSync(cwd, { recursive: true, force: true });
  console.log('  ok  [LC-4] lifecycle check blocks stale source deterministically');
}

// LC-5  Review start records exact base or not_established, never unchanged.
{
  const cwd = fixture();
  assert.equal(run(cwd, ['init', '--with-agent']).code, 0);
  commitCapability(cwd);
  const digest = writeAccepted(cwd);
  let r = run(cwd, ['review', 'start', 'change', '--contract', digest, '--base', 'missing-ref']);
  assert.equal(r.code, 2, r.all);
  const review = JSON.parse(fs.readFileSync(path.join(cwd, '.release-harness', 'reviews', 'change.review.json')));
  assert.equal(review.sources[0].status, 'not_established');
  assert.equal(review.sources[0].changed_paths, undefined);
  assert.equal(review.conclusion.action, 'block');
  fs.rmSync(cwd, { recursive: true, force: true });
  console.log('  ok  [LC-5] unavailable comparison base is durable not_established evidence');
}

// LC-6  Durable-state tracking warnings are mechanical; nothing is added.
{
  const cwd = fixture();
  assert.equal(run(cwd, ['init', '--with-agent']).code, 0);
  commitCapability(cwd);
  assert.equal(run(cwd, ['draft', 'new', 'untracked']).code, 0);
  const before = git(cwd, ['status', '--porcelain']);
  const r = run(cwd, ['lifecycle', 'status']);
  assert.equal(r.code, 2);
  assert.match(r.all, /draft.*only in this checkout/i);
  assert.equal(git(cwd, ['status', '--porcelain']), before);
  fs.rmSync(cwd, { recursive: true, force: true });
  console.log('  ok  [LC-6] untracked durable state is warned about, never auto-committed');
}

console.log('\n  6 lifecycle CLI checks passed\n');

// LC-7  Lifecycle-enabled certifying run refuses stale coverage before effects.
{
  const cwd = fixture();
  assert.equal(run(cwd, ['init', '--with-agent']).code, 0);
  commitCapability(cwd);
  const digest = writeAccepted(cwd);
  assert.equal(run(cwd, ['bind', 'local', '--target', 'tool=node tool.js']).code, 0);
  const runs = path.join(cwd, '.release-harness', 'runs');
  const before = fs.readdirSync(runs).length;
  const refused = run(cwd, ['run', '--binding', 'local', '--contract', digest]);
  assert.equal(refused.code, 2, refused.all);
  assert.match(refused.all, /lifecycle coverage.*not current/i);
  assert.equal(fs.readdirSync(runs).length, before);

  const plain = fixture();
  assert.equal(run(plain, ['init']).code, 0);
  const plainDigest = writeAccepted(plain);
  assert.equal(run(plain, ['bind', 'local', '--target', 'tool=node tool.js']).code, 0);
  const executed = run(plain, ['run', '--binding', 'local', '--contract', plainDigest]);
  assert.equal(executed.code, 0, executed.all);

  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(plain, { recursive: true, force: true });
  console.log('  ok  [LC-7] lifecycle gate precedes effects without making Git universal');
}


// LC-8  Legacy topology-era state is detected and never consumed as evidence.
{
  const cwd = fixture();
  fs.mkdirSync(path.join(cwd, '.release-harness'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.release-harness', 'topology.json'), JSON.stringify({ product_slug: 'invented' }));
  const r = run(cwd, ['init', '--with-agent']);
  assert.equal(r.code, 2, r.all);
  assert.match(r.all, /Legacy topology-era state detected/);
  assert.match(r.all, /investigation leads, not evidence/);
  assert.equal(fs.existsSync(path.join(cwd, '.release-harness', 'config.json')), false);
  fs.rmSync(cwd, { recursive: true, force: true });
  console.log('  ok  [LC-8] legacy generated values are detected and never migrated into claims');
}


// LC-9  Current beta state is refreshed without rewriting authored identity.
{
  const cwd = fixture();
  assert.equal(run(cwd, ['init']).code, 0);
  const digest = writeAccepted(cwd);
  const contractPath = path.join(cwd, '.release-harness', 'accepted', `${digest}.contract.json`);
  const before = fs.readFileSync(contractPath);
  assert.equal(run(cwd, ['init', '--with-agent', '--force']).code, 0);
  assert.deepEqual(fs.readFileSync(contractPath), before);
  assert.ok(fs.existsSync(path.join(cwd, '.release-harness', 'protocol', 'LIFECYCLE.md')));
  const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.release-harness', 'config.json')));
  assert.equal(cfg.lifecycle.enabled, true);
  fs.rmSync(cwd, { recursive: true, force: true });
  console.log('  ok  [LC-9] current beta state refresh preserves immutable accepted identity');
}

// LC-11  A subject may bind lifecycle coverage to multiple repositories.
{
  const cwd = fixture();
  const assembly = fixture();
  assert.equal(run(cwd, ['init', '--with-agent']).code, 0);
  commitCapability(cwd);
  const digest = writeAccepted(cwd);
  let r = run(cwd, ['lifecycle', 'source', 'set', 'assembly', '--path', assembly]);
  assert.equal(r.code, 0, r.all);
  r = run(cwd, ['review', 'start', 'multi', '--contract', digest]);
  assert.equal(r.code, 0, r.all);
  const file = path.join(cwd, '.release-harness', 'reviews', 'multi.review.json');
  const review = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(review.sources.map((s) => s.source_id), ['assembly', 'primary']);
  assert.ok(review.sources.every((s) => !('role' in s) && !('component' in s)));
  authorReview(cwd, 'multi');
  assert.equal(run(cwd, ['review', 'confirm', 'multi', '--by', 'owner']).code, 0);

  // Ignore checkout-local durability warnings here; source coverage itself is current.
  r = run(cwd, ['lifecycle', 'status', '--contract', digest]);
  assert.doesNotMatch(r.all, /REVIEW_STALE|SOURCE_UNREVIEWED/);
  fs.writeFileSync(path.join(assembly, 'app.js'), "console.log('changed assembly');\n");
  git(assembly, ['add', 'app.js']);
  git(assembly, ['commit', '-m', 'change assembly']);
  r = run(cwd, ['lifecycle', 'status', '--contract', digest]);
  assert.match(r.all, /REVIEW_STALE/);

  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(assembly, { recursive: true, force: true });
  console.log('  ok  [LC-11] exact source coverage spans multiple repositories without roles');
}

{
  const cwd = fixture();
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.release-harness/\n');
  git(cwd, ['add', '.gitignore']);
  git(cwd, ['commit', '-m', 'ignore local harness state']);
  assert.equal(run(cwd, ['init', '--with-agent']).code, 0);
  assert.equal(run(cwd, ['draft', 'new', 'ignored']).code, 0);
  const status = run(cwd, ['lifecycle', 'status']);
  assert.equal(status.code, 2);
  assert.match(status.all, /ignored.*draft.*only in this checkout/i);
  fs.rmSync(cwd, { recursive: true, force: true });
  console.log('  ok  [LC-10] ignored durable state is reported as checkout-local');
}
