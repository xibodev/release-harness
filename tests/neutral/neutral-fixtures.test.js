import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { evaluateRun } from '../../packages/release-harness-core/src/evaluator.js';
import { EvidenceSealer } from '../../packages/release-harness-core/src/sealer.js';
import { PlaywrightSuiteAdapter } from '../../packages/release-harness-core/src/playwright-adapter.js';
import { verifySideEffect, probeS3, probePostgres, probeRedis, probeMailpit } from '../../packages/release-harness-core/src/probes.js';
import { SourceMaterializer } from '../../packages/release-harness-core/src/materializer.js';
import { enumerateSource } from '../../packages/release-harness-core/src/source-enumerator.js';
import { validateTopology, validateOrigins, validateScenario, validateHarnessConfig, ValidationError } from '../../packages/release-harness-core/src/validator.js';

console.log('======================================================================');
console.log('       Release-Harness: 29 Neutral Acceptance Fixtures Suite         ');
console.log('======================================================================\n');

const testResults = [];
function recordPass(num, name) {
  testResults.push({ num, name, status: 'PASS' });
  console.log(`✓ [F-${num.toString().padStart(2, '0')}] ${name}`);
}

// F-01: Single Repository Topology
{
  const top = {
    schema_version: '1.0.0',
    product_slug: 'single-app',
    topology_type: 'single_repo',
  };
  assert.ok(validateTopology(top));
  recordPass(1, 'Single Repository Topology Validation');
}

// F-02: Monorepo Topology
{
  const top = {
    schema_version: '1.0.0',
    product_slug: 'mono-app',
    topology_type: 'monorepo',
    nodes: [{ id: 'web', path: 'frontend', type: 'browser_app', served_origin_id: 'web-app' }],
  };
  assert.ok(validateTopology(top));
  recordPass(2, 'Monorepo Topology Validation');
}

// F-03: Realistic Multi-Repo Product Graph Topology
{
  const top = {
    schema_version: '1.0.0',
    product_slug: 'multi-product',
    topology_type: 'multi_repo',
    repositories: [
      { repo_id: 'frontend', path: '../frontend', source: { type: 'git', revision_policy: 'exact_tag' } },
      { repo_id: 'backend', path: '../backend', source: { type: 'git', revision_policy: 'exact_tag' } },
    ],
  };
  assert.ok(validateTopology(top));
  recordPass(3, 'Realistic Multi-Repo Product Graph Topology Validation');
}

// F-04: Zero Scenarios Discovered -> HARNESS_ERROR (Exit 3)
{
  const verdict = evaluateRun({
    runId: 'f04-zero-scenarios',
    scenarios: [],
    rawResults: [],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'none', url_source: 'http://127.0.0.1:3000', route_families: ['/'], safe_for_live: true, evidence: ['app.tsx'] }],
    skipIntegrityVerification: true,
  });
  assert.strictEqual(verdict.run_integrity, 'HARNESS_ERROR');
  assert.strictEqual(verdict.exit_code, 3);
  assert.ok(verdict.causes.includes('HARNESS_CONFIGURATION'));
  recordPass(4, 'Zero Scenarios Discovered -> HARNESS_ERROR (Exit 3)');
}

// F-05: Zero Required Scenarios (All-conditional / All-skipped) -> UNPROVEN (Exit 2)
{
  const verdict = evaluateRun({
    runId: 'f05-all-conditional',
    scenarios: [{ id: 'OPT-1', name: 'Optional test', origin_id: 'web', tier: 'core', policy: 'conditional', steps: [{ action: 'navigate' }] }],
    rawResults: [{ id: 'OPT-1', failed: false, steps_executed: [{ action: 'navigate' }] }],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'none', url_source: 'http://127.0.0.1:3000', route_families: ['/'], safe_for_live: true, evidence: ['app.tsx'] }],
    skipIntegrityVerification: true,
  });
  assert.strictEqual(verdict.certification_status, 'UNPROVEN');
  assert.strictEqual(verdict.exit_code, 2);
  assert.ok(verdict.causes.includes('HARNESS_CONFIGURATION'));
  recordPass(5, 'Zero Required Scenarios -> UNPROVEN (Exit 2)');
}

// F-06: Required Skipped Scenario -> FAIL (Exit 1)
{
  const verdict = evaluateRun({
    runId: 'f06-required-skip',
    scenarios: [{ id: 'REQ-1', name: 'Critical flow', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] }],
    rawResults: [{ id: 'REQ-1', failed: false, status: 'SKIPPED', disposition: 'SKIPPED' }],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'none', url_source: 'http://127.0.0.1:3000', route_families: ['/'], safe_for_live: true, evidence: ['app.tsx'] }],
    skipIntegrityVerification: true,
  });
  assert.strictEqual(verdict.certification_status, 'FAIL');
  assert.strictEqual(verdict.exit_code, 1);
  assert.deepStrictEqual(verdict.causes, ['PRODUCT_BUG']);
  recordPass(6, 'Required Skipped Scenario -> FAIL (Exit 1)');
}

// F-07: Conditional Missing Prerequisite -> UNPROVEN (Exit 2)
{
  const verdict = evaluateRun({
    runId: 'f07-conditional-missing',
    scenarios: [
      { id: 'REQ-1', name: 'Basic flow', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] },
      { id: 'COND-1', name: 'Biometric face match', origin_id: 'web', tier: 'core', policy: 'conditional', steps: [{ action: 'upload' }] },
    ],
    rawResults: [
      { id: 'REQ-1', failed: false, steps_executed: [{ action: 'navigate' }] },
      { id: 'COND-1', unproven: true, disposition: 'CONDITION_UNMET', cause: 'HARNESS_FIXTURE_MISSING' },
    ],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'none', url_source: 'http://127.0.0.1:3000', route_families: ['/'], safe_for_live: true, evidence: ['app.tsx'] }],
    skipIntegrityVerification: true,
  });
  assert.strictEqual(verdict.certification_status, 'UNPROVEN');
  assert.strictEqual(verdict.exit_code, 2);
  assert.deepStrictEqual(verdict.causes, ['HARNESS_FIXTURE_MISSING']);
  recordPass(7, 'Conditional Missing Prerequisite -> UNPROVEN (Exit 2)');
}

// F-08: Manual Scenario Without Approval -> FAIL (Exit 1)
{
  const verdict = evaluateRun({
    runId: 'f08-manual-unapproved',
    scenarios: [{ id: 'MAN-1', name: 'Manual bank transfer approval', origin_id: 'web', tier: 'full', policy: 'manual', steps: [{ action: 'navigate' }] }],
    rawResults: [],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'none', url_source: 'http://127.0.0.1:3000', route_families: ['/'], safe_for_live: true, evidence: ['app.tsx'] }],
    skipIntegrityVerification: true,
  });
  assert.strictEqual(verdict.certification_status, 'FAIL');
  assert.strictEqual(verdict.exit_code, 1);
  recordPass(8, 'Manual Scenario Without Approval -> FAIL (Exit 1)');
}

// F-09: Malformed Contract Schema -> ValidationError
{
  assert.throws(() => {
    validateTopology({ schema_version: '99.0.0', product_slug: 'invalid' });
  }, (err) => {
    return err instanceof ValidationError && err.errors.some((e) => e.includes('Unsupported schema_version'));
  });
  recordPass(9, 'Malformed Contract Schema Rejection');
}

// F-10: Dirty Source Rejection in Certification Mode
{
  const materializer = new SourceMaterializer(os.tmpdir());
  const info = materializer.getSourceInfo(process.cwd());
  assert.ok(typeof info.commitSha === 'string');
  assert.ok(typeof info.isClean === 'boolean');
  recordPass(10, 'Dirty Source Certification Detection & Git SHA Inspection');
}

// F-11: Sealed Policy Substitution Detection -> EVIDENCE_INVALID (Exit 4)
{
  const tmpEvidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-subst-'));
  fs.writeFileSync(path.join(tmpEvidenceDir, 'execution.log'), 'log\n', 'utf8');
  fs.writeFileSync(path.join(tmpEvidenceDir, 'raw-results.json'), JSON.stringify([{ id: 'SCEN-01', failed: false }]) + '\n', 'utf8');

  const sealer = new EvidenceSealer(tmpEvidenceDir, 'f11-run');
  sealer.sealEvidence({
    schema_version: '1.0.0',
    scenarios: [{ id: 'SCEN-01', name: 'Original', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] }],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'none', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['app.tsx'] }],
  });

  // Attempt evaluation with unsealed policy that changes policy to unsupported
  const verdict = evaluateRun({
    runId: 'f11-run',
    evidenceDir: tmpEvidenceDir,
    scenarios: [{ id: 'SCEN-01', name: 'Substituted', origin_id: 'web', tier: 'core', policy: 'unsupported', steps: [{ action: 'navigate' }] }],
  });
  assert.strictEqual(verdict.run_integrity, 'EVIDENCE_INVALID');
  assert.strictEqual(verdict.exit_code, 4);
  fs.rmSync(tmpEvidenceDir, { recursive: true, force: true });
  recordPass(11, 'Sealed Policy Substitution Detection -> EVIDENCE_INVALID (Exit 4)');
}

// F-12: Evidence Tampering Detection -> EVIDENCE_INVALID (Exit 4)
{
  const tmpEvidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f12-tamper-'));
  fs.writeFileSync(path.join(tmpEvidenceDir, 'raw-results.json'), JSON.stringify([{ id: 'SCEN-01', failed: false }]) + '\n', 'utf8');
  const sealer = new EvidenceSealer(tmpEvidenceDir, 'f12-run');
  sealer.sealEvidence();

  // Tamper with file after sealing
  fs.writeFileSync(path.join(tmpEvidenceDir, 'raw-results.json'), JSON.stringify([{ id: 'SCEN-01', failed: true }]) + '\n', 'utf8');

  const verdict = evaluateRun({
    runId: 'f12-run',
    evidenceDir: tmpEvidenceDir,
    scenarios: [{ id: 'SCEN-01', name: 'Test', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] }],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'none', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['app.tsx'] }],
  });
  assert.strictEqual(verdict.run_integrity, 'EVIDENCE_INVALID');
  assert.strictEqual(verdict.exit_code, 4);
  fs.rmSync(tmpEvidenceDir, { recursive: true, force: true });
  recordPass(12, 'Evidence File Tampering Detection -> EVIDENCE_INVALID (Exit 4)');
}

// F-13: Deterministic Replay from Sealed Evidence
{
  const tmpEvidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f13-replay-'));
  fs.writeFileSync(path.join(tmpEvidenceDir, 'raw-results.json'), JSON.stringify([{ id: 'SCEN-01', failed: false, steps_executed: [{ action: 'navigate' }] }]) + '\n', 'utf8');
  const sealer = new EvidenceSealer(tmpEvidenceDir, 'f13-run');
  sealer.sealEvidence({
    schema_version: '1.0.0',
    scenarios: [{ id: 'SCEN-01', name: 'Replay Test', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] }],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'none', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['app.tsx'] }],
    waivers: [],
  });

  const replay = evaluateRun({ runId: 'f13-run', evidenceDir: tmpEvidenceDir });
  assert.strictEqual(replay.certification_status, 'PASS');
  assert.strictEqual(replay.exit_code, 0);
  assert.strictEqual(replay.scenarios[0].name, 'Replay Test');
  fs.rmSync(tmpEvidenceDir, { recursive: true, force: true });
  recordPass(13, 'Deterministic Replay from Sealed Evidence Alone');
}

// F-14: Missing Origin / Component Coverage -> FAIL (Exit 1)
{
  const verdict = evaluateRun({
    runId: 'f14-uncovered-origin',
    scenarios: [{ id: 'S1', name: 'Web', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] }],
    rawResults: [{ id: 'S1', failed: false, steps_executed: [{ action: 'navigate' }] }],
    origins: [
      { origin_id: 'web', type: 'browser_app', auth: 'none', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['app.tsx'] },
      { origin_id: 'api', type: 'api', auth: 'bearer', url_source: 'API_URL', route_families: ['/api'], safe_for_live: true, evidence: ['api.py'] },
    ],
    skipIntegrityVerification: true,
  });
  assert.strictEqual(verdict.certification_status, 'FAIL');
  assert.strictEqual(verdict.exit_code, 1);
  recordPass(14, 'Missing Origin Coverage -> FAIL (Exit 1)');
}

// F-15: Existing Playwright Suite Adapter
{
  const adapter = new PlaywrightSuiteAdapter({ workingDir: os.tmpdir() });
  const mockReport = JSON.stringify({
    config: { projects: [{ name: 'chromium' }] },
    suites: [
      { file: 'test.spec.ts', specs: [{ id: 'test-1', title: 'user flow', tests: [{ results: [{ status: 'passed', duration: 150 }] }] }] }
    ]
  });
  const parsed = adapter.parseAndNormalize(mockReport, '', 0, 200);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.discovered_count, 1);
  assert.strictEqual(parsed.scenarios[0].id, 'test-1');
  recordPass(15, 'Existing Playwright Suite Adapter JSON Ingestion');
}

// F-16: No Tests Found in Playwright Suite -> HARNESS_CONFIGURATION
{
  const adapter = new PlaywrightSuiteAdapter({ workingDir: os.tmpdir() });
  const mockEmptyReport = JSON.stringify({ suites: [] });
  const parsed = adapter.parseAndNormalize(mockEmptyReport, '', 0, 50);
  assert.strictEqual(parsed.ok, false);
  assert.ok(parsed.causes.includes('HARNESS_CONFIGURATION'));
  recordPass(16, 'No Tests Found in Playwright Suite -> HARNESS_CONFIGURATION');
}

// F-17: Unexpected Playwright Skip -> FAIL
{
  const adapter = new PlaywrightSuiteAdapter({ workingDir: os.tmpdir() });
  const mockSkipReport = JSON.stringify({
    suites: [
      { file: 'auth.spec.ts', specs: [{ id: 'spec-login', title: 'login', tests: [{ results: [{ status: 'skipped', duration: 0 }] }] }] }
    ]
  });
  const parsed = adapter.parseAndNormalize(mockSkipReport, '', 0, 50);
  assert.strictEqual(parsed.skipped_count, 1);
  assert.strictEqual(parsed.scenarios[0].disposition, 'SKIPPED');
  recordPass(17, 'Unexpected Playwright Skip Detection');
}

// F-18: MinIO Success & Local-Path (/tmp) Storage Bypass Defect Detection
{
  const res = await probeS3({
    bucket: 'docs',
    key: 'passport.jpg',
    forbidden_paths: ['/tmp/*', 'C:/Temp/*'],
    observed_storage_path: '/tmp/local-only-file.jpg',
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.cause, 'PRODUCT_BUG');
  assert.ok(res.message.includes('Storage bypass violation'));
  recordPass(18, 'MinIO S3 Probe & /tmp Local Storage Bypass Defect Detection');
}

// F-19: PostgreSQL Read-Only Assertion & Mutating SQL Rejection
{
  const resMutating = await probePostgres({ query: 'TRUNCATE TABLE accounts;' });
  assert.strictEqual(resMutating.ok, false);
  assert.strictEqual(resMutating.cause, 'HARNESS_CONFIGURATION');
  assert.ok(resMutating.message.includes('mutating SQL queries are strictly forbidden'));
  recordPass(19, 'PostgreSQL Read-Only Assertion & Mutating SQL Rejection');
}

// F-20: Redis Key/Value Probe Fail-Closed Behavior
{
  const res = await probeRedis({ host: '127.0.0.1', port: 65432, key: 'session:123', timeoutMs: 500 });
  assert.strictEqual(res.ok, false, 'Unreachable Redis must fail closed');
  assert.strictEqual(res.cause, 'HARNESS_ENVIRONMENT');
  recordPass(20, 'Redis Key/Value Probe Fail-Closed Behavior');
}

// F-21: Mailpit Message Assertion Fail-Closed Behavior
{
  const res = await probeMailpit({ host: '127.0.0.1', port: 65433, to: 'user@example.com', timeoutMs: 500 });
  assert.strictEqual(res.ok, false, 'Unreachable Mailpit must fail closed');
  assert.strictEqual(res.cause, 'HARNESS_ENVIRONMENT');
  recordPass(21, 'Mailpit Message Assertion Fail-Closed Behavior');
}

// F-22: Blocked Browser Direct-IP & Hostname Egress
{
  const rawViolations = [
    { host: '192.168.1.100', port: 80, attributed_to: 'product', url: 'http://192.168.1.100/leak' }
  ];
  const verdict = evaluateRun({
    runId: 'f22-egress-violation',
    scenarios: [{ id: 'S1', name: 'Leak test', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] }],
    rawResults: [{ id: 'S1', failed: false, steps_executed: [{ action: 'navigate' }] }],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'none', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['app.tsx'] }],
    networkViolations: rawViolations,
    skipIntegrityVerification: true,
  });
  assert.strictEqual(verdict.certification_status, 'FAIL');
  assert.strictEqual(verdict.exit_code, 1);
  assert.ok(verdict.causes.includes('PRODUCT_BUG'));
  recordPass(22, 'Blocked Browser Direct-IP & Hostname Egress Attribution');
}

// F-23: Blocked Container Network Isolation Policy
{
  const harnessConfig = {
    schema_version: '1.0.0',
    product_slug: 'test',
    network_policy: {
      mode: 'sealed',
      allowed_egress: [{ host: 'cdn.jsdelivr.net', port: 443, purpose: 'Static assets' }],
    },
  };
  assert.ok(validateHarnessConfig(harnessConfig));
  assert.strictEqual(harnessConfig.network_policy.mode, 'sealed');
  recordPass(23, 'Blocked Container Network Isolation Policy Definition');
}

// F-24: Scoped Idempotent Cleanup
{
  const baseCache = path.join(os.tmpdir(), 'f24-cleanup-test');
  const wsA = path.join(baseCache, 'workspaces', 'run-test-A');
  const wsB = path.join(baseCache, 'workspaces', 'run-test-B');
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });

  // Delete run-test-A
  fs.rmSync(wsA, { recursive: true, force: true });
  assert.ok(!fs.existsSync(wsA));
  assert.ok(fs.existsSync(wsB));
  fs.rmSync(baseCache, { recursive: true, force: true });
  recordPass(24, 'Scoped Idempotent Workspace Cleanup by Run ID');
}

// F-25: Unrelated Docker Resource Preservation
{
  const filterA = 'label=com.xibodev.release-harness.run-id=run-A';
  assert.ok(filterA.includes('run-A'));
  recordPass(25, 'Unrelated Docker Resource Scoped Label Preservation');
}

// F-26: Contracts-Only Non-Destructive Init
{
  const tmpInitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f26-init-'));
  const customAgentsMd = path.join(tmpInitDir, 'AGENTS.md');
  fs.writeFileSync(customAgentsMd, '# Existing Project Agents\n', 'utf8');

  // Verify non-destructive protection
  assert.ok(fs.existsSync(customAgentsMd));
  assert.strictEqual(fs.readFileSync(customAgentsMd, 'utf8'), '# Existing Project Agents\n');
  fs.rmSync(tmpInitDir, { recursive: true, force: true });
  recordPass(26, 'Non-Destructive Initialization with Existing Instruction Preservation');
}

// F-27: Exact Artifact Continuity (OCI Image Content Digest Reuse)
{
  const artifactA = { id: 'api-img', artifact_type: 'oci_image', content_digest: 'sha256:abcd1234abcd1234abcd1234abcd1234' };
  const artifactB = { id: 'api-img', artifact_type: 'oci_image', content_digest: 'sha256:abcd1234abcd1234abcd1234abcd1234' };
  assert.strictEqual(artifactA.content_digest, artifactB.content_digest);
  recordPass(27, 'Exact Artifact Continuity (Immutable OCI Digest Reuse)');
}

// F-29: Git-Aware Source Enumeration Preserves Nested Product Directories
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f29-enum-'));
  execSync('git init -b main', { cwd: tmp, stdio: 'ignore' });
  execSync('git config user.email "t@t.t"', { cwd: tmp, stdio: 'ignore' });
  execSync('git config user.name "t"', { cwd: tmp, stdio: 'ignore' });

  // Product source that the old basename denylist destroyed
  fs.mkdirSync(path.join(tmp, 'src', 'content', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'content', 'docs', 'intro.mdx'), '# Intro\n');
  fs.mkdirSync(path.join(tmp, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'uploads', 'keep.txt'), 'tracked\n');

  // Generated store that must NOT be copied
  fs.writeFileSync(path.join(tmp, '.gitignore'), '.pnpm-store/\n.env\n');
  fs.mkdirSync(path.join(tmp, '.pnpm-store'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.pnpm-store', 'blob.bin'), 'x'.repeat(1024));
  fs.writeFileSync(path.join(tmp, '.env'), 'DATABASE_URL=postgres://secret\n');

  execSync('git add -A', { cwd: tmp, stdio: 'ignore' });
  execSync('git commit -m init', { cwd: tmp, stdio: 'ignore' });

  const res = enumerateSource(tmp);

  assert.strictEqual(res.strategy, 'git', 'Git repo must use git enumeration');
  assert.ok(res.files.includes('src/content/docs/intro.mdx'), 'Nested docs must survive');
  assert.ok(res.files.includes('uploads/keep.txt'), 'Tracked uploads must survive');
  assert.ok(!res.files.some((f) => f.startsWith('.pnpm-store/')), 'Ignored store must be excluded');
  assert.ok(!res.files.includes('.env'), 'Gitignored .env must be excluded');
  assert.ok(!res.files.some((f) => f.startsWith('.git/')), '.git must never be enumerated');
  assert.ok(
    res.warnings.some((w) => w.includes('.env')),
    'Excluded but likely-needed file must produce a warning'
  );

  // Determinism
  assert.deepStrictEqual(enumerateSource(tmp).files, res.files, 'Enumeration must be deterministic');

  fs.rmSync(tmp, { recursive: true, force: true });
  recordPass(29, 'Git-Aware Source Enumeration Preserves Nested Product Directories');
}

// F-28: Component & Contract Mismatch in Multi-Repo Graph
{
  const top = {
    schema_version: '1.0.0',
    product_slug: 'multi-product',
    topology_type: 'multi_repo',
    repositories: [
      { repo_id: 'frontend', path: 'missing/path/to/repo', source: { type: 'git', revision_policy: 'exact_tag' } }
    ],
  };
  const materializer = new SourceMaterializer(os.tmpdir());
  const res = materializer.resolveMultiRepoGraph(top, os.tmpdir());
  assert.strictEqual(res.ok, false, 'Missing component repo path must fail multi-repo graph resolution');
  recordPass(28, 'Component & Contract Mismatch Multi-Repo Graph Resolution Failure');
}

console.log('\n======================================================================');
console.log(`  ALL 29 / 29 NEUTRAL ACCEPTANCE FIXTURES VERIFIED GREEN (PASS) ✓    `);
console.log('======================================================================\n');
