// Characterization tests for the deterministic mechanisms vNext preserves.
//
// These are NOT compatibility tests. They pin the behaviour of mechanisms the
// vNext architecture keeps -- enumeration, copy/digest continuity, sealing,
// mutation rejection, symlink refusal, dirty-tree handling -- so that the
// architecture around them can be deleted without silently damaging them.
//
// A behaviour that vNext explicitly rejects is NOT characterized here. Where a
// current behaviour is being deliberately replaced, this file records that fact
// in a comment rather than locking it in with an assertion. The distinction
// matters: a characterization suite that pins rejected behaviour would convert
// a redesign into a compatibility exercise.

import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { EvidenceSealer } from '../src/sealer.js';
import { SourceMaterializer } from '../src/materializer.js';
import { enumerateSource } from '../src/source-enumerator.js';

const results = [];
function pass(id, name) {
  results.push(id);
  console.log(`  ok  [${id}] ${name}`);
}

function tmpRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  return dir;
}

function commitAll(dir, message = 'fixture') {
  execSync('git add -A', { cwd: dir, stdio: 'ignore' });
  execSync(
    `git -c user.name=fixture -c user.email=fixture@test commit -m ${JSON.stringify(message)}`,
    { cwd: dir, stdio: 'ignore' }
  );
}

console.log('\nCharacterization: deterministic mechanisms retained by vNext\n');

// ---------------------------------------------------------------------------
// C-01  Enumeration is git-aware: tracked source survives, ignored stores do not.
//
// RETAINED. vNext binds explicit sources rather than scanning from cwd, but the
// enumeration mechanism itself is what performs that binding.
// ---------------------------------------------------------------------------
{
  const repo = tmpRepo('char-enum-');
  fs.mkdirSync(path.join(repo, 'src', 'content', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'content', 'docs', 'intro.mdx'), '# Intro\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.pnpm-store/\n');
  fs.mkdirSync(path.join(repo, '.pnpm-store'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.pnpm-store', 'blob.bin'), 'x'.repeat(512));
  commitAll(repo);

  const res = enumerateSource(repo);
  assert.strictEqual(res.strategy, 'git', 'a git repo must use git enumeration');
  assert.ok(res.files.includes('src/content/docs/intro.mdx'), 'nested product source must survive');
  assert.ok(!res.files.some((f) => f.startsWith('.pnpm-store/')), 'ignored stores must be excluded');
  assert.ok(!res.files.some((f) => f.startsWith('.git/')), '.git must never be enumerated');

  fs.rmSync(repo, { recursive: true, force: true });
  pass('C-01', 'git-aware enumeration keeps tracked source, drops ignored stores');
}

// ---------------------------------------------------------------------------
// C-02  Enumeration is deterministic: same tree, same list, same order.
//
// RETAINED and load-bearing. vNext's contract digest is a separate concern, but
// source identity still depends on this being stable.
// ---------------------------------------------------------------------------
{
  const repo = tmpRepo('char-det-');
  for (const n of ['b.txt', 'a.txt', 'c.txt']) fs.writeFileSync(path.join(repo, n), `${n}\n`);
  fs.mkdirSync(path.join(repo, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'nested', 'z.txt'), 'z\n');
  commitAll(repo);

  const first = enumerateSource(repo).files;
  const second = enumerateSource(repo).files;
  assert.deepStrictEqual(second, first, 'enumeration must be deterministic across calls');
  assert.deepStrictEqual([...first].sort(), first, 'enumeration must be sorted');

  fs.rmSync(repo, { recursive: true, force: true });
  pass('C-02', 'enumeration is deterministic and sorted');
}

// ---------------------------------------------------------------------------
// C-03  Copy/digest continuity: the digest covers exactly what was materialized,
//       at any depth.
//
// RETAINED. This is the property that a single shared enumeration exists to
// guarantee; vNext must not regress it while changing what gets bound.
// ---------------------------------------------------------------------------
{
  const repo = tmpRepo('char-cont-');
  const deep = path.join(repo, 'a', 'b', 'c', 'd', 'e', 'f');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'deep.txt'), 'original\n');
  fs.writeFileSync(path.join(repo, 'shallow.txt'), 'top\n');
  commitAll(repo);

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'char-ws-'));
  const mat = new SourceMaterializer(ws);

  const before = mat.computeTreeDigest(repo);
  fs.writeFileSync(path.join(deep, 'deep.txt'), 'MUTATED\n');
  const after = mat.computeTreeDigest(repo);
  assert.notStrictEqual(before, after, 'a change at depth 6 must move the digest');

  const out = mat.materializeRepo(repo, 'source');
  assert.ok(
    fs.existsSync(path.join(out.targetDir, 'a', 'b', 'c', 'd', 'e', 'f', 'deep.txt')),
    'deep files must be materialized'
  );
  assert.strictEqual(out.stats.fileCount, 2, 'stats must count exactly the tracked files');

  mat.cleanup();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
  pass('C-03', 'copy set and digest cover the same files at any depth');
}

// ---------------------------------------------------------------------------
// C-04  Cleanliness fails closed when git status cannot be resolved.
//
// RETAINED. vNext keeps "unknown is never treated as good" -- the same principle
// the attribution rewrite applies to failure causes.
// ---------------------------------------------------------------------------
{
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'char-nogit-'));
  fs.writeFileSync(path.join(notARepo, 'file.txt'), 'no git here\n');

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'char-ws2-'));
  const mat = new SourceMaterializer(ws);
  const info = mat.getSourceInfo(notARepo);

  assert.strictEqual(info.statusResolved, false, 'a non-git tree resolves no status');
  assert.strictEqual(info.isClean, false, 'unresolvable status must fail closed');

  fs.rmSync(notARepo, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
  pass('C-04', 'cleanliness fails closed when status is unresolvable');
}

// ---------------------------------------------------------------------------
// C-05  Evidence sealing produces a manifest that verifies.
//
// RETAINED MECHANISM. Note: this characterizes hashing + verification only. It
// deliberately does NOT characterize the policy-snapshot argument, which vNext
// replaces -- today that file recombines assertions with topology and origins
// and hashes them as one unit, which is the boundary the redesign corrects.
// ---------------------------------------------------------------------------
{
  const ev = fs.mkdtempSync(path.join(os.tmpdir(), 'char-seal-'));
  const sealer = new EvidenceSealer(ev, 'char-run-1');

  sealer.writeEvidence('execution.log', 'run started\n');
  sealer.writeEvidence('probes/artifact.json', '{"ok":true}\n');
  const sealed = sealer.sealEvidence();

  assert.match(sealed.manifestSha256, /^[0-9a-f]{64}$/, 'manifest digest must be sha256 hex');
  assert.ok(sealed.manifest.files.length >= 2, 'sealed manifest must list the written files');
  assert.strictEqual(sealer.verifyIntegrity().ok, true, 'a freshly sealed manifest verifies');

  fs.rmSync(ev, { recursive: true, force: true });
  pass('C-05', 'sealing produces a verifying manifest');
}

// ---------------------------------------------------------------------------
// C-06  Post-seal writes are rejected at the write.
//
// RETAINED. The lifecycle guard is the mechanism vNext relies on to make
// "sealed" mean something, independent of the artifact format.
// ---------------------------------------------------------------------------
{
  const ev = fs.mkdtempSync(path.join(os.tmpdir(), 'char-postseal-'));
  const sealer = new EvidenceSealer(ev, 'char-run-2');
  sealer.writeEvidence('before.json', '{"ok":true}\n');
  sealer.sealEvidence();

  assert.throws(
    () => sealer.writeEvidence('after.json', '{"tampered":true}\n'),
    /seal/i,
    'a write after sealing must be refused at the write'
  );
  assert.ok(
    !fs.existsSync(path.join(ev, 'after.json')),
    'the refused write must not reach disk'
  );

  fs.rmSync(ev, { recursive: true, force: true });
  pass('C-06', 'post-seal writes are refused at the write, not detected later');
}

// ---------------------------------------------------------------------------
// C-07  Tampering with sealed evidence is detected.
//
// RETAINED and directly reused by the vNext `verify` command.
// ---------------------------------------------------------------------------
{
  const ev = fs.mkdtempSync(path.join(os.tmpdir(), 'char-tamper-'));
  const sealer = new EvidenceSealer(ev, 'char-run-3');
  sealer.writeEvidence('raw-results.json', '{"passed":true}\n');
  sealer.sealEvidence();
  assert.strictEqual(sealer.verifyIntegrity().ok, true, 'baseline must verify');

  fs.writeFileSync(path.join(ev, 'raw-results.json'), '{"passed":false}\n');
  const after = sealer.verifyIntegrity();
  assert.strictEqual(after.ok, false, 'a mutated evidence file must fail verification');
  assert.ok(after.modifiedFiles.length > 0, 'the mutated file must be named');

  fs.rmSync(ev, { recursive: true, force: true });
  pass('C-07', 'evidence mutation is detected by integrity verification');
}

// ---------------------------------------------------------------------------
// C-08  Symlinks escaping the source tree are excluded from enumeration.
//
// RETAINED. Skips where the platform forbids symlink creation -- and records the
// skip rather than reporting a pass, because a silent skip is the same defect
// class this project exists to eliminate.
// ---------------------------------------------------------------------------
{
  const repo = tmpRepo('char-link-');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'char-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not in the repo\n');
  fs.writeFileSync(path.join(repo, 'inside.txt'), 'in the repo\n');

  let linked = false;
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'escape.txt'));
    linked = true;
  } catch {
    console.log('  skip [C-08] symlink creation unavailable on this host (needs elevation)');
  }

  if (linked) {
    commitAll(repo);
    const res = enumerateSource(repo);
    assert.ok(
      !res.files.includes('escape.txt'),
      'a symlink resolving outside the source tree must be excluded'
    );
    assert.ok(res.files.includes('inside.txt'), 'in-tree files are unaffected');
    pass('C-08', 'symlinks escaping the tree are excluded');
  }

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// C-09  Enumeration reports its strategy and does not throw on a non-directory.
//
// RETAINED. vNext's bounded-discovery protocol depends on enumeration degrading
// rather than crashing, and on being able to say which strategy produced a list.
// ---------------------------------------------------------------------------
{
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'char-file-')), 'plain.txt');
  fs.writeFileSync(file, 'i am a file, not a directory\n');

  const res = enumerateSource(file);
  assert.ok(Array.isArray(res.files), 'must return a file list rather than throwing');
  assert.ok(typeof res.strategy === 'string', 'must report the strategy used');
  assert.ok(Array.isArray(res.warnings), 'must report warnings');

  pass('C-09', 'enumeration degrades without throwing and reports its strategy');
}

console.log(`\n  ${results.length} characterization checks passed\n`);
