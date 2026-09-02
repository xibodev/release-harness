import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvidenceSealer } from '../src/sealer.js';

console.log('Running Evidence Sealer Lifecycle Tests...');

// 1. writeEvidence is permitted while the directory is open for collection
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-sealer-open-'));
  try {
    const sealer = new EvidenceSealer(dir, 'seal-open-run');

    const written = sealer.writeEvidence('probes/before.json', '{"ok":true}\n');
    assert.strictEqual(
      written,
      path.join(dir, 'probes', 'before.json'),
      'writeEvidence must return the absolute path it wrote'
    );
    assert.ok(fs.existsSync(written), 'A write during COLLECTING must reach disk');
    assert.strictEqual(fs.readFileSync(written, 'utf8'), '{"ok":true}\n', 'Content must be written verbatim');

    // Parent directories are created on demand.
    const nested = sealer.writeEvidence('logs/deep/nested/run.log', 'line\n');
    assert.ok(fs.existsSync(nested), 'writeEvidence must create missing parent directories');

    // The written file is picked up by the manifest, proving writeEvidence targets
    // the sealed evidence set rather than some directory beside it.
    const { manifest } = sealer.sealEvidence();
    const paths = manifest.files.map((f) => f.path);
    assert.ok(paths.includes('probes/before.json'), 'writeEvidence output must appear in the sealed manifest');
    assert.ok(paths.includes('logs/deep/nested/run.log'), 'Nested writeEvidence output must appear in the sealed manifest');

    console.log('✓ writeEvidence writes, creates parents, and lands inside the sealed evidence set');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 2. A write attempted after sealing is refused at the write, not later by hash mismatch
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-sealer-closed-'));
  try {
    const sealer = new EvidenceSealer(dir, 'seal-closed-run');
    sealer.writeEvidence('probes/before.json', '{"ok":true}\n');
    sealer.sealEvidence({ policy: 'test' });
    assert.strictEqual(sealer.getState(), 'SEALED', 'sealEvidence must leave the sealer SEALED');

    // LOAD-BEARING: removing the assertCanWrite() call from writeEvidence makes this throw fail.
    assert.throws(
      () => sealer.writeEvidence('probes/after.json', '{"tampered":true}\n'),
      /seal/i,
      'A post-seal write must be refused at the write with a message naming the seal'
    );
    assert.ok(
      !fs.existsSync(path.join(dir, 'probes', 'after.json')),
      'The refused write must not reach disk'
    );

    // The seal held, so integrity still verifies. Without the guard the file would be
    // on disk and this would report an unexpected-file violation instead.
    const integrity = sealer.verifyIntegrity();
    assert.strictEqual(integrity.ok, true, 'A refused write must leave evidence integrity intact');

    console.log('✓ Post-seal writes are refused at the write and never reach disk');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 3. The guard is refused in every closed state, not just SEALED
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-sealer-states-'));
  try {
    for (const closedState of ['SEALED', 'EVALUATING', 'FINALIZED']) {
      const sealer = new EvidenceSealer(dir, 'seal-state-run');
      sealer.transitionTo('SANITIZING');
      sealer.transitionTo('SEALED');
      if (closedState !== 'SEALED') sealer.transitionTo('EVALUATING');
      if (closedState === 'FINALIZED') sealer.transitionTo('FINALIZED');
      assert.strictEqual(sealer.getState(), closedState);
      assert.throws(
        () => sealer.writeEvidence('probes/x.json', '{}\n'),
        /seal/i,
        `writeEvidence must be refused while ${closedState}`
      );
    }

    // SANITIZING is still open: redaction rewrites evidence before the seal closes.
    const sanitizing = new EvidenceSealer(dir, 'seal-sanitizing-run');
    sanitizing.transitionTo('SANITIZING');
    const redacted = sanitizing.writeEvidence('logs/redacted.log', 'clean\n');
    assert.ok(fs.existsSync(redacted), 'SANITIZING must remain open to writes for redaction');

    console.log('✓ writeEvidence is refused in SEALED/EVALUATING/FINALIZED and allowed while SANITIZING');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('All Evidence Sealer lifecycle tests PASSED.\n');
