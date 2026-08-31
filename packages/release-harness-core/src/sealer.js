import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class EvidenceSealer {
  constructor(evidenceDir, runId) {
    this.evidenceDir = path.resolve(evidenceDir);
    this.runId = runId;
    this.state = 'COLLECTING'; // COLLECTING -> SANITIZING -> SEALED -> EVALUATING -> FINALIZED
  }

  getState() {
    return this.state;
  }

  transitionTo(newState) {
    const validTransitions = {
      COLLECTING: ['SANITIZING'],
      SANITIZING: ['SEALED'],
      SEALED: ['EVALUATING'],
      EVALUATING: ['FINALIZED'],
      FINALIZED: [],
    };

    const allowed = validTransitions[this.state] || [];
    if (!allowed.includes(newState)) {
      throw new Error(`Invalid evidence lifecycle transition from ${this.state} to ${newState}`);
    }
    this.state = newState;
    return this.state;
  }

  assertCanWrite() {
    if (this.state !== 'COLLECTING' && this.state !== 'SANITIZING') {
      throw new Error(`Evidence write rejected: evidence directory is ${this.state} (closed to mutations)`);
    }
  }

  categorizeFile(relPath) {
    const norm = relPath.replace(/\\/g, '/');
    if (norm.startsWith('logs/') || norm.endsWith('.log')) return 'log';
    if (norm.startsWith('traces/') || norm.endsWith('.zip')) return 'trace';
    if (norm.startsWith('screenshots/') || norm.endsWith('.png') || norm.endsWith('.webp') || norm.endsWith('.jpg')) {
      return 'screenshot';
    }
    if (norm.startsWith('probes/') || norm.includes('side-effect')) return 'probe';
    if (norm.startsWith('results/') || norm.endsWith('.json')) return 'result';
    return 'other';
  }

  computeFileHash(filePath) {
    const buffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  scanFiles() {
    const files = [];
    if (!fs.existsSync(this.evidenceDir)) return files;

    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const rel = path.relative(this.evidenceDir, full).replace(/\\/g, '/');
          if (rel === 'evidence.manifest.json' || rel === 'run.manifest.json' || rel === 'verdict.json') {
            continue; // Sealed root manifests are computed outside the evidence set
          }
          const stat = fs.statSync(full);
          const sha256 = this.computeFileHash(full);
          files.push({
            path: rel,
            sha256,
            bytes: stat.size,
            category: this.categorizeFile(rel),
          });
        }
      }
    };

    walk(this.evidenceDir);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
  }

  /**
   * Closes the evidence directory, computes all file hashes, and writes evidence.manifest.json.
   */
  sealEvidence() {
    if (this.state === 'COLLECTING') {
      this.transitionTo('SANITIZING');
    }
    if (this.state === 'SANITIZING') {
      this.transitionTo('SEALED');
    }

    const files = this.scanFiles();
    const manifest = {
      schema_version: '1.0.0',
      run_id: this.runId,
      sealed_at: new Date().toISOString(),
      files,
    };

    const manifestPath = path.join(this.evidenceDir, 'evidence.manifest.json');
    const content = JSON.stringify(manifest, null, 2) + '\n';
    fs.writeFileSync(manifestPath, content, 'utf8');

    const manifestSha256 = crypto.createHash('sha256').update(content).digest('hex');
    return { manifest, manifestSha256 };
  }

  /**
   * Verifies that the evidence directory matches evidence.manifest.json.
   */
  verifyIntegrity() {
    const manifestPath = path.join(this.evidenceDir, 'evidence.manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return { ok: false, error: 'evidence.manifest.json is missing' };
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      return { ok: false, error: `Invalid evidence.manifest.json: ${err.message}` };
    }

    if (!Array.isArray(manifest.files)) {
      return { ok: false, error: 'evidence.manifest.json missing "files" array' };
    }

    const currentFiles = this.scanFiles();
    const currentMap = new Map(currentFiles.map((f) => [f.path, f]));
    const manifestMap = new Map(manifest.files.map((f) => [f.path, f]));

    const missingFiles = [];
    const modifiedFiles = [];
    const unexpectedFiles = [];

    for (const [p, expected] of manifestMap) {
      const actual = currentMap.get(p);
      if (!actual) {
        missingFiles.push(p);
      } else if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
        modifiedFiles.push({ path: p, expectedSha: expected.sha256, actualSha: actual.sha256 });
      }
    }

    for (const [p] of currentMap) {
      if (!manifestMap.has(p)) {
        unexpectedFiles.push(p);
      }
    }

    if (missingFiles.length > 0 || modifiedFiles.length > 0 || unexpectedFiles.length > 0) {
      return {
        ok: false,
        error: 'Evidence integrity violation detected',
        missingFiles,
        modifiedFiles,
        unexpectedFiles,
      };
    }

    const manifestContent = fs.readFileSync(manifestPath, 'utf8');
    const manifestSha256 = crypto.createHash('sha256').update(manifestContent).digest('hex');

    return { ok: true, manifest, manifestSha256 };
  }
}
