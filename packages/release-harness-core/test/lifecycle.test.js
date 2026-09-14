// Continuous lifecycle: immutable source coverage around the frozen contract.
//
// These tests describe the temporal layer Release-Harness 3.0 adds without
// changing proposition identity. A contract still means only:
//
//   subject + assertions + requires
//
// A lifecycle review records whether an operator considers that proposition
// appropriate for exact source. Confirmation is separate and attributable.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  artifactDigest,
  canonicalizeReview,
  captureGitSource,
  confirmReview,
  deriveLifecycleReadiness,
  reviewDigest,
  validateReviewSemantics,
} from '../src/lifecycle.js';

const results = [];
function pass(id, name) {
  results.push(id);
  console.log(`  ok  [${id}] ${name}`);
}

function git(cwd, args, options = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', ...options });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function repo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-lifecycle-'));
  git(cwd, ['init', '-b', 'main']);
  git(cwd, ['config', 'user.name', 'Lifecycle Test']);
  git(cwd, ['config', 'user.email', 'lifecycle@example.invalid']);
  fs.writeFileSync(path.join(cwd, 'app.js'), "console.log('hello');\n");
  fs.writeFileSync(path.join(cwd, 'test.js'), "// asserts hello\n");
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'initial']);
  return cwd;
}

const contract = {
  schema_version: '1.0.0',
  subject: { id: 'example' },
  assertions: [
    { id: 'A1', kind: 'cli', target: 'tool', expect: { exit_code: 0 } },
    { id: 'A2', kind: 'cli', target: 'tool', expect: { stdout_contains: 'hello' } },
  ],
  requires: [{ ref: 'upstream', digest: 'a'.repeat(64) }],
  digest: 'b'.repeat(64),
};

function review(source, overrides = {}) {
  return {
    schema_version: '1.0.0',
    mode: 'baseline',
    contract: { digest: contract.digest },
    authoring_provenance: { status: 'not_available' },
    sources: [source],
    facts: [
      {
        id: 'F1',
        claim: 'app.js is present at the reviewed source identity',
        status: 'observed',
        evidence: { source: 'app.js' },
      },
    ],
    impact: {
      assertions: [
        { id: 'A1', impact: 'unchanged', supported_by: ['F1'] },
        { id: 'A2', impact: 'unchanged', supported_by: ['F1'] },
      ],
      requires: [{ ref: 'upstream', digest: 'a'.repeat(64), impact: 'unchanged', supported_by: ['F1'] }],
      possible_binding_changes: [],
    },
    questions: [],
    conclusion: { action: 'reuse_contract', summary: 'The accepted proposition remains appropriate.' },
    proposed: { by: 'review-agent', at: '2026-01-01T00:00:00.000Z' },
    ...overrides,
  };
}

console.log('\nContinuous lifecycle core\n');

// ---------------------------------------------------------------------------
// L-1  Source coverage is a SET and excludes only .release-harness state.
// ---------------------------------------------------------------------------
{
  const cwd = repo();
  const initial = captureGitSource(cwd, { sourceId: 'primary', repositoryIdentity: 'example/repo' });
  assert.equal(initial.status, 'established');
  assert.match(initial.head_commit, /^[0-9a-f]{40}$/);
  assert.match(initial.head_tree, /^[0-9a-f]{40}$/);
  assert.match(initial.reviewed_source_digest, /^[0-9a-f]{64}$/);

  fs.mkdirSync(path.join(cwd, '.release-harness', 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.release-harness', 'reviews', 'r.review.json'), '{}\n');
  const lifecycleOnly = captureGitSource(cwd, { sourceId: 'primary', repositoryIdentity: 'example/repo' });
  assert.equal(lifecycleOnly.reviewed_source_digest, initial.reviewed_source_digest);

  fs.writeFileSync(path.join(cwd, 'README.md'), '# changed\n');
  git(cwd, ['add', 'README.md']);
  git(cwd, ['commit', '-m', 'docs']);
  const changed = captureGitSource(cwd, { sourceId: 'primary', repositoryIdentity: 'example/repo' });
  assert.notEqual(changed.reviewed_source_digest, initial.reviewed_source_digest);

  // Two repositories are two source entries; neither is given a role or type.
  const second = repo();
  const sources = [
    changed,
    captureGitSource(second, { sourceId: 'upstream-source', repositoryIdentity: 'example/upstream' }),
  ];
  assert.deepEqual(sources.map((s) => s.source_id), ['primary', 'upstream-source']);
  assert.ok(sources.every((s) => !('role' in s) && !('component' in s)));

  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(second, { recursive: true, force: true });
  pass('L-1', 'source coverage is exact, multi-source, and has no topology semantics');
}

// ---------------------------------------------------------------------------
// L-2  Facts and semantic impact are structurally separate and complete.
// ---------------------------------------------------------------------------
{
  const cwd = repo();
  const source = captureGitSource(cwd, { sourceId: 'primary', baseRef: 'HEAD~1' });
  const r = review(source);
  assert.deepEqual(validateReviewSemantics(r, contract), []);

  const missingAssertion = structuredClone(r);
  missingAssertion.impact.assertions.pop();
  assert.match(validateReviewSemantics(missingAssertion, contract).join('\n'), /A2.*accounted/i);

  const missingRequire = structuredClone(r);
  missingRequire.impact.requires = [];
  assert.match(validateReviewSemantics(missingRequire, contract).join('\n'), /upstream.*accounted/i);

  const falseFact = structuredClone(r);
  falseFact.facts[0].claim = 'The accepted proposition still means the same thing.';
  assert.match(validateReviewSemantics(falseFact, contract).join('\n'), /semantic judgment.*impact/i);

  fs.rmSync(cwd, { recursive: true, force: true });
  pass('L-2', 'factual evidence and semantic impact stay separate and complete');
}

// ---------------------------------------------------------------------------
// L-3  Review identity excludes proposal and confirmation attribution.
// ---------------------------------------------------------------------------
{
  const cwd = repo();
  const r = review(captureGitSource(cwd, { sourceId: 'primary' }));
  const first = reviewDigest(r);
  const reproposed = structuredClone(r);
  reproposed.proposed = { by: 'another agent', at: '2030-01-01T00:00:00.000Z' };
  assert.equal(reviewDigest(reproposed), first);

  const changed = structuredClone(r);
  changed.impact.assertions[0].impact = 'not_established';
  assert.notEqual(reviewDigest(changed), first);

  assert.ok(!('proposed' in canonicalizeReview(r)));
  assert.equal(artifactDigest(canonicalizeReview(r)), first);
  fs.rmSync(cwd, { recursive: true, force: true });
  pass('L-3', 'review digest covers semantic content, not attribution events');
}

// ---------------------------------------------------------------------------
// L-4  Confirmation is required only for authoritative progression.
// ---------------------------------------------------------------------------
{
  const cwd = repo();
  const source = captureGitSource(cwd, { sourceId: 'primary' });
  const r = review(source);

  assert.throws(() => confirmReview(r, contract, { by: '' }), /name who confirms/i);
  const confirmed = confirmReview(r, contract, { by: 'release owner', at: '2026-01-02T00:00:00.000Z' });
  assert.equal(confirmed.review.digest, reviewDigest(r));
  assert.equal(confirmed.confirmation.review_digest, confirmed.review.digest);
  assert.equal(confirmed.confirmation.events[0].by, 'release owner');

  const edited = structuredClone(r);
  edited.conclusion.summary = 'Different conclusion.';
  assert.notEqual(reviewDigest(edited), confirmed.confirmation.review_digest);

  const blocked = review(source, {
    conclusion: { action: 'block', summary: 'Impact is unresolved.' },
    questions: [{ id: 'Q1', question: 'Does behavior change?', blocking: true }],
  });
  const readiness = deriveLifecycleReadiness({ contract, currentSources: [source], review: blocked });
  assert.equal(readiness.eligible, false);
  assert.ok(readiness.reasons.some((x) => x.code === 'REVIEW_BLOCKS_RELEASE'));
  assert.ok(!readiness.reasons.some((x) => x.code === 'REVIEW_UNCONFIRMED'));

  fs.rmSync(cwd, { recursive: true, force: true });
  pass('L-4', 'confirmation authorizes reuse, while block needs no ceremony');
}

// ---------------------------------------------------------------------------
// L-5  Freshness compares exact source SET identity and ignores commit labels.
// ---------------------------------------------------------------------------
{
  const cwd = repo();
  const source = captureGitSource(cwd, { sourceId: 'primary' });
  const r = review(source);
  const confirmed = confirmReview(r, contract, { by: 'owner' });

  let state = deriveLifecycleReadiness({
    contract,
    currentSources: [captureGitSource(cwd, { sourceId: 'primary' })],
    review: confirmed.review,
    confirmation: confirmed.confirmation,
  });
  assert.equal(state.eligible, true);

  // A lifecycle-only commit moves HEAD but not the source projection.
  fs.mkdirSync(path.join(cwd, '.release-harness', 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.release-harness', 'reviews', 'confirmed.json'), '{}\n');
  git(cwd, ['add', '-f', '.release-harness/reviews/confirmed.json']);
  git(cwd, ['commit', '-m', 'record review']);
  const afterLifecycleCommit = captureGitSource(cwd, { sourceId: 'primary' });
  assert.notEqual(afterLifecycleCommit.head_commit, source.head_commit);
  assert.equal(afterLifecycleCommit.reviewed_source_digest, source.reviewed_source_digest);
  state = deriveLifecycleReadiness({ contract, currentSources: [afterLifecycleCommit], review: confirmed.review, confirmation: confirmed.confirmation });
  assert.equal(state.eligible, true);

  // A conflict resolution or any other product-source edit changes coverage.
  fs.writeFileSync(path.join(cwd, 'app.js'), "console.log('conflict resolution');\n");
  git(cwd, ['add', 'app.js']);
  git(cwd, ['commit', '-m', 'resolve conflict differently']);
  state = deriveLifecycleReadiness({
    contract,
    currentSources: [captureGitSource(cwd, { sourceId: 'primary' })],
    review: confirmed.review,
    confirmation: confirmed.confirmation,
  });
  assert.equal(state.eligible, false);
  assert.ok(state.reasons.some((x) => x.code === 'REVIEW_STALE'));

  fs.rmSync(cwd, { recursive: true, force: true });
  pass('L-5', 'exact projected source identity detects post-review changes');
}

// ---------------------------------------------------------------------------
// L-6  Missing Git/base and untracked durable state never read as unchanged.
// ---------------------------------------------------------------------------
{
  const cwd = repo();
  const missingBase = captureGitSource(cwd, { sourceId: 'primary', baseRef: 'does-not-exist' });
  assert.equal(missingBase.status, 'not_established');
  assert.match(missingBase.reason, /base ref/i);

  fs.mkdirSync(path.join(cwd, '.release-harness', 'drafts'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.release-harness', 'drafts', 'x.draft.json'), '{}\n');
  const untracked = captureGitSource(cwd, { sourceId: 'primary' });
  assert.equal(untracked.status, 'established');

  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-nongit-'));
  const absent = captureGitSource(nonGit, { sourceId: 'primary' });
  assert.equal(absent.status, 'not_established');
  assert.match(absent.reason, /not a Git repository/i);

  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(nonGit, { recursive: true, force: true });
  pass('L-6', 'missing comparison evidence is not_established, never unchanged');
}

// ---------------------------------------------------------------------------
// L-7  Dirty product source cannot become authoritative review coverage.
// ---------------------------------------------------------------------------
{
  const cwd = repo();
  fs.writeFileSync(path.join(cwd, 'app.js'), "console.log('uncommitted');\n");
  let source = captureGitSource(cwd, { sourceId: 'primary' });
  assert.equal(source.status, 'not_established');
  assert.match(source.reason, /uncommitted.*source/i);

  git(cwd, ['checkout', '--', 'app.js']);
  fs.writeFileSync(path.join(cwd, 'new-product-file.js'), '// untracked\n');
  source = captureGitSource(cwd, { sourceId: 'primary' });
  assert.equal(source.status, 'not_established');

  fs.unlinkSync(path.join(cwd, 'new-product-file.js'));
  fs.mkdirSync(path.join(cwd, '.release-harness'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.release-harness', 'local.json'), '{}\n');
  source = captureGitSource(cwd, { sourceId: 'primary' });
  assert.equal(source.status, 'established', 'lifecycle-owned untracked state is excluded explicitly');

  fs.rmSync(cwd, { recursive: true, force: true });
  pass('L-7', 'dirty product source is not_established; lifecycle-owned state is excluded');
}

// ---------------------------------------------------------------------------
// L-8  A normative identity cannot silently follow a changed dependency.
// ---------------------------------------------------------------------------
{
  const cwd = repo();
  const source = captureGitSource(cwd, { sourceId: 'primary' });
  const r = review(source);
  const changed = structuredClone(r);
  changed.impact.requires[0] = {
    ref: 'upstream',
    digest: 'c'.repeat(64),
    impact: 'changed',
    supported_by: ['F1'],
  };
  const errors = validateReviewSemantics(changed, contract).join('\n');
  assert.match(errors, /not present in the contract|must be accounted/i);

  const honest = structuredClone(r);
  honest.impact.requires[0].impact = 'changed';
  honest.conclusion = { action: 'reauthor', summary: 'A new proposition may pin a different upstream digest.' };
  const readiness = deriveLifecycleReadiness({ contract, currentSources: [source], review: honest });
  assert.equal(readiness.eligible, false);
  assert.ok(readiness.reasons.some((x) => x.code === 'REVIEW_BLOCKS_RELEASE'));
  assert.equal(contract.requires[0].digest, 'a'.repeat(64), 'lifecycle review never mutates requires');

  fs.rmSync(cwd, { recursive: true, force: true });
  pass('L-8', 'normative identity changes require reauthoring and never mutate requires');
}

console.log(`\n  ${results.length} lifecycle-core checks passed\n`);
