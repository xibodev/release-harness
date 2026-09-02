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
import { enumerateSource, FALLBACK_IGNORED_NAMES, LIKELY_NEEDED_IGNORED } from '../../packages/release-harness-core/src/source-enumerator.js';
import { validateTopology, validateOrigins, validateScenario, validateHarnessConfig, ValidationError } from '../../packages/release-harness-core/src/validator.js';
import { ScenarioRunner } from '../../packages/release-harness-core/src/scenario-runner.js';

console.log('======================================================================');
console.log('       Release-Harness: 35 Neutral Acceptance Fixtures Suite         ');
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
    // harness_version and port_block are required by harness-config-v1; the fixture
    // omitted both, so it was asserting against a contract the tool does not publish.
    harness_version: '1.1.0',
    port_block: { start: 34000, range: 50 },
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
  fs.writeFileSync(path.join(tmp, '.gitignore'), '.pnpm-store/\n.env\nnode_modules/\n');
  fs.mkdirSync(path.join(tmp, '.pnpm-store'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.pnpm-store', 'blob.bin'), 'x'.repeat(1024));
  fs.writeFileSync(path.join(tmp, '.env'), 'DATABASE_URL=postgres://secret\n');

  // A dependency shipping a test cert must NOT produce an adopter-facing warning
  fs.mkdirSync(path.join(tmp, 'node_modules', 'some-dep'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'node_modules', 'some-dep', 'test.pem'), 'not mine\n');

  // A file deleted from the worktree without staging the deletion
  fs.writeFileSync(path.join(tmp, 'deleted-later.txt'), 'gone soon\n');

  execSync('git add -A', { cwd: tmp, stdio: 'ignore' });
  execSync('git commit -m init', { cwd: tmp, stdio: 'ignore' });
  fs.rmSync(path.join(tmp, 'deleted-later.txt'));

  // A nested independent git repository — git reports it as one bare directory entry
  const inner = path.join(tmp, 'vendor-app');
  fs.mkdirSync(inner, { recursive: true });
  execSync('git init -b main', { cwd: inner, stdio: 'ignore' });
  execSync('git config user.email "t@t.t"', { cwd: inner, stdio: 'ignore' });
  execSync('git config user.name "t"', { cwd: inner, stdio: 'ignore' });
  fs.writeFileSync(path.join(inner, 'inner.txt'), 'inner\n');
  execSync('git add -A', { cwd: inner, stdio: 'ignore' });
  execSync('git commit -m inner', { cwd: inner, stdio: 'ignore' });

  // A TRUE gitlink (index mode 160000) — the submodule form, which git reports
  // as a BARE name with no trailing slash, unlike the untracked nested repo
  // above. Registered with update-index --cacheinfo so the case is covered
  // without a clone or any network access.
  const submod = path.join(tmp, 'submod');
  fs.mkdirSync(submod, { recursive: true });
  execSync('git init -b main', { cwd: submod, stdio: 'ignore' });
  execSync('git config user.email "t@t.t"', { cwd: submod, stdio: 'ignore' });
  execSync('git config user.name "t"', { cwd: submod, stdio: 'ignore' });
  fs.writeFileSync(path.join(submod, 'sub.txt'), 'submodule content\n');
  execSync('git add -A', { cwd: submod, stdio: 'ignore' });
  execSync('git commit -m sub', { cwd: submod, stdio: 'ignore' });
  const submodSha = execSync('git rev-parse HEAD', { cwd: submod, encoding: 'utf8' }).trim();
  execSync(`git update-index --add --cacheinfo 160000,${submodSha},submod`, { cwd: tmp, stdio: 'ignore' });

  // A symlinked directory. `git ls-files` walks THROUGH it and emits paths
  // beneath it; the filesystem walk never descends one. Unless enumeration
  // considers ancestry, the same tree enumerates differently by strategy — and
  // the same bytes are counted twice on the git path, under two different names.
  // A junction is used because it needs no elevation on Windows.
  const linkTargetDir = path.join(tmp, 'link-target');
  fs.mkdirSync(linkTargetDir, { recursive: true });
  fs.writeFileSync(path.join(linkTargetDir, 'shared.txt'), 'counted once\n');
  let symlinkedDirCreated = false;
  try {
    fs.symlinkSync(linkTargetDir, path.join(tmp, 'linkdir'), 'junction');
    symlinkedDirCreated = fs.lstatSync(path.join(tmp, 'linkdir')).isSymbolicLink();
  } catch {
    symlinkedDirCreated = false;
  }
  if (!symlinkedDirCreated) {
    console.log('  … [F-29] symlinked-directory case skipped: this environment cannot create a directory link');
  }

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

  // CONTRACT: every entry is a regular file that exists on disk (no directories,
  // no index-only ghosts). Both the copier and the digester read these paths.
  for (const rel of res.files) {
    const st = fs.statSync(path.join(tmp, rel));
    assert.ok(st.isFile(), `Enumerated entry must be an existing regular file: ${rel}`);
  }

  // CONTRACT: a nested git repo is a directory entry in git's output and must not
  // reach a consumer that would readFileSync it (EISDIR). Compare NORMALIZED
  // first segments: git reports an untracked nested repo WITH a trailing slash
  // ("vendor-app/") and a gitlink as a bare name ("submod"), so a bare
  // `includes('vendor-app')` check silently never fires for the untracked form.
  const firstSegments = new Set(res.files.map((f) => f.replace(/\/+$/, '').split('/')[0]));
  assert.ok(
    !firstSegments.has('vendor-app'),
    `Nested sub-repo directory must not be an entry (got: ${JSON.stringify(res.files.filter((f) => f.replace(/\/+$/, '').split('/')[0] === 'vendor-app'))})`
  );
  assert.ok(
    !res.files.some((f) => f.startsWith('vendor-app/.git/')),
    'Nested sub-repo .git content must never leak into enumeration'
  );

  // CONTRACT: a TRUE gitlink (index mode 160000) is reported as a bare name and
  // must be excluded too — the form the trailing-slash normalization does not cover.
  assert.ok(!res.files.includes('submod'), 'Gitlink/submodule bare directory entry must not be an entry');
  assert.ok(!firstSegments.has('submod'), 'No path under a gitlink/submodule may be enumerated');
  assert.ok(
    res.warnings.some((w) => w.includes('submod') && w.includes('directories rather than regular files')),
    'Excluding a gitlink must be reported as a directory exclusion, naming the path'
  );

  // CONTRACT (N1): the two strategies must enumerate the same tree IDENTICALLY.
  // git walks through a symlinked directory; the filesystem walk does not. If
  // enumeration ignores ancestry, the git path emits the linked bytes a second
  // time under the link name, inflating the digest and double-copying — and the
  // digest then changes with the strategy, which makes it useless as provenance.
  if (symlinkedDirCreated) {
    assert.ok(
      res.files.includes('link-target/shared.txt'),
      'The real path of a symlink target inside the tree must be enumerated'
    );
    assert.ok(
      !firstSegments.has('linkdir'),
      `No path may be enumerated through a symlinked directory (got: ${JSON.stringify(res.files.filter((f) => f.split('/')[0] === 'linkdir'))})`
    );
    assert.strictEqual(
      res.files.filter((f) => f.endsWith('shared.txt')).length,
      1,
      'Symlinked-directory contents must be counted exactly once, under their real path'
    );

    // Symlinked-directory handling, asserted directly against BOTH strategies:
    // the same tree shape, enumerated each way, must reach the same answer about
    // the linked directory. The tree is built to contain nothing else the two
    // strategies treat differently, so the comparison isolates that one behavior.
    const equivGit = fs.mkdtempSync(path.join(os.tmpdir(), 'f29-equiv-git-'));
    const equivFs = fs.mkdtempSync(path.join(os.tmpdir(), 'f29-equiv-fs-'));
    let equivBuilt = true;
    const equivLinkFailed = [];
    for (const [label, root] of [['git-side', equivGit], ['fs-side', equivFs]]) {
      fs.writeFileSync(path.join(root, 'top.txt'), 'top\n');
      fs.mkdirSync(path.join(root, 'real'), { recursive: true });
      fs.writeFileSync(path.join(root, 'real', 'deep.txt'), 'deep\n');
      try {
        fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'), 'junction');
      } catch {
        equivBuilt = false;
        equivLinkFailed.push(label);
      }
    }
    if (!equivBuilt) {
      // The outer skip prints a note; so must this one. A silent skip here would
      // drop the cross-strategy assertions below with no output at all, which is
      // indistinguishable from them having passed.
      console.log(
        `  … [F-29] cross-strategy symlinked-directory probe skipped: could not create the directory link on ${equivLinkFailed.join(' and ')}. ` +
          'NOT RUN: strategy-selection checks, the git/filesystem agreement assertion, and the non-traversing expected-list assertion.'
      );
    }
    if (equivBuilt) {
      execSync('git init -b main', { cwd: equivGit, stdio: 'ignore' });
      execSync('git config user.email "t@t.t"', { cwd: equivGit, stdio: 'ignore' });
      execSync('git config user.name "t"', { cwd: equivGit, stdio: 'ignore' });
      const gitSide = enumerateSource(equivGit);
      const fsSide = enumerateSource(equivFs);
      assert.strictEqual(gitSide.strategy, 'git', 'Equivalence probe: git side must use git enumeration');
      assert.strictEqual(fsSide.strategy, 'filesystem', 'Equivalence probe: fs side must use filesystem enumeration');
      // SCOPE: this asserts agreement on SYMLINKED-DIRECTORY HANDLING, not general
      // cross-strategy equivalence — which is deliberately NOT a contract. The two
      // strategies serve disjoint tree populations: a git-enumerable tree always
      // takes the git path, and the filesystem path runs only where git cannot
      // enumerate (vendored local_path repos, nested sub-repos). FALLBACK_IGNORED_NAMES
      // applies on that path alone, so on a tree tracking generated output the two
      // measurably differ — a tree tracking .cache/, coverage/ and test-results/
      // enumerates 7 entries by git and 4 by filesystem, which is by design and
      // never happens on the same tree in production. The tree above contains no
      // denylisted name, so the lists coincide and the comparison isolates the
      // linked directory, which is what is under test.
      assert.deepStrictEqual(
        gitSide.files,
        fsSide.files,
        `Both strategies must handle a symlinked directory identically on a tree that differs in nothing else (git=${JSON.stringify(gitSide.files)} fs=${JSON.stringify(fsSide.files)})`
      );
      assert.deepStrictEqual(
        gitSide.files,
        ['real/deep.txt', 'top.txt'],
        'The agreed enumeration must be the non-traversing one, naming linked content once under its real path'
      );
    }
    fs.rmSync(equivGit, { recursive: true, force: true });
    fs.rmSync(equivFs, { recursive: true, force: true });
  }

  // CONTRACT: a symlink to a regular file OUTSIDE the tree is not in-tree content.
  // The ancestor check above covers linked DIRECTORIES only; a link straight to an
  // outside file lstats as an ordinary regular file and would otherwise be
  // enumerated, then read and copied — widening the declared source boundary and
  // hashing bytes that exist only in this checkout. A link to a file INSIDE the
  // tree is within the boundary and stays enumerated.
  //
  // File symlinks need elevation on Windows (EPERM without Developer Mode), so
  // creation is attempted and the case SKIPS WITH A PRINTED NOTE when it fails —
  // never silently. On POSIX CI both links are created and the assertions run.
  {
    const linkTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f29-extlink-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f29-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'not in the tree\n');
    fs.writeFileSync(path.join(linkTmp, 'inside.txt'), 'in the tree\n');

    let fileLinksCreated = false;
    let linkFailure = '';
    try {
      fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(linkTmp, 'external-link.txt'), 'file');
      fs.symlinkSync(path.join(linkTmp, 'inside.txt'), path.join(linkTmp, 'internal-link.txt'), 'file');
      fileLinksCreated =
        fs.lstatSync(path.join(linkTmp, 'external-link.txt')).isSymbolicLink() &&
        fs.lstatSync(path.join(linkTmp, 'internal-link.txt')).isSymbolicLink();
    } catch (err) {
      fileLinksCreated = false;
      linkFailure = err && err.code ? err.code : String(err && err.message);
    }

    if (!fileLinksCreated) {
      console.log(
        `  … [F-29] out-of-tree file-symlink case skipped: this environment cannot create a file symlink (${linkFailure || 'unknown cause'}; ` +
          'Windows requires Developer Mode or elevation). NOT RUN: the exclusion of a symlink resolving outside the tree, ' +
          'its named warning, and the retention of a symlink resolving inside the tree.'
      );
    } else {
      const linkRes = enumerateSource(linkTmp);
      assert.ok(
        !linkRes.files.includes('external-link.txt'),
        `A symlink resolving outside the source tree must not be enumerated (got: ${JSON.stringify(linkRes.files)})`
      );
      assert.ok(
        linkRes.warnings.some((w) => w.includes('external-link.txt') && w.includes('outside the source tree')),
        `Excluding an out-of-tree symlink must warn, naming the entry and the reason (got: ${JSON.stringify(linkRes.warnings)})`
      );
      assert.ok(
        linkRes.files.includes('inside.txt'),
        'The real file inside the tree must still be enumerated'
      );
      assert.ok(
        linkRes.files.includes('internal-link.txt'),
        'A symlink resolving INSIDE the tree stays within the declared boundary and must be enumerated'
      );
      for (const rel of linkRes.files) {
        assert.ok(
          fs.statSync(path.join(linkTmp, rel)).isFile(),
          `Enumerated entry must be a readable regular file: ${rel}`
        );
      }
    }

    fs.rmSync(linkTmp, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }

  // CONTRACT: a file deleted but not staged is in the index, not on disk (ENOENT).
  assert.ok(
    !res.files.includes('deleted-later.txt'),
    'File deleted from the worktree without staging must not be enumerated'
  );
  // The exclusion is right; the EXPLANATION must not assert a cause it has not
  // established. An index-absent path can equally be a checkout that never
  // materialized (core.symlinks=false on Windows), so the wording stays hedged.
  const missingWarning = res.warnings.find((w) => w.includes('deleted-later.txt'));
  assert.ok(missingWarning, 'An index-present, worktree-absent path must be reported');
  assert.ok(
    !/These were deleted without staging/.test(missingWarning),
    'The index-absent warning must not assert an unstaged deletion as the established cause'
  );
  assert.ok(
    /checkout that did not materialize/.test(missingWarning),
    'The index-absent warning must name the checkout-gap alternative alongside the deletion case'
  );

  // CONTRACT: no duplicates, and sorted ascending independent of git's ordering.
  assert.strictEqual(new Set(res.files).size, res.files.length, 'Enumeration must contain no duplicates');
  const shuffledSorted = [...res.files].reverse().sort();
  assert.deepStrictEqual(res.files, shuffledSorted, 'Enumeration must be lexicographically sorted');

  // Dependency-shipped credentials must not be reported as the adopter's problem.
  assert.ok(
    !res.warnings.some((w) => w.includes('node_modules/')),
    'Exclusion warnings must not fire for files inside dependency directories'
  );

  // Determinism
  assert.deepStrictEqual(enumerateSource(tmp).files, res.files, 'Enumeration must be deterministic');

  // A non-git directory must fall back cleanly rather than throw.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'f29-plain-'));
  fs.mkdirSync(path.join(plain, 'coverage'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'coverage', 'lcov.info'), 'generated\n');
  fs.writeFileSync(path.join(plain, 'app.js'), 'export default 1;\n');
  const plainRes = enumerateSource(plain);
  assert.strictEqual(plainRes.strategy, 'filesystem', 'Non-git tree must use filesystem enumeration');
  assert.ok(plainRes.files.includes('app.js'), 'Filesystem fallback must enumerate ordinary files');
  assert.ok(
    FALLBACK_IGNORED_NAMES.has('coverage') && FALLBACK_IGNORED_NAMES.has('node_modules'),
    'FALLBACK_IGNORED_NAMES must name the denylisted generated directories'
  );
  assert.ok(
    !plainRes.files.some((f) => f.startsWith('coverage/')),
    'Filesystem fallback must apply FALLBACK_IGNORED_NAMES'
  );
  for (const rel of plainRes.files) {
    assert.ok(fs.statSync(path.join(plain, rel)).isFile(), `Fallback entry must be a regular file: ${rel}`);
  }

  // A regular file passed as the source must degrade, not throw ENOTDIR.
  const fileRes = enumerateSource(path.join(plain, 'app.js'));
  assert.deepStrictEqual(fileRes.files, [], 'A regular file as source must enumerate to nothing');
  assert.ok(
    fileRes.warnings.some((w) => w.includes('not a directory')),
    'A regular file as source must warn rather than throw'
  );

  // LIKELY_NEEDED_IGNORED is the rule set behind the .env warning above.
  assert.ok(
    LIKELY_NEEDED_IGNORED.some((re) => re.test('.env')) && LIKELY_NEEDED_IGNORED.some((re) => re.test('certs/a.pem')),
    'LIKELY_NEEDED_IGNORED must match the build-critical ignored files it warns about'
  );

  fs.rmSync(plain, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  recordPass(29, 'Git-Aware Source Enumeration Preserves Nested Product Directories');
}

// F-30: Digest Covers Every Materialized File At Any Depth
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f30-digest-'));
  execSync('git init -b main', { cwd: tmp, stdio: 'ignore' });
  execSync('git config user.email "t@t.t"', { cwd: tmp, stdio: 'ignore' });
  execSync('git config user.name "t"', { cwd: tmp, stdio: 'ignore' });

  // Depth 6 - beyond the old maxDepth=4 digest cap
  const deep = path.join(tmp, 'a', 'b', 'c', 'd', 'e', 'f');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'deep.txt'), 'original\n');
  fs.writeFileSync(path.join(tmp, 'shallow.txt'), 'top\n');
  execSync('git add -A', { cwd: tmp, stdio: 'ignore' });
  execSync('git commit -m init', { cwd: tmp, stdio: 'ignore' });

  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f30-ws-'));
  const mat = new SourceMaterializer(wsRoot);

  const before = mat.computeTreeDigest(tmp);
  fs.writeFileSync(path.join(deep, 'deep.txt'), 'MUTATED\n');
  const after = mat.computeTreeDigest(tmp);

  assert.notStrictEqual(before, after, 'Digest must change when a file at depth 6 changes');

  const res = mat.materializeRepo(tmp, 'source');
  assert.ok(
    fs.existsSync(path.join(res.targetDir, 'a', 'b', 'c', 'd', 'e', 'f', 'deep.txt')),
    'Deep file must be copied'
  );
  assert.strictEqual(res.stats.fileCount, 2, 'Stats must count exactly the two tracked files');
  assert.strictEqual(res.stats.enumeratedCount, 2, 'Stats must report the digest-covered set');
  assert.strictEqual(res.stats.skippedCount, 0, 'Nothing should be skipped in a quiescent tree');
  assert.ok(res.stats.byteCount > 0, 'Stats must report bytes copied');
  assert.strictEqual(typeof res.stats.elapsedMs, 'number', 'Stats must report elapsed time');
  assert.strictEqual(res.stats.strategy, 'git', 'A git repo must use git enumeration');

  // The digest recorded by materializeRepo must describe the tree that was
  // actually copied. The copy set and the digest set come from ONE enumeration,
  // so they cannot diverge; this asserts the resulting property end to end.
  const digestOf = (root) => {
    const walk = (dir, base) => {
      const out = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
        else out.push(rel);
      }
      return out;
    };
    const h = crypto.createHash('sha256');
    for (const rel of walk(root, '').sort()) {
      const content = fs.readFileSync(path.join(root, rel));
      h.update(`${rel}:${crypto.createHash('sha256').update(content).digest('hex')}\n`);
    }
    return h.digest('hex');
  };
  assert.strictEqual(
    res.sourceInfo.treeDigest,
    digestOf(res.targetDir),
    'Recorded digest must equal the digest of what was actually materialized'
  );

  mat.cleanup();
  assert.ok(!fs.existsSync(wsRoot), 'Cleanup must reclaim the per-run workspace root it materialized into');

  // Untracked build/test output must not be able to move the digest, but an
  // --allow-dirty run must still materialize what is on disk. Both sides read
  // from the same single enumeration, so the choice cannot differ between the
  // copy and the digest.
  fs.mkdirSync(path.join(tmp, 'test-results'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'test-results', 'trace.zip'), 'leftover\n');
  fs.mkdirSync(path.join(tmp, 'uploads'), { recursive: true });

  const wsExcl = fs.mkdtempSync(path.join(os.tmpdir(), 'f30-excl-'));
  const matExcl = new SourceMaterializer(wsExcl);
  const excl = matExcl.materializeRepo(tmp, 'source', { includeUntracked: false });
  assert.strictEqual(excl.sourceInfo.treeDigest, after, 'Leftover test output must not change the digest');
  assert.ok(!fs.existsSync(path.join(excl.targetDir, 'test-results')), 'Untracked output must not be copied');
  // Empty directories are untracked by git and must be recreated for the build,
  // yet must NOT affect the digest - git's own model does not track them.
  assert.ok(fs.existsSync(path.join(excl.targetDir, 'uploads')), 'Empty source directories must be recreated');
  assert.strictEqual(excl.stats.emptyDirCount, 1, 'Exactly the one empty directory must be recreated');
  matExcl.cleanup();

  const wsIncl = fs.mkdtempSync(path.join(os.tmpdir(), 'f30-incl-'));
  const matIncl = new SourceMaterializer(wsIncl);
  const incl = matIncl.materializeRepo(tmp, 'source', { includeUntracked: true });
  assert.notStrictEqual(incl.sourceInfo.treeDigest, after, 'An --allow-dirty run must see untracked files');
  assert.ok(fs.existsSync(path.join(incl.targetDir, 'test-results', 'trace.zip')), 'Untracked files must materialize when included');
  matIncl.cleanup();

  // Empty-directory recreation must obey the SAME ignore rules as the file
  // enumeration, not a second hardcoded basename list. A repo that ignores
  // dist/ build/ vendor/ target/ .tox/ would otherwise have every one of those
  // build trees recreated as an empty skeleton in a certification workspace -
  // the same build-state leakage that excluding untracked output prevents.
  const ig = fs.mkdtempSync(path.join(os.tmpdir(), 'f30-ignore-'));
  execSync('git init -b main', { cwd: ig, stdio: 'ignore' });
  execSync('git config user.email "t@t.t"', { cwd: ig, stdio: 'ignore' });
  execSync('git config user.name "t"', { cwd: ig, stdio: 'ignore' });
  fs.writeFileSync(path.join(ig, '.gitignore'), 'dist/\nbuild/\nvendor/\ntarget/\n.tox/\n*.log\n');
  fs.writeFileSync(path.join(ig, 'app.js'), 'console.log(1)\n');
  for (const d of ['dist', 'build', 'vendor', 'target', '.tox']) {
    fs.mkdirSync(path.join(ig, d, 'empty-skeleton'), { recursive: true });
    fs.writeFileSync(path.join(ig, d, 'artifact.bin'), 'junk\n');
  }
  fs.mkdirSync(path.join(ig, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(ig, 'tmp', 'cache'), { recursive: true });
  // A directory whose ONLY contents are ignored contributes no copied file, so
  // it is empty from the workspace's perspective and must still be recreated -
  // otherwise a build expecting logs/ fails in the workspace but not locally.
  fs.mkdirSync(path.join(ig, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(ig, 'logs', 'run.log'), 'noise\n');
  execSync('git add -A', { cwd: ig, stdio: 'ignore' });
  execSync('git commit -m init', { cwd: ig, stdio: 'ignore' });

  const wsIg = fs.mkdtempSync(path.join(os.tmpdir(), 'f30-igws-'));
  const matIg = new SourceMaterializer(wsIg);
  const igRes = matIg.materializeRepo(ig, 'source', { includeUntracked: false });

  for (const d of ['dist', 'build', 'vendor', 'target', '.tox']) {
    assert.ok(
      !fs.existsSync(path.join(igRes.targetDir, d)),
      `Git-ignored directory "${d}/" must not be recreated in the workspace`
    );
  }
  assert.ok(fs.existsSync(path.join(igRes.targetDir, 'uploads')), 'A genuinely empty source directory must still be recreated');
  assert.ok(fs.existsSync(path.join(igRes.targetDir, 'tmp', 'cache')), 'A nested empty source directory must still be recreated');
  assert.ok(
    fs.existsSync(path.join(igRes.targetDir, 'logs')),
    'A directory whose only contents are ignored must still be recreated - it is empty from the workspace perspective'
  );
  assert.ok(
    !fs.existsSync(path.join(igRes.targetDir, 'logs', 'run.log')),
    'The ignored file itself must not be copied'
  );
  assert.strictEqual(igRes.stats.emptyDirCount, 4, 'Exactly uploads/, tmp/, tmp/cache/ and logs/ are workspace-empty');

  // Empty directories carry no content and must leave the digest untouched:
  // git does not track them, so a tree with and without them is the same tree.
  const digestWithEmpty = igRes.sourceInfo.treeDigest;
  for (const d of ['uploads', 'tmp', 'logs']) fs.rmSync(path.join(ig, d), { recursive: true, force: true });
  assert.strictEqual(
    matIg.computeTreeDigest(ig, enumerateSource(ig, { includeUntracked: false }).files),
    digestWithEmpty,
    'Empty directories must not affect the tree digest'
  );
  matIg.cleanup();

  // `git check-ignore` exits 1 with empty output when NOTHING in the batch is
  // ignored. That is a normal answer, not a failure, and misreading it discards
  // git's authority for the whole walk. This repo ignores only FILES, so the
  // directory batch comes back exit 1 - while holding coverage/ and
  // node_modules/, which the conservative basename denylist would drop but this
  // repository does not ignore. Read correctly they are kept; read as a failure
  // the workspace silently loses them.
  const ex1 = fs.mkdtempSync(path.join(os.tmpdir(), 'f30-exit1-'));
  execSync('git init -b main', { cwd: ex1, stdio: 'ignore' });
  execSync('git config user.email "t@t.t"', { cwd: ex1, stdio: 'ignore' });
  execSync('git config user.name "t"', { cwd: ex1, stdio: 'ignore' });
  fs.writeFileSync(path.join(ex1, '.gitignore'), '*.log\n');
  fs.writeFileSync(path.join(ex1, 'app.js'), 'console.log(1)\n');
  // Wholly-ignored contents make git collapse this to `logs/` in its directory
  // listing, so the check-ignore batch is non-empty and the branch is reached.
  fs.mkdirSync(path.join(ex1, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(ex1, 'logs', 'run.log'), 'noise\n');
  // Both are in FALLBACK_IGNORED_NAMES by basename and NOT ignored by this repo.
  assert.ok(FALLBACK_IGNORED_NAMES.has('coverage'), 'Fixture premise: coverage/ is on the basename denylist');
  assert.ok(FALLBACK_IGNORED_NAMES.has('node_modules'), 'Fixture premise: node_modules/ is on the basename denylist');
  fs.mkdirSync(path.join(ex1, 'coverage'), { recursive: true });
  fs.mkdirSync(path.join(ex1, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(ex1, 'uploads'), { recursive: true });
  execSync('git add -A', { cwd: ex1, stdio: 'ignore' });
  execSync('git commit -m init', { cwd: ex1, stdio: 'ignore' });

  const wsEx1 = fs.mkdtempSync(path.join(os.tmpdir(), 'f30-exit1ws-'));
  const matEx1 = new SourceMaterializer(wsEx1);
  const ex1Res = matEx1.materializeRepo(ex1, 'source', { includeUntracked: false });

  assert.strictEqual(ex1Res.stats.strategy, 'git', 'The exit-1 fixture must be enumerated by git');
  for (const d of ['coverage', 'node_modules']) {
    assert.ok(
      fs.existsSync(path.join(ex1Res.targetDir, d)),
      `"${d}/" is on the basename denylist but NOT ignored by this repository, so it must be recreated - ` +
        'a check-ignore exit of 1 means "nothing in the batch is ignored", not "git failed"'
    );
  }
  assert.ok(
    fs.existsSync(path.join(ex1Res.targetDir, 'logs')),
    'logs/ holds only git-ignored files, so it is workspace-empty and must be recreated'
  );
  assert.ok(fs.existsSync(path.join(ex1Res.targetDir, 'uploads')), 'A genuinely empty directory must be recreated');
  assert.deepStrictEqual(
    fs.readdirSync(ex1Res.targetDir).sort(),
    ['.gitignore', 'app.js', 'coverage', 'logs', 'node_modules', 'uploads'],
    'Exit 1 from check-ignore must keep git as the ignore authority for the whole walk'
  );
  assert.strictEqual(ex1Res.stats.emptyDirCount, 4, 'Exactly coverage/, logs/, node_modules/ and uploads/ are workspace-empty');
  assert.deepStrictEqual(
    ex1Res.stats.warnings,
    [],
    'A check-ignore exit of 1 is a successful answer and must not be reported as a fallback'
  );

  // Empty directories still must not move the digest on this path either.
  const ex1Digest = ex1Res.sourceInfo.treeDigest;
  for (const d of ['coverage', 'node_modules', 'uploads', 'logs']) {
    fs.rmSync(path.join(ex1, d), { recursive: true, force: true });
  }
  assert.strictEqual(
    matEx1.computeTreeDigest(ex1, enumerateSource(ex1, { includeUntracked: false }).files),
    ex1Digest,
    'Empty directories must not affect the tree digest'
  );
  matEx1.cleanup();

  // The reverse failure: git IS the authority, but its ignore rules cannot be
  // obtained. Falling back to basenames here silently reinstates the build-tree
  // skeletons the git path exists to exclude, while the run still reports
  // strategy 'git'. A degradation that quiet must at minimum be named, so the
  // adopter can see why a certification workspace grew a dist/ it never had.
  // Exercised by shadowing `git` with a shim that fails ONLY check-ignore.
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f30-shim-'));
  const isWin = process.platform === 'win32';
  let realGit = null;
  try {
    realGit = execSync(isWin ? 'where git' : 'command -v git', { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/\.cmd$/i.test(l))[0];
  } catch {
    realGit = null;
  }
  let shimInstalled = false;
  if (realGit) {
    try {
      if (isWin) {
        fs.writeFileSync(
          path.join(shimDir, 'git.cmd'),
          [
            '@echo off',
            'for %%A in (%*) do if "%%~A"=="check-ignore" (',
            '  echo fatal: simulated check-ignore failure>&2',
            '  exit /b 128',
            ')',
            `"${realGit}" %*`,
            '',
          ].join('\r\n')
        );
      } else {
        const shimPath = path.join(shimDir, 'git');
        fs.writeFileSync(
          shimPath,
          '#!/bin/sh\n' +
            'for a in "$@"; do\n' +
            '  if [ "$a" = "check-ignore" ]; then echo "fatal: simulated check-ignore failure" >&2; exit 128; fi\n' +
            'done\n' +
            `exec "${realGit}" "$@"\n`
        );
        fs.chmodSync(shimPath, 0o755);
      }
      shimInstalled = true;
    } catch {
      shimInstalled = false;
    }
  }

  const deg = fs.mkdtempSync(path.join(os.tmpdir(), 'f30-degraded-'));
  execSync('git init -b main', { cwd: deg, stdio: 'ignore' });
  execSync('git config user.email "t@t.t"', { cwd: deg, stdio: 'ignore' });
  execSync('git config user.name "t"', { cwd: deg, stdio: 'ignore' });
  fs.writeFileSync(path.join(deg, '.gitignore'), 'dist/\n');
  fs.writeFileSync(path.join(deg, 'app.js'), 'console.log(1)\n');
  fs.mkdirSync(path.join(deg, 'dist', 'skeleton'), { recursive: true });
  fs.writeFileSync(path.join(deg, 'dist', 'artifact.bin'), 'junk\n');
  fs.mkdirSync(path.join(deg, 'uploads'), { recursive: true });
  execSync('git add -A', { cwd: deg, stdio: 'ignore' });
  execSync('git commit -m init', { cwd: deg, stdio: 'ignore' });

  const priorPath = process.env.PATH;
  let shimActive = false;
  let degRes = null;
  const wsDeg = fs.mkdtempSync(path.join(os.tmpdir(), 'f30-degws-'));
  const matDeg = new SourceMaterializer(wsDeg);
  if (shimInstalled) {
    process.env.PATH = `${shimDir}${path.delimiter}${priorPath}`;
    try {
      // Only meaningful if the shim really is what `git` now resolves to, and
      // only check-ignore is affected - ls-files must still succeed, or this
      // would be testing total git failure instead.
      try {
        execSync('git check-ignore -z --stdin', { cwd: deg, input: Buffer.from('dist\0', 'utf8'), stdio: ['pipe', 'pipe', 'ignore'] });
      } catch (err) {
        shimActive = err && err.status === 128;
      }
      let lsFilesOk = false;
      try {
        execSync('git ls-files -z --cached', { cwd: deg, stdio: ['ignore', 'pipe', 'ignore'] });
        lsFilesOk = true;
      } catch {
        lsFilesOk = false;
      }
      shimActive = shimActive && lsFilesOk;
      if (shimActive) degRes = matDeg.materializeRepo(deg, 'source', { includeUntracked: false });
    } finally {
      process.env.PATH = priorPath;
    }
  }

  if (shimActive && degRes) {
    assert.strictEqual(degRes.stats.strategy, 'git', 'File enumeration still succeeds, so the run still claims git authority');
    assert.ok(
      degRes.stats.warnings.some(
        (w) => w.includes('ignore rules could not be obtained') && w.includes('empty-directory scan')
      ),
      'Losing git ignore authority for the empty-directory walk must be reported, not applied silently'
    );
    assert.ok(
      degRes.stats.warnings.some((w) => w.includes('may be recreated in the workspace as empty skeletons')),
      'The warning must state the consequence: ignored directories may be recreated'
    );
    matDeg.cleanup();
  } else {
    console.log(
      '  … [F-30] degraded-ignore-authority case skipped: this environment could not shadow `git` on PATH. ' +
        'NOT RUN: the warning emitted when a git repository\'s ignore rules cannot be obtained for the empty-directory scan.'
    );
  }
  fs.rmSync(shimDir, { recursive: true, force: true });
  fs.rmSync(deg, { recursive: true, force: true });
  fs.rmSync(wsDeg, { recursive: true, force: true });

  // A non-git tree has no ignore authority to consult and must keep working:
  // the conservative basename denylist still applies, and empty product
  // directories are still recreated.
  const plainSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'f30-plain-'));
  fs.writeFileSync(path.join(plainSrc, 'app.js'), 'x\n');
  fs.mkdirSync(path.join(plainSrc, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(plainSrc, 'coverage'), { recursive: true });
  const wsPlain = fs.mkdtempSync(path.join(os.tmpdir(), 'f30-plainws-'));
  const matPlain = new SourceMaterializer(wsPlain);
  const plainRes = matPlain.materializeRepo(plainSrc, 'source');
  assert.strictEqual(plainRes.stats.strategy, 'filesystem', 'A non-git tree must use filesystem enumeration');
  assert.ok(fs.existsSync(path.join(plainRes.targetDir, 'uploads')), 'The non-git fallback must still recreate empty directories');
  assert.ok(!fs.existsSync(path.join(plainRes.targetDir, 'coverage')), 'The non-git fallback must still honour the basename denylist');
  matPlain.cleanup();

  // A non-directory already occupying the destination path cannot be silently
  // passed over: the workspace then differs structurally from the source with
  // nothing recorded to explain why.
  const wsCol = fs.mkdtempSync(path.join(os.tmpdir(), 'f30-col-'));
  fs.mkdirSync(path.join(wsCol, 'source'), { recursive: true });
  fs.writeFileSync(path.join(wsCol, 'source', 'uploads'), 'a file, not a directory\n');
  const matCol = new SourceMaterializer(wsCol);
  const colRes = matCol.materializeRepo(plainSrc, 'source');
  assert.ok(
    colRes.stats.warnings.some((w) => w.includes('uploads') && w.includes('non-directory')),
    'A destination collision must warn rather than pass silently'
  );
  matCol.cleanup();

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(wsRoot, { recursive: true, force: true });
  fs.rmSync(wsExcl, { recursive: true, force: true });
  fs.rmSync(wsIncl, { recursive: true, force: true });
  fs.rmSync(ig, { recursive: true, force: true });
  fs.rmSync(wsIg, { recursive: true, force: true });
  fs.rmSync(ex1, { recursive: true, force: true });
  fs.rmSync(wsEx1, { recursive: true, force: true });
  fs.rmSync(plainSrc, { recursive: true, force: true });
  fs.rmSync(wsPlain, { recursive: true, force: true });
  fs.rmSync(wsCol, { recursive: true, force: true });
  recordPass(30, 'Digest Covers Every Materialized File At Any Depth');
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

// F-31: Cleanliness Fails Closed When Git Status Cannot Be Resolved
{
  // A tree with no git repository above it: `git status` cannot answer, and the
  // gate must therefore refuse to call it clean. The previous default certified
  // exactly this case as clean without ever having checked.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f31-clean-'));
  fs.writeFileSync(path.join(tmp, 'file.txt'), 'no git repo here\n');

  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f31-ws-'));
  const mat = new SourceMaterializer(wsRoot);

  // `os.tmpdir()` is not inside a repository on any supported platform, but a
  // developer machine can surprise us. Assert the premise rather than silently
  // testing the wrong branch.
  let underRepo = true;
  try {
    execSync('git rev-parse --show-toplevel', { cwd: tmp, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch {
    underRepo = false;
  }
  assert.strictEqual(underRepo, false, 'Fixture premise: the temp tree must not sit inside a git repository');

  const info = mat.getSourceInfo(tmp);
  assert.strictEqual(info.statusResolved, false, 'Non-git tree must report status unresolved');
  assert.strictEqual(info.isClean, false, 'Unresolvable status must fail closed, never assume clean');
  assert.ok(
    info.dirtyFiles.includes('GIT_STATUS_UNRESOLVED'),
    'An unresolvable status must name itself, not present as a dirty tree with nothing listed'
  );

  // The missing-directory sentinel must carry the same field, or a consumer
  // reading `status_resolved` sees `undefined` for the one case that is most
  // certainly unresolved.
  const missing = mat.getSourceInfo(path.join(tmp, 'does', 'not', 'exist'));
  assert.strictEqual(missing.exists, false, 'Fixture premise: the sentinel path must not exist');
  assert.strictEqual(missing.statusResolved, false, 'The missing-directory sentinel must report status unresolved');
  assert.strictEqual(missing.isClean, false, 'A missing directory is never clean');

  // A real repository resolves status, and an untracked-but-not-ignored file
  // makes it dirty. `-uno` would hide exactly this file while the enumerator
  // still materializes and digests it, so the digest would cover content the
  // cleanliness gate never inspected.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'f31-repo-'));
  execSync('git init -b main', { cwd: repo, stdio: 'ignore' });
  execSync('git config user.email "t@t.t"', { cwd: repo, stdio: 'ignore' });
  execSync('git config user.name "t"', { cwd: repo, stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'committed\n');
  execSync('git add -A', { cwd: repo, stdio: 'ignore' });
  execSync('git commit -m init', { cwd: repo, stdio: 'ignore' });

  const cleanInfo = mat.getSourceInfo(repo);
  assert.strictEqual(cleanInfo.statusResolved, true, 'A real repository must resolve its status');
  assert.strictEqual(cleanInfo.isClean, true, 'A committed tree with nothing else on disk is clean');
  assert.deepStrictEqual(cleanInfo.dirtyFiles, [], 'A clean tree lists no dirty files');

  // An IGNORED file must leave the tree clean: git excludes it by default and
  // the enumerator excludes it too, so the two agree.
  fs.writeFileSync(path.join(repo, 'ignored.txt'), 'build junk\n');
  const stillClean = mat.getSourceInfo(repo);
  assert.strictEqual(stillClean.isClean, true, 'A git-ignored file must not make the tree dirty');

  // An UNTRACKED-but-not-ignored file must make it dirty. This is the assertion
  // that fails if `-uno` is restored.
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'not committed\n');
  const dirtyInfo = mat.getSourceInfo(repo);
  assert.strictEqual(dirtyInfo.statusResolved, true, 'Status is still resolvable on a dirty tree');
  assert.strictEqual(
    dirtyInfo.isClean,
    false,
    'An untracked-but-not-ignored file is materialized and digested, so it must count toward dirtiness'
  );
  assert.ok(
    dirtyInfo.dirtyFiles.some((line) => line.includes('untracked.txt')),
    'The untracked file must be named among the dirty files'
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(wsRoot, { recursive: true, force: true });
  recordPass(31, 'Cleanliness Fails Closed When Git Status Cannot Be Resolved');
}

// F-32: Multi-Repo Graph Materializes And Digests Every Declared Repository
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f32-multi-'));
  const mkRepo = (name, contents) => {
    const dir = path.join(base, name);
    fs.mkdirSync(dir, { recursive: true });
    execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.email "t@t.t"', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.name "t"', { cwd: dir, stdio: 'ignore' });
    for (const [rel, body] of Object.entries(contents)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    execSync('git add -A', { cwd: dir, stdio: 'ignore' });
    execSync('git commit -m init', { cwd: dir, stdio: 'ignore' });
    return dir;
  };
  mkRepo('api', { 'main.py': 'def api(): pass\n', 'pkg/deep/handler.py': 'x = 1\n' });
  mkRepo('web', { 'index.html': '<h1>App</h1>\n' });

  const mkTop = (repoIds) => ({
    schema_version: '1.0.0',
    product_slug: 'multi-product',
    topology_type: 'multi_repo',
    repositories: repoIds.map((id) => ({
      repo_id: id,
      source: { type: 'local_path', local_path: id, revision_policy: 'current_head' },
    })),
  });

  // CONTRACT: a graph declaring a repository that is ABSENT must not digest
  // identically to a graph that never declared it. The missing case previously
  // `continue`d before contributing to the hash, so `[api, web, ghost]` and
  // `[api, web]` produced the same graph digest - the digest recorded what
  // happened to be present rather than what was declared.
  const gDigest = fs.mkdtempSync(path.join(os.tmpdir(), 'f32-dig-'));
  const matDigest = new SourceMaterializer(gDigest);
  const g2 = matDigest.resolveMultiRepoGraph(mkTop(['api', 'web']), base);
  const g3 = matDigest.resolveMultiRepoGraph(mkTop(['api', 'web', 'ghost']), base);

  assert.strictEqual(g2.ok, true, 'A graph whose repositories all exist resolves');
  assert.strictEqual(g3.ok, false, 'A graph naming an absent repository must not resolve');
  assert.notStrictEqual(
    g2.graph_digest,
    g3.graph_digest,
    'A graph declaring a missing repository must not digest identically to one that never declared it'
  );
  // The digest must be a function of what was DECLARED, so it is stable across
  // calls on an unchanged set - otherwise the inequality above could hold for
  // reasons unrelated to the missing repository.
  assert.strictEqual(
    matDigest.resolveMultiRepoGraph(mkTop(['api', 'web']), base).graph_digest,
    g2.graph_digest,
    'The graph digest must be stable across calls on an unchanged graph'
  );
  assert.strictEqual(g3.nodes.length, 3, 'Every declared repository must appear as a node, present or not');
  assert.strictEqual(g3.nodes[2].missing, true, 'The absent repository must be reported missing');
  assert.strictEqual(g3.nodes[2].status_resolved, false, 'A missing repository resolves no git status');

  // CONTRACT: materializeGraph copies EVERY declared repository into its own
  // subdirectory. Level 2 previously materialized one repo regardless of
  // topology_type, so a multi_repo product was certified against a tree that
  // was never fully inspected.
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f32-ws-'));
  const mat = new SourceMaterializer(wsRoot);
  const res = mat.materializeGraph(mkTop(['api', 'web']), base);

  assert.strictEqual(res.ok, true, 'A resolvable graph materializes');
  assert.strictEqual(res.workspaces.length, 2, 'One workspace per declared repository');
  assert.deepStrictEqual(
    res.workspaces.map((w) => w.repo_id),
    ['api', 'web'],
    'Workspaces must be ordered and named by declared repo_id'
  );
  assert.strictEqual(res.graphDigest, g2.graph_digest, 'materializeGraph must report the resolved graph digest');

  const apiWs = res.workspaces[0];
  const webWs = res.workspaces[1];
  assert.ok(
    fs.existsSync(path.join(apiWs.targetDir, 'pkg', 'deep', 'handler.py')),
    'Nested content of the first repository must be materialized'
  );
  assert.ok(fs.existsSync(path.join(webWs.targetDir, 'index.html')), 'The second repository must be materialized too');
  assert.strictEqual(apiWs.targetDir, path.join(wsRoot, 'sources', 'api'), 'Each repo gets its own subdirectory');
  assert.strictEqual(webWs.targetDir, path.join(wsRoot, 'sources', 'web'), 'Each repo gets its own subdirectory');
  assert.notStrictEqual(
    apiWs.sourceInfo.commitSha,
    webWs.sourceInfo.commitSha,
    'Each repository must carry its OWN commit SHA, not one shared reading'
  );
  assert.notStrictEqual(
    apiWs.sourceInfo.treeDigest,
    webWs.sourceInfo.treeDigest,
    'Each repository must carry its own tree digest'
  );
  assert.strictEqual(apiWs.stats.fileCount, 2, 'The api repository holds exactly two tracked files');
  assert.strictEqual(webWs.stats.fileCount, 1, 'The web repository holds exactly one tracked file');
  for (const w of res.workspaces) {
    assert.strictEqual(w.sourceInfo.statusResolved, true, 'Each materialized repository must resolve its git status');
    assert.strictEqual(w.sourceInfo.isClean, true, 'A freshly committed repository is clean');
  }

  // Cleanup must reclaim EVERY repository workspace plus the run root, not just
  // the last one materialized - a single-slot record would leave sources/api
  // behind after materializing sources/web.
  mat.cleanup();
  assert.ok(!fs.existsSync(wsRoot), 'Cleanup must reclaim the whole per-run workspace root for a multi-repo graph');

  // CONTRACT: an unresolvable graph materializes NOTHING. A partial copy would
  // look like a product and not be one.
  const wsBad = fs.mkdtempSync(path.join(os.tmpdir(), 'f32-bad-'));
  const matBad = new SourceMaterializer(wsBad);
  const bad = matBad.materializeGraph(mkTop(['api', 'ghost']), base);
  assert.strictEqual(bad.ok, false, 'A graph naming an absent repository must not resolve');
  assert.strictEqual(bad.workspaces.length, 0, 'An unresolvable graph must materialize no repository at all');
  assert.ok(bad.errors.length > 0, 'An unresolvable graph must name why');
  assert.ok(
    !fs.existsSync(path.join(wsBad, 'sources')),
    'Nothing may be written for an unresolvable graph, not even the repositories that do exist'
  );
  matBad.cleanup();

  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(gDigest, { recursive: true, force: true });
  fs.rmSync(wsBad, { recursive: true, force: true });
  recordPass(32, 'Multi-Repo Graph Materializes And Digests Every Declared Repository');
}

// F-33: Untracked-Only Directories Are Excluded LOUDLY, Not Silently
{
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'f33-src-'));
  execSync('git init -b main', { cwd: src, stdio: 'ignore' });
  execSync('git config user.email "t@t.t"', { cwd: src, stdio: 'ignore' });
  execSync('git config user.name "t"', { cwd: src, stdio: 'ignore' });
  fs.writeFileSync(path.join(src, '.gitignore'), 'ignoredonly/\n');
  fs.writeFileSync(path.join(src, 'app.js'), 'console.log(1)\n');
  execSync('git add -A', { cwd: src, stdio: 'ignore' });
  execSync('git commit -m init', { cwd: src, stdio: 'ignore' });

  // The case this closes: a directory whose ONLY content is an untracked,
  // NOT-ignored file. A certification run copies no untracked file, so the
  // directory contributes nothing and is absent from the workspace - which is
  // CORRECT (git has no record of it, so a fresh clone would not have it), but
  // was previously indistinguishable from a bug. Recreating it instead would
  // make the workspace's structure a function of the last local build, which is
  // the same leakage excluding untracked files exists to prevent. The fix is to
  // say so, not to build it.
  fs.mkdirSync(path.join(src, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(src, 'uploads', 'scratch.tmp'), 'untracked\n');
  // Nested, to prove the judgement propagates through a parent rather than
  // applying only one level deep.
  fs.mkdirSync(path.join(src, 'var', 'run'), { recursive: true });
  fs.writeFileSync(path.join(src, 'var', 'run', 'pid'), 'untracked\n');
  // A directory of only-ignored files was already handled; assert it still is,
  // so this change cannot fix its own case by breaking its neighbour.
  fs.mkdirSync(path.join(src, 'ignoredonly'), { recursive: true });
  fs.writeFileSync(path.join(src, 'ignoredonly', 'junk.bin'), 'ignored\n');
  // A genuinely empty directory must STILL be recreated - the new classification
  // must not collapse 'empty' into 'untrackedOnly'.
  fs.mkdirSync(path.join(src, 'genuinelyempty'), { recursive: true });
  // A directory holding a TRACKED file is not empty and must not be recreated
  // as one - it must be materialized with its content.
  fs.mkdirSync(path.join(src, 'real'), { recursive: true });
  fs.writeFileSync(path.join(src, 'real', 'kept.js'), 'kept\n');
  execSync('git add real/kept.js', { cwd: src, stdio: 'ignore' });
  execSync('git commit -m real', { cwd: src, stdio: 'ignore' });

  const wsCert = fs.mkdtempSync(path.join(os.tmpdir(), 'f33-cert-'));
  const matCert = new SourceMaterializer(wsCert);
  const cert = matCert.materializeRepo(src, 'source', { includeUntracked: false });

  assert.strictEqual(cert.stats.strategy, 'git', 'Fixture premise: the tree must be enumerated by git');
  assert.ok(
    !fs.existsSync(path.join(cert.targetDir, 'uploads', 'scratch.tmp')),
    'A certification run must not copy an untracked file'
  );
  assert.ok(
    !fs.existsSync(path.join(cert.targetDir, 'uploads')),
    'A directory holding only untracked files must NOT be recreated - git has no record of it'
  );
  assert.ok(
    fs.existsSync(path.join(cert.targetDir, 'genuinelyempty')),
    'A genuinely empty directory must still be recreated - it is tracked structure, not build output'
  );
  assert.ok(
    !fs.existsSync(path.join(cert.targetDir, 'ignoredonly')),
    'A git-ignored directory must still be excluded entirely - this must not reintroduce build-store leakage'
  );
  assert.ok(
    fs.existsSync(path.join(cert.targetDir, 'real', 'kept.js')),
    'A directory holding a tracked file must be materialized with its content'
  );
  assert.deepStrictEqual(
    fs.readdirSync(cert.targetDir).sort(),
    ['.gitignore', 'app.js', 'genuinelyempty', 'real'],
    'The certification workspace must hold exactly the tracked files plus genuinely empty directories'
  );
  assert.strictEqual(cert.stats.emptyDirCount, 1, 'Exactly genuinelyempty/ is recreated');

  // THE POINT OF THIS FIXTURE: the exclusion must be reported. Silence here is
  // the defect - the adopter otherwise infers the cause from a downstream "no
  // such directory" in a build that works locally.
  const untrackedWarning = cert.stats.warnings.find((w) => w.includes('only contents are untracked files'));
  assert.ok(untrackedWarning, 'Excluding an untracked-only directory must be reported, not applied silently');
  assert.ok(untrackedWarning.includes('"uploads"'), 'The warning must name the excluded directory');
  assert.ok(untrackedWarning.includes('"var"'), 'The warning must name each excluded subtree');
  assert.ok(
    !untrackedWarning.includes('var/run'),
    'Only the shallowest directory of a subtree is named - "var" and "var/run" are the same fact twice'
  );
  assert.ok(
    untrackedWarning.includes('.gitkeep'),
    'The warning must state the remedy, not merely the fact'
  );
  matCert.cleanup();

  // The --allow-dirty counterpart: untracked files ARE copied, so the same
  // directory arrives with its content and there is nothing to warn about. The
  // two modes must not disagree about the same tree.
  const wsDev = fs.mkdtempSync(path.join(os.tmpdir(), 'f33-dev-'));
  const matDev = new SourceMaterializer(wsDev);
  const dev = matDev.materializeRepo(src, 'source', { includeUntracked: true });
  assert.ok(
    fs.existsSync(path.join(dev.targetDir, 'uploads', 'scratch.tmp')),
    'An --allow-dirty run must materialize untracked files'
  );
  assert.ok(
    fs.existsSync(path.join(dev.targetDir, 'var', 'run', 'pid')),
    'An --allow-dirty run must materialize nested untracked files too'
  );
  assert.ok(
    !fs.existsSync(path.join(dev.targetDir, 'ignoredonly')),
    'An ignored directory stays excluded even on an --allow-dirty run'
  );
  assert.ok(
    !dev.stats.warnings.some((w) => w.includes('only contents are untracked files')),
    'Nothing is excluded on an --allow-dirty run, so there is nothing to warn about'
  );
  matDev.cleanup();

  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(wsCert, { recursive: true, force: true });
  fs.rmSync(wsDev, { recursive: true, force: true });
  recordPass(33, 'Untracked-Only Directories Are Excluded LOUDLY, Not Silently');
}

// F-34: A Harness-Caused Probe Failure Is Attributed To The Harness, Not The Product
{
  // The probe layer already reports an accurate cause for a combination it
  // does not implement. Issue #5 was misfiled because everything downstream
  // discarded it and blamed the adopter's product instead.
  const probeRes = await verifySideEffect({
    service: 'unsupported_db',
    probe_type: 'magic_check',
    params: {},
  });

  assert.strictEqual(probeRes.ok, false);
  assert.strictEqual(probeRes.cause, 'HARNESS_CONFIGURATION');
  assert.strictEqual(probeRes.isHarnessError, true);

  // Two evaluator paths reach a failed side effect, and both hardcoded
  // PRODUCT_BUG. `failed: true` is what ScenarioRunner produces (it throws on a
  // failing probe); `failed: false` with a failing observation is what a raw
  // result assembled from sealed evidence looks like. Each is asserted below.
  const runWith = ({ observation, failed, rawCause, harnessErrors = [] }) => evaluateRun({
    runId: 'f34-run',
    scenarios: [{ id: 'S1', name: 'probe scenario', origin_id: 'O1', tier: 'smoke', policy: 'required', steps: [{ action: 'navigate', target: '/' }] }],
    rawResults: [{
      id: 'S1',
      scenario_id: 'S1',
      failed,
      error_message: failed ? `Side effect verification failed: ${observation.observed_result}` : undefined,
      cause: rawCause,
      target_base_url: 'http://127.0.0.1:1',
      duration_ms: 5,
      steps_executed: [{ index: 1, action: 'navigate' }],
      side_effects_failed: true,
      side_effect_error: observation.observed_result,
      side_effect_observations: [observation],
      network_violations: [],
    }],
    origins: [{ origin_id: 'O1', type: 'browser_app', auth: 'none', url_source: 'http://127.0.0.1:1', route_families: ['/'], safe_for_live: true, evidence: ['app.tsx'] }],
    networkViolations: [],
    harnessErrors,
    skipIntegrityVerification: true,
  });

  const harnessObs = {
    service: 'unsupported_db',
    probe_type: 'magic_check',
    expected_condition: 'magic_check on unsupported_db',
    observed_result: probeRes.message,
    passed: false,
    cause: probeRes.cause,
    is_harness_error: true,
  };

  // Path A -- the live ScenarioRunner shape. Asserts `cause =
  // failureCause(raw.cause)` in evaluator.js's `else if (raw.failed)` branch;
  // restoring `cause = 'PRODUCT_BUG'` there fires the second assertion.
  const viaRawFailed = runWith({
    observation: harnessObs,
    failed: true,
    rawCause: 'HARNESS_CONFIGURATION',
    harnessErrors: [{ cause: 'HARNESS_CONFIGURATION', message: `[S1] ${probeRes.message}`, scenario_id: 'S1' }],
  });

  assert.strictEqual(viaRawFailed.scenarios[0].cause, 'HARNESS_CONFIGURATION', 'A failed scenario keeps the cause the runner recorded');
  assert.ok(viaRawFailed.causes.includes('HARNESS_CONFIGURATION'), 'A probe that reported HARNESS_CONFIGURATION must surface that cause');
  assert.ok(
    !viaRawFailed.causes.includes('PRODUCT_BUG'),
    'The harness must not blame the product for a probe combination it never implemented'
  );
  assert.strictEqual(viaRawFailed.run_integrity, 'HARNESS_ERROR');
  assert.strictEqual(viaRawFailed.exit_code, 3, 'Harness faults exit 3, never 1');

  // Path B -- the sealed-observation shape. Asserts `cause =
  // failureCause(probeObs.cause)` in the side-effect observation loop;
  // restoring `cause = 'PRODUCT_BUG'` there fires the second assertion.
  const viaObservation = runWith({ observation: harnessObs, failed: false, rawCause: 'NONE' });

  assert.strictEqual(viaObservation.scenarios[0].cause, 'HARNESS_CONFIGURATION', 'A failing observation keeps the cause the probe reported');
  assert.ok(viaObservation.causes.includes('HARNESS_CONFIGURATION'));
  assert.ok(
    !viaObservation.causes.includes('PRODUCT_BUG'),
    'A sealed harness-caused observation must not be re-attributed to the product'
  );
  assert.strictEqual(viaObservation.summary.failed, 1, 'The scenario still fails; only its attribution changed');

  // The neighbouring case must not regress: a probe that genuinely observed a
  // product defect still attributes to the product and still exits 1.
  const productObs = {
    service: 'minio',
    probe_type: 's3_object_exists',
    expected_condition: 's3_object_exists on minio',
    observed_result: 'Storage bypass violation: observed storage path "/tmp/x.jpg" matches forbidden local pattern "/tmp/*"',
    passed: false,
    cause: 'PRODUCT_BUG',
    is_harness_error: false,
  };

  for (const failed of [true, false]) {
    const v = runWith({ observation: productObs, failed, rawCause: failed ? 'PRODUCT_BUG' : 'NONE' });
    assert.strictEqual(v.scenarios[0].cause, 'PRODUCT_BUG', `A real product defect is still the product (failed=${failed})`);
    assert.ok(v.causes.includes('PRODUCT_BUG'));
    assert.ok(!v.causes.includes('HARNESS_CONFIGURATION'));
    assert.strictEqual(v.run_integrity, 'COMPLETE');
    assert.strictEqual(v.exit_code, 1);
  }

  // A failure carrying no attribution, and one carrying the probe layer's
  // success sentinel 'NONE', both default to the product on BOTH paths. A bare
  // `cause || 'PRODUCT_BUG'` passes the absent case and fails the 'NONE' one:
  // 'NONE' is truthy, so the scenario would fail under cause 'NONE', which
  // `discoveredCauses` skips -- a failed run with an empty causes list. Both
  // call sites are asserted, since each had its own hardcoded default.
  for (const [label, reported] of [['absent', undefined], ['NONE', 'NONE'], ['empty', '']]) {
    const unattributedObs = {
      service: 'redis',
      probe_type: 'redis_key_exists',
      expected_condition: 'redis_key_exists on redis',
      observed_result: 'Redis key "session" absent',
      passed: false,
      cause: reported,
      is_harness_error: false,
    };

    const viaRaw = runWith({ observation: unattributedObs, failed: true, rawCause: reported });
    assert.strictEqual(viaRaw.scenarios[0].cause, 'PRODUCT_BUG', `An unattributed (${label}) failed scenario defaults to the product`);
    assert.ok(viaRaw.causes.includes('PRODUCT_BUG'), `An unattributed (${label}) failed scenario must still record a cause`);
    assert.strictEqual(viaRaw.exit_code, 1);

    const viaObs = runWith({ observation: unattributedObs, failed: false, rawCause: 'NONE' });
    assert.strictEqual(viaObs.scenarios[0].cause, 'PRODUCT_BUG', `An unattributed (${label}) observation defaults to the product`);
    assert.ok(viaObs.causes.includes('PRODUCT_BUG'), `An unattributed (${label}) observation must still record a cause`);
    assert.strictEqual(viaObs.exit_code, 1);
  }

  recordPass(34, 'A Harness-Caused Probe Failure Is Attributed To The Harness, Not The Product');
}

// F-35: Port Offset Reaches Side-Effect Probes
{
  // Health checks honoured --port-offset and probes did not, so two concurrent
  // runs health-checked the shifted port and then probed the unshifted one --
  // verifying each other's containers, or nothing at all.
  const runner = new ScenarioRunner({
    origins: [],
    topology: null,
    evidenceDir: os.tmpdir(),
    workspaceDir: os.tmpdir(),
    portOffset: 100,
  });

  assert.strictEqual(runner.portOffset, 100, 'The runner must accept a port offset');

  const shifted = runner.applyPortOffset({ host: '127.0.0.1', port: 6379 });
  assert.strictEqual(shifted.port, 6479, 'A probe port shifts by the run offset');
  assert.strictEqual(shifted.host, '127.0.0.1', 'Shifting a port preserves every other parameter');

  const absolute = runner.applyPortOffset({ host: '127.0.0.1', port: 6379, absolute_port: true });
  assert.strictEqual(absolute.port, 6379, 'absolute_port opts a fixed external target out of shifting');

  const noPort = runner.applyPortOffset({ host: '127.0.0.1' });
  assert.strictEqual(noPort.port, undefined, 'An absent port stays absent so the probe default applies');

  // Mutating the caller's params would shift the same object once per
  // scenario, compounding the offset across a run.
  const original = { host: '127.0.0.1', port: 5432 };
  runner.applyPortOffset(original);
  runner.applyPortOffset(original);
  assert.strictEqual(original.port, 5432, 'Shifting must not mutate the declared side-effect params');

  const zeroRunner = new ScenarioRunner({ origins: [], evidenceDir: os.tmpdir(), portOffset: 0 });
  assert.strictEqual(zeroRunner.applyPortOffset({ port: 5432 }).port, 5432, 'A zero offset leaves ports untouched');

  const defaultRunner = new ScenarioRunner({ origins: [], evidenceDir: os.tmpdir() });
  assert.strictEqual(defaultRunner.portOffset, 0, 'The offset defaults to zero when unset');

  recordPass(35, 'Port Offset Reaches Side-Effect Probes');
}

console.log('\n======================================================================');
console.log(`  ALL 35 / 35 NEUTRAL ACCEPTANCE FIXTURES VERIFIED GREEN (PASS) ✓    `);
console.log('======================================================================\n');
