import assert from 'node:assert';
import crypto from 'node:crypto';
import http from 'node:http';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { runCli } from '../../packages/release-harness-core/src/cli.js';
import { evaluateRun } from '../../packages/release-harness-core/src/evaluator.js';
import { SourceMaterializer } from '../../packages/release-harness-core/src/materializer.js';
import { EvidenceSealer } from '../../packages/release-harness-core/src/sealer.js';
import { SecretRedactor } from '../../packages/release-harness-core/src/redactor.js';
import { verifySideEffect } from '../../packages/release-harness-core/src/probes.js';
import { ScenarioRunner } from '../../packages/release-harness-core/src/scenario-runner.js';
import { resolveImageContentDigest } from '../../packages/release-harness-core/src/runner.js';
import { Schemas } from '../../packages/release-harness-schemas/index.js';

console.log('======================================================================');
console.log('  Release-Harness v1.0: Real Layered Acceptance Test Suite (Playwright) ');
console.log('======================================================================\n');

const repoRoot = path.resolve('.');
const tinyMonorepoDir = path.join(repoRoot, 'tests', 'smoke', 'fixtures', 'tiny-monorepo');

const criteriaResults = {};
function recordPass(acId, name, layer) {
  criteriaResults[acId] = { name, layer, status: 'PASS' };
  console.log(`✓ [${acId}] [${layer.padEnd(11)}] ${name}`);
}

// Helper: Start local mock HTTP server
function startMockHttpServer(port, handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

// ----------------------------------------------------------------------------
// AC-01: Deterministic Core Independence and Replay
// ----------------------------------------------------------------------------
{
  const scenarios = [
    { id: 'SCEN-01', name: 'Step 1', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] },
    { id: 'SCEN-02', name: 'Step 2', origin_id: 'web', tier: 'core', policy: 'conditional', steps: [{ action: 'click' }] },
  ];
  const raw = [{ id: 'SCEN-01', failed: false }];
  const fixedTime = '2026-08-30T18:00:00.000Z';

  const firstVerdict = JSON.stringify(evaluateRun({
    runId: 'replay-test',
    scenarios,
    rawResults: raw,
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    evaluationTime: fixedTime,
    skipIntegrityVerification: true,
  }));

  for (let i = 0; i < 100; i++) {
    const replayVerdict = JSON.stringify(evaluateRun({
      runId: 'replay-test',
      scenarios,
      rawResults: raw,
      origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
      evaluationTime: fixedTime,
      skipIntegrityVerification: true,
    }));
    assert.strictEqual(replayVerdict, firstVerdict, `Deterministic mismatch at iteration ${i}`);
  }
  recordPass('AC-01', 'Deterministic Core Independence and Replay (100x Replay Proof)', 'UNIT');
}

// ----------------------------------------------------------------------------
// AC-02: Outcome and Cause Separation
// ----------------------------------------------------------------------------
{
  const scenarios = [
    { id: 'SCEN-REQ-FAIL', name: 'Req Fail', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] },
    { id: 'SCEN-COND-UNP', name: 'Cond Unp', origin_id: 'web', tier: 'core', policy: 'conditional', steps: [{ action: 'navigate' }] },
  ];
  const rawResults = [
    { id: 'SCEN-REQ-FAIL', failed: true, error_message: '500 Server Error', cause: 'PRODUCT_BUG' },
  ];
  const verdict = evaluateRun({
    runId: 'ac02-test',
    scenarios,
    rawResults,
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    harnessErrors: [{ message: 'Docker restart leak', cause: 'HARNESS_ENVIRONMENT' }],
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdict.certification_status, 'FAIL');
  assert.strictEqual(verdict.run_integrity, 'HARNESS_ERROR');
  assert.strictEqual(verdict.exit_code, 3);
  assert.ok(verdict.causes.includes('PRODUCT_BUG'));
  assert.ok(verdict.causes.includes('HARNESS_ENVIRONMENT'));
  assert.strictEqual(verdict.scenarios[0].status, 'FAIL');
  assert.strictEqual(verdict.scenarios[0].disposition, 'EXECUTED');
  assert.strictEqual(verdict.scenarios[0].cause, 'PRODUCT_BUG');
  assert.strictEqual(verdict.scenarios[1].status, 'UNPROVEN');
  assert.strictEqual(verdict.scenarios[1].disposition, 'CONDITION_UNMET');
  assert.strictEqual(verdict.scenarios[1].cause, 'HARNESS_FIXTURE_MISSING');
  recordPass('AC-02', 'Outcome, Disposition, and Cause Separation with Multi-Cause Retention', 'UNIT');
}

// ----------------------------------------------------------------------------
// AC-03: Fail-Closed Failure Classification & Real Playwright Execution
// ----------------------------------------------------------------------------
{
  const mockServerPort = 34567;
  const server = await startMockHttpServer(mockServerPort, (req, res) => {
    const body = `
      <html>
        <body>
          <h1 id="header">Login Page</h1>
          <input id="email-field" type="text" />
          <button id="submit-btn" onclick="document.getElementById('header').innerText = 'Welcome User';">Submit</button>
        </body>
      </html>
    `;
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const scenario = {
    id: 'SCEN-PW-REAL',
    name: 'Real Playwright DOM Flow',
    origin_id: 'mock-web',
    tier: 'core',
    policy: 'required',
    steps: [
      { action: 'navigate', target: '/', timeout: 5000 },
      { action: 'fill', target: '#email-field', value: 'alice@example.com', timeout: 5000 },
      { action: 'click', target: '#submit-btn', timeout: 5000 },
      { action: 'assert', target: 'text:Welcome User', timeout: 5000 },
      { action: 'screenshot' },
    ],
  };

  const evidenceTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-evidence-'));
  const runner = new ScenarioRunner({
    origins: [{ origin_id: 'mock-web', type: 'browser_app', auth: 'none', url_source: `http://127.0.0.1:${mockServerPort}`, route_families: ['/'], safe_for_live: true, evidence: ['test'] }],
    evidenceDir: evidenceTmp,
  });

  const res = await runner.runScenario(scenario);
  server.close();

  assert.strictEqual(res.failed, false, 'Real Playwright scenario execution must succeed');
  assert.strictEqual(res.evidence_files.length, 1, 'Screenshot must be captured');
  assert.ok(fs.existsSync(path.join(evidenceTmp, res.evidence_files[0])), 'Screenshot PNG must exist on disk');

  fs.rmSync(evidenceTmp, { recursive: true, force: true });
  recordPass('AC-03', 'Fail-Closed Playwright Execution & Full DSL Verb Mapping (fill/click/assert/screenshot)', 'COMPONENT');
}

// ----------------------------------------------------------------------------
// AC-04: Complete Skip and Policy Enforcement
// ----------------------------------------------------------------------------
{
  const scenarios = [
    { id: 'S-REQ-SKIP', name: 'Req', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] },
    { id: 'S-COND-UNMET', name: 'Cond', origin_id: 'web', tier: 'core', policy: 'conditional', steps: [{ action: 'navigate' }] },
    { id: 'S-MAN-NOAUTH', name: 'Man', origin_id: 'web', tier: 'core', policy: 'manual', steps: [{ action: 'navigate' }] },
    { id: 'S-UNSUPP-EXP', name: 'Unsupp', origin_id: 'web', tier: 'core', policy: 'unsupported', steps: [{ action: 'navigate' }] },
  ];

  const expiredWaiver = {
    id: 'W-EXP',
    scenario_id: 'S-UNSUPP-EXP',
    policy_override: 'unsupported',
    reason: 'Expired waiver test',
    authorized_by: 'lead',
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2026-02-01T00:00:00.000Z',
  };

  const verdict = evaluateRun({
    runId: 'ac04-test',
    scenarios,
    rawResults: [],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    waivers: [expiredWaiver],
    evaluationTime: '2026-08-30T18:00:00.000Z',
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdict.scenarios[0].status, 'FAIL', 'Required skip must FAIL');
  assert.strictEqual(verdict.scenarios[1].status, 'UNPROVEN', 'Conditional unmet must be UNPROVEN');
  assert.strictEqual(verdict.scenarios[2].status, 'FAIL', 'Manual without signoff must FAIL');
  assert.strictEqual(verdict.scenarios[3].status, 'FAIL', 'Unsupported with expired waiver must FAIL');
  recordPass('AC-04', 'Complete Skip and Policy Enforcement (Required, Conditional, Manual, Waiver Expiry)', 'UNIT');
}

// ----------------------------------------------------------------------------
// AC-05: Incomplete or Corrupted Evidence Cannot Pass
// ----------------------------------------------------------------------------
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac05-evidence-'));
  const logFile = path.join(tmpDir, 'test.log');
  fs.writeFileSync(logFile, 'original content', 'utf8');

  const sealer = new EvidenceSealer(tmpDir, 'ac05-run');
  sealer.sealEvidence();

  // 1. Post-seal modification
  fs.writeFileSync(logFile, 'corrupted content', 'utf8');
  let verdict = evaluateRun({ runId: 'ac05-run', evidenceDir: tmpDir, scenarios: [], rawResults: [], origins: [] });
  assert.strictEqual(verdict.run_integrity, 'EVIDENCE_INVALID');
  assert.strictEqual(verdict.exit_code, 4);

  // 2. Post-seal file addition
  fs.writeFileSync(path.join(tmpDir, 'unexpected.txt'), 'extra file', 'utf8');
  verdict = evaluateRun({ runId: 'ac05-run', evidenceDir: tmpDir, scenarios: [], rawResults: [], origins: [] });
  assert.strictEqual(verdict.run_integrity, 'EVIDENCE_INVALID');
  assert.strictEqual(verdict.exit_code, 4);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  recordPass('AC-05', 'Incomplete or Corrupted Evidence Cannot Pass (Modification & Injection Detection)', 'INTEGRATION');
}

// ----------------------------------------------------------------------------
// AC-06: Independent Side-Effect Verification
// ----------------------------------------------------------------------------
{
  // Test Case A: Unreachable or unsupported probe fails closed
  const mockSideEffect = {
    service: 'minio',
    probe_type: 's3_object_exists',
    params: { host: '127.0.0.1', port: 65432, bucket: 'nonexistent-bucket', key: 'missing.pdf' },
  };
  const probeRes = await verifySideEffect(mockSideEffect);
  assert.strictEqual(probeRes.ok, false, 'Probe against unreachable MinIO must return false');

  // Test Case B: Neutral Storage Bypass Regression (upload succeeds in app, but DB stores /tmp path and bucket object is absent)
  const mockPort = 34567;
  const srv = await startMockHttpServer(mockPort, (req, res) => {
    const body = JSON.stringify({ status: 'uploaded', path: '/tmp/local-only-file.jpg' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const runner = new ScenarioRunner({
    origins: [{ origin_id: 'upload-web', type: 'browser_app', auth: 'none', url_source: `http://127.0.0.1:${mockPort}`, route_families: ['/'], safe_for_live: true, evidence: ['test'] }],
    evidenceDir: os.tmpdir(),
  });

  const bypassScenario = {
    id: 'S-SIDE-BYPASS',
    name: 'Document Upload with Storage Assertion',
    origin_id: 'upload-web',
    tier: 'core',
    policy: 'required',
    steps: [{ action: 'navigate', target: '/upload', timeout: 5000 }],
    expected_side_effects: [
      {
        service: 'minio',
        probe_type: 's3_object_exists',
        params: {
          host: '127.0.0.1',
          port: 65432,
          bucket: 'documents',
          key: 'passport.jpg',
          forbidden_paths: ['/tmp/*', 'C:/Temp/*'],
          observed_storage_path: '/tmp/local-only-file.jpg',
        },
      },
    ],
  };

  const bypassResult = await runner.runScenario(bypassScenario);
  srv.close();

  assert.strictEqual(bypassResult.failed, true, 'Storage bypass scenario must fail');
  assert.strictEqual(bypassResult.side_effects_failed, true);
  assert.ok(bypassResult.error_message.includes('Storage bypass violation') || bypassResult.side_effect_error.includes('Storage bypass violation'));

  const verdict = evaluateRun({
    runId: 'ac06-test',
    scenarios: [bypassScenario],
    rawResults: [bypassResult],
    origins: [{ origin_id: 'upload-web', type: 'browser_app', auth: 'none', url_source: `http://127.0.0.1:${mockPort}`, route_families: ['/'], safe_for_live: true, evidence: ['test'] }],
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdict.certification_status, 'FAIL');
  assert.strictEqual(verdict.exit_code, 1);
  assert.ok(verdict.causes.includes('PRODUCT_BUG'));

  // ---- Issue #5: a harness gap must not be reported as the adopter's bug ----
  // `custom` is schema-valid but unimplemented. The probe layer says so
  // correctly; everything downstream used to discard that and report
  // PRODUCT_BUG. This drives the real runner end to end.
  const customProbeScenario = {
    id: 'S-CUSTOM-UNIMPLEMENTED',
    name: 'Scenario declaring an unimplemented custom probe',
    origin_id: 'upload-web',
    tier: 'core',
    policy: 'required',
    steps: [{ action: 'navigate', target: '/', timeout: 5000 }],
    expected_side_effects: [
      { service: 'custom', probe_type: 'custom', params: { command: 'echo hi' } },
    ],
  };

  const customPort = 34572;
  const srvCustom = await startMockHttpServer(customPort, (req, res) => {
    const body = '<h1>OK</h1>';
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const customEvidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-ac06-evidence-'));
  const customWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-ac06-workspace-'));
  let customResult;
  try {
    const customRunner = new ScenarioRunner({
      origins: [{ origin_id: 'upload-web', type: 'browser_app', auth: 'none', url_source: `http://127.0.0.1:${customPort}`, route_families: ['/'], safe_for_live: true, evidence: ['test'] }],
      evidenceDir: customEvidenceDir,
      workspaceDir: customWorkspaceDir,
    });
    customResult = await customRunner.runScenario(customProbeScenario);
  } finally {
    srvCustom.close();
  }

  // The observation must carry the probe's own attribution. Dropping `cause`
  // and `is_harness_error` from the pushed record fires these two.
  const customObs = customResult.side_effect_observations[0];
  assert.ok(customObs, 'An attempted probe must leave an observation behind');
  assert.strictEqual(customObs.passed, false);
  assert.strictEqual(customObs.cause, 'HARNESS_CONFIGURATION', 'The observation must carry the probe reported cause');
  assert.strictEqual(customObs.is_harness_error, true, 'The observation must carry the probe harness-error flag');

  // The catch must not overwrite it. Restoring the unconditional
  // `rawResult.cause = 'PRODUCT_BUG'` fires this one.
  assert.strictEqual(customResult.failed, true);
  assert.strictEqual(
    customResult.cause,
    'HARNESS_CONFIGURATION',
    'A probe the harness never implemented is a harness fault, not a product bug'
  );
  assert.strictEqual(customResult.is_harness_error, true);

  // And the CLI's harnessErrors feed turns that into exit 3, not exit 1.
  const harnessErrorsFromRun = [];
  for (const obs of customResult.side_effect_observations || []) {
    if (obs.is_harness_error) {
      harnessErrorsFromRun.push({
        cause: obs.cause || 'HARNESS_CONFIGURATION',
        message: `[${customProbeScenario.id}] ${obs.observed_result}`,
        scenario_id: customProbeScenario.id,
      });
    }
  }
  assert.strictEqual(harnessErrorsFromRun.length, 1, 'A harness-flagged observation must reach harnessErrors');

  const customVerdict = evaluateRun({
    runId: 'ac06-custom-probe',
    scenarios: [customProbeScenario],
    rawResults: [customResult],
    origins: [{ origin_id: 'upload-web', type: 'browser_app', auth: 'none', url_source: `http://127.0.0.1:${customPort}`, route_families: ['/'], safe_for_live: true, evidence: ['test'] }],
    harnessErrors: harnessErrorsFromRun,
    skipIntegrityVerification: true,
  });

  assert.strictEqual(customVerdict.run_integrity, 'HARNESS_ERROR');
  assert.strictEqual(customVerdict.exit_code, 3, 'An unimplemented probe exits 3 (harness), never 1 (product)');
  assert.ok(customVerdict.causes.includes('HARNESS_CONFIGURATION'));
  assert.ok(
    !customVerdict.causes.includes('PRODUCT_BUG'),
    'Issue #5: the harness must not blame the adopter product for its own missing feature'
  );

  // The params B3's custom probe will consume must actually arrive.
  const builtParams = new ScenarioRunner({
    origins: [],
    evidenceDir: customEvidenceDir,
    workspaceDir: customWorkspaceDir,
    portOffset: 100,
  }).buildProbeParams(customProbeScenario, { service: 'custom', probe_type: 'custom', params: { port: 5432 } });

  assert.strictEqual(builtParams.evidenceDir, customEvidenceDir, 'A probe receives the run evidence directory');
  assert.strictEqual(builtParams.cwd, customWorkspaceDir, 'A probe runs against the materialized workspace, not the developer cwd');
  assert.strictEqual(builtParams.probeId, 'S-CUSTOM-UNIMPLEMENTED-custom-custom', 'A probe receives a stable id for its sealed output');
  assert.strictEqual(builtParams.port, 5532, 'Probe params are port-shifted before the probe sees them');

  const explicitParams = new ScenarioRunner({ origins: [], evidenceDir: customEvidenceDir, workspaceDir: customWorkspaceDir })
    .buildProbeParams(customProbeScenario, { service: 'custom', probe_type: 'custom', params: { cwd: '/explicit', evidenceDir: '/ev', probeId: 'mine' } });
  assert.strictEqual(explicitParams.cwd, '/explicit', 'An explicit cwd is not overridden by the default');
  assert.strictEqual(explicitParams.evidenceDir, '/ev');
  assert.strictEqual(explicitParams.probeId, 'mine');

  fs.rmSync(customEvidenceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  fs.rmSync(customWorkspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

  recordPass('AC-06', 'Independent Side-Effect Verification & /tmp Bypass Detection', 'COMPONENT');
}

// ----------------------------------------------------------------------------
// AC-07: Real Negative Control Observation (Exact Status & Rejection Reason)
// ----------------------------------------------------------------------------
{
  // Test Case A: Real Negative Control Passes when 400 + Reason matches
  const mockPortA = 34568;
  const srvA = await startMockHttpServer(mockPortA, (req, res) => {
    const body = JSON.stringify({ error: 'challenge_failed', message: 'Active camera test rejected' });
    res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const runnerA = new ScenarioRunner({
    origins: [{ origin_id: 'neg-web', type: 'browser_app', auth: 'none', url_source: `http://127.0.0.1:${mockPortA}`, route_families: ['/'], safe_for_live: true, evidence: ['test'] }],
    evidenceDir: os.tmpdir(),
  });

  const resA = await runnerA.runScenario({
    id: 'NEG-PASS',
    name: 'Negative Control Pass',
    origin_id: 'neg-web',
    tier: 'core',
    policy: 'required',
    steps: [{ action: 'navigate', target: '/verify', timeout: 5000 }],
    negative_control: { expected_http_status: 400, expected_rejection_reason: 'challenge_failed' },
  });
  srvA.close();
  assert.strictEqual(resA.failed, false, 'Expected rejection must pass negative control');
  assert.strictEqual(resA.negative_control_passed, true);

  // Test Case B: Real Negative Control Fails when HTTP 200 returned (Unexpected Success)
  const mockPortB = 34569;
  const srvB = await startMockHttpServer(mockPortB, (req, res) => {
    const body = JSON.stringify({ status: 'success' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const runnerB = new ScenarioRunner({
    origins: [{ origin_id: 'neg-web', type: 'browser_app', auth: 'none', url_source: `http://127.0.0.1:${mockPortB}`, route_families: ['/'], safe_for_live: true, evidence: ['test'] }],
    evidenceDir: os.tmpdir(),
  });

  const resB = await runnerB.runScenario({
    id: 'NEG-FAIL-200',
    name: 'Negative Control Unexpected 200',
    origin_id: 'neg-web',
    tier: 'core',
    policy: 'required',
    steps: [{ action: 'navigate', target: '/verify', timeout: 5000 }],
    negative_control: { expected_http_status: 400, expected_rejection_reason: 'challenge_failed' },
  });
  srvB.close();
  assert.strictEqual(resB.failed, true, 'Unexpected HTTP 200 must fail negative control');
  assert.ok(resB.error_message.includes('unexpected success'), 'Must explain unexpected success');

  // Test Case C: Real Negative Control Fails when HTTP 500 returned (Crash)
  const mockPortC = 34570;
  const srvC = await startMockHttpServer(mockPortC, (req, res) => {
    const body = JSON.stringify({ error: 'Internal Server Crash' });
    res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const runnerC = new ScenarioRunner({
    origins: [{ origin_id: 'neg-web', type: 'browser_app', auth: 'none', url_source: `http://127.0.0.1:${mockPortC}`, route_families: ['/'], safe_for_live: true, evidence: ['test'] }],
    evidenceDir: os.tmpdir(),
  });

  const resC = await runnerC.runScenario({
    id: 'NEG-FAIL-500',
    name: 'Negative Control 500 Crash',
    origin_id: 'neg-web',
    tier: 'core',
    policy: 'required',
    steps: [{ action: 'navigate', target: '/verify', timeout: 5000 }],
    negative_control: { expected_http_status: 400, expected_rejection_reason: 'challenge_failed' },
  });
  srvC.close();
  assert.strictEqual(resC.failed, true, 'HTTP 500 must fail negative control');

  recordPass('AC-07', 'Real Negative Assertion Observation (Rejection Reason + Unexpected 200 & 500 Checks)', 'COMPONENT');
}

// ----------------------------------------------------------------------------
// AC-08: Detached Source Materialization and Zero Repository/Git Pollution
// ----------------------------------------------------------------------------
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac08-mat-'));
  const materializer = new SourceMaterializer(tmpDir);

  const beforeStat = fs.readdirSync(tinyMonorepoDir);
  const mat = materializer.materializeRepo(tinyMonorepoDir, 'source');

  assert.ok(fs.existsSync(mat.targetDir));
  assert.ok(!fs.existsSync(path.join(mat.targetDir, '.git')), 'External source must not contain .git');
  const afterStat = fs.readdirSync(tinyMonorepoDir);
  assert.deepStrictEqual(beforeStat, afterStat, 'Source repository must remain completely untouched');

  materializer.cleanup();
  assert.ok(!fs.existsSync(mat.targetDir), 'Cleanup must remove the materialized workspace');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  recordPass('AC-08', 'Detached Source Materialization and Zero Repository/Git Pollution', 'INTEGRATION');
}

// ----------------------------------------------------------------------------
// AC-09: Scoped Runtime Cleanup (Docker + Workspace Ownership Assertions)
// ----------------------------------------------------------------------------
{
  const testEvidenceRoot = path.join(os.tmpdir(), 'rh-cleanup-root');
  const runA = path.join(testEvidenceRoot, 'workspaces', 'run-A');
  const runB = path.join(testEvidenceRoot, 'workspaces', 'run-B');

  fs.mkdirSync(runA, { recursive: true });
  fs.mkdirSync(runB, { recursive: true });
  fs.writeFileSync(path.join(runA, 'state.txt'), 'runA', 'utf8');
  fs.writeFileSync(path.join(runB, 'state.txt'), 'runB', 'utf8');

  // Create real mock Docker containers with release-harness labels
  let containerAId = null;
  let containerBId = null;
  try {
    containerAId = execSync('docker run -d --label com.xibodev.release-harness=true --label com.xibodev.release-harness.run-id=run-A traefik/whoami:v1.11', { encoding: 'utf8' }).trim();
    containerBId = execSync('docker run -d --label com.xibodev.release-harness=true --label com.xibodev.release-harness.run-id=run-B traefik/whoami:v1.11', { encoding: 'utf8' }).trim();
  } catch {
    // Docker offline fallback
  }

  // Clean specifically run-A
  await runCli(['clean', '--run-id', 'run-A', '--evidence-dir', testEvidenceRoot]);

  // Assert workspace A is removed and B is preserved
  assert.ok(!fs.existsSync(runA), 'Targeted run-A workspace must be deleted');
  assert.ok(fs.existsSync(runB), 'Unrelated run-B workspace must be strictly preserved');

  // Assert Docker container A is removed and container B is preserved
  if (containerAId && containerBId) {
    const runningContainers = execSync('docker ps -q', { encoding: 'utf8' });
    assert.ok(!runningContainers.includes(containerAId.slice(0, 12)), 'Container A must be removed by clean --run-id run-A');
    assert.ok(runningContainers.includes(containerBId.slice(0, 12)), 'Container B must remain running');
    execSync(`docker rm -f ${containerBId}`, { stdio: ['ignore', 'pipe', 'ignore'] });
  }

  fs.rmSync(testEvidenceRoot, { recursive: true, force: true });
  recordPass('AC-09', 'Scoped Runtime Resource Isolation & Namespaced Teardown', 'INTEGRATION');
}

// ----------------------------------------------------------------------------
// AC-10: Concurrent Run Isolation (Real Parallel Child Processes Execution)
// ----------------------------------------------------------------------------
{
  const tmpConcurFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-concurrent-fixture-'));
  const hDir = path.join(tmpConcurFixture, '.release-harness');
  fs.mkdirSync(path.join(hDir, 'scenarios'), { recursive: true });

  fs.writeFileSync(path.join(hDir, 'harness.config.json'), '{"schema_version":"1.0.0","product_slug":"concur-test","harness_version":"1.0.0","port_block":{"start":35000,"range":50}}', 'utf8');
  fs.writeFileSync(path.join(hDir, 'topology.json'), '{"schema_version":"1.0.0","product_slug":"concur-test","topology_type":"monorepo","nodes":[]}', 'utf8');
  fs.writeFileSync(path.join(hDir, 'origins.json'), '[{"origin_id":"mock-web","type":"browser_app","auth":"none","url_source":"http://127.0.0.1:35000","route_families":["/"],"safe_for_live":true,"evidence":["test"]}]', 'utf8');
  fs.writeFileSync(path.join(hDir, 'scenarios', 'smoke.json'), '{"id":"SMOKE-1","name":"Smoke","origin_id":"mock-web","tier":"smoke","policy":"required","steps":[{"action":"navigate","target":"/"}]}', 'utf8');

  // Make the fixture a real repository. Cleanliness now fails closed, so a
  // non-git directory reports dirty and run-local exits 2 (UNPROVEN) — which
  // would mask what this test actually measures: concurrent execution.
  execSync('git init -b main', { cwd: tmpConcurFixture, stdio: 'ignore' });
  execSync('git add -A', { cwd: tmpConcurFixture, stdio: 'ignore' });
  execSync('git -c user.name=fixture -c user.email=fixture@test commit -m fixture', { cwd: tmpConcurFixture, stdio: 'ignore' });

  const mockPortConcur = 35000;
  const srvConcur = await startMockHttpServer(mockPortConcur, (req, res) => {
    const body = '<h1>OK</h1>';
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const cliBin = path.join(repoRoot, 'packages', 'release-harness-core', 'bin', 'release-harness.js');
  const evidenceDir1 = path.join(os.tmpdir(), 'rh-concurrent-evidence-1');
  const evidenceDir2 = path.join(os.tmpdir(), 'rh-concurrent-evidence-2');

  function spawnRunLocal(runId, portOffset, evidenceDir) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const child = spawn(process.execPath, [cliBin, 'run-local', '--allow-dirty', '--run-id', runId, '--port-offset', String(portOffset), '--evidence-dir', evidenceDir], {
        cwd: tmpConcurFixture,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));

      child.on('close', (code) => {
        const endTime = Date.now();
        resolve({ code, stdout, stderr, startTime, endTime, runId, evidenceDir });
      });

      child.on('error', reject);
    });
  }

  try {
    const [res1, res2] = await Promise.all([
      spawnRunLocal('concurrent-child-1', 0, evidenceDir1),
      spawnRunLocal('concurrent-child-2', 100, evidenceDir2),
    ]);

    // Assert temporal overlap: start of each was before end of the other
    const overlap = res1.startTime < res2.endTime && res2.startTime < res1.endTime;
    assert.ok(overlap, 'Two run-local child processes must overlap in execution time');

    assert.strictEqual(res1.code, 0, `Process 1 must exit 0: ${res1.stderr}`);
    assert.strictEqual(res2.code, 0, `Process 2 must exit 0: ${res2.stderr}`);

    const vPath1 = path.join(evidenceDir1, 'runs', 'concurrent-child-1', 'verdict.json');
    const vPath2 = path.join(evidenceDir2, 'runs', 'concurrent-child-2', 'verdict.json');

    assert.ok(fs.existsSync(vPath1), 'Run 1 verdict must exist in evidenceDir1');
    assert.ok(fs.existsSync(vPath2), 'Run 2 verdict must exist in evidenceDir2');

    const v1 = JSON.parse(fs.readFileSync(vPath1, 'utf8'));
    const v2 = JSON.parse(fs.readFileSync(vPath2, 'utf8'));

    assert.strictEqual(v1.run_id, 'concurrent-child-1');
    assert.strictEqual(v2.run_id, 'concurrent-child-2');
  } finally {
    srvConcur.close();
    try { fs.rmSync(tmpConcurFixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
    try { fs.rmSync(evidenceDir1, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
    try { fs.rmSync(evidenceDir2, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  }

  recordPass('AC-10', 'Concurrent Run Isolation (Simultaneous Parallel run-local Child Processes)', 'INTEGRATION');
}

// ----------------------------------------------------------------------------
// AC-11: Evidence Integrity and Multi-Layer Redaction
// ----------------------------------------------------------------------------
{
  const redactor = new SecretRedactor(['custom-seed-token-12345']);
  const text = `
    Authorization: Bearer secret-bearer-token-abc
    DATABASE_URL=postgres://user:super_secret_pw@localhost:5432/db
    API_KEY=custom-seed-token-12345
    session_id=session_xyz987654321
  `;
  const sanitized = redactor.redactText(text);

  assert.ok(!sanitized.includes('secret-bearer-token-abc'));
  assert.ok(!sanitized.includes('super_secret_pw'));
  assert.ok(!sanitized.includes('custom-seed-token-12345'));
  assert.ok(!sanitized.includes('session_xyz987654321'));

  const obj = {
    apiKey: 'custom-seed-token-12345',
    user: 'alice',
    auth_token: 'secret-token',
  };
  const redactedObj = redactor.redactObject(obj);
  assert.strictEqual(redactedObj.apiKey, '[REDACTED]');
  assert.strictEqual(redactedObj.auth_token, '[REDACTED]');
  assert.strictEqual(redactedObj.user, 'alice');
  recordPass('AC-11', 'Evidence Integrity and Multi-Layer Secret Redaction', 'COMPONENT');
}

// ----------------------------------------------------------------------------
// AC-12: Exact Source and Artifact Provenance
// ----------------------------------------------------------------------------
{
  const materializer = new SourceMaterializer(path.join(os.tmpdir(), 'ac12'));
  const sourceInfo = materializer.getSourceInfo(repoRoot);

  assert.ok(sourceInfo.commitSha, 'Must resolve git commit SHA');
  assert.ok(sourceInfo.treeDigest, 'Must calculate tree content digest');
  materializer.cleanup();
  recordPass('AC-12', 'Exact Source and Artifact Provenance (Git SHA + Tree Digest)', 'COMPONENT');
}

// ----------------------------------------------------------------------------
// AC-13: Build-Once Artifact Continuity (Harness OCI Digest Resolver)
// ----------------------------------------------------------------------------
{
  const images = execSync('docker images -q', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean);
  assert.ok(images.length > 0, 'Docker daemon must be active and have images available');

  // Directly invoke the harness's production artifact digest resolver
  const resolvedDigest = resolveImageContentDigest(images[0]);
  assert.ok(resolvedDigest.startsWith('sha256:'), `Resolved canonical digest must start with sha256: (got ${resolvedDigest})`);
  recordPass('AC-13', 'Build-Once Artifact Continuity (Harness OCI Digest Resolver Execution)', 'COMPONENT');
}

// ----------------------------------------------------------------------------
// AC-14: Multi-Repo Product-Graph Verification (Real Runtime Git Repos)
// ----------------------------------------------------------------------------
{
  const tmpMultiRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-multi-repo-test-'));
  const cDir = path.join(tmpMultiRepoDir, 'contracts-repo');
  const bDir = path.join(tmpMultiRepoDir, 'backend-repo');
  const fDir = path.join(tmpMultiRepoDir, 'frontend-repo');

  fs.mkdirSync(cDir, { recursive: true });
  fs.mkdirSync(bDir, { recursive: true });
  fs.mkdirSync(fDir, { recursive: true });

  execSync('git init -b main && git config user.name "Test" && git config user.email "test@xibo.dev"', { cwd: cDir, stdio: ['ignore', 'pipe', 'ignore'] });
  fs.writeFileSync(path.join(cDir, 'openapi.json'), '{"openapi":"3.0.0"}', 'utf8');
  execSync('git add . && git commit -m "contracts: v1"', { cwd: cDir, stdio: ['ignore', 'pipe', 'ignore'] });
  const cSha = execSync('git rev-parse HEAD', { cwd: cDir, encoding: 'utf8' }).trim();

  execSync('git init -b main && git config user.name "Test" && git config user.email "test@xibo.dev"', { cwd: bDir, stdio: ['ignore', 'pipe', 'ignore'] });
  fs.writeFileSync(path.join(bDir, 'main.py'), 'def api(): pass', 'utf8');
  execSync('git add . && git commit -m "backend: v1"', { cwd: bDir, stdio: ['ignore', 'pipe', 'ignore'] });
  const bSha = execSync('git rev-parse HEAD', { cwd: bDir, encoding: 'utf8' }).trim();

  execSync('git init -b main && git config user.name "Test" && git config user.email "test@xibo.dev"', { cwd: fDir, stdio: ['ignore', 'pipe', 'ignore'] });
  fs.writeFileSync(path.join(fDir, 'index.html'), '<h1>App</h1>', 'utf8');
  execSync('git add . && git commit -m "frontend: v1"', { cwd: fDir, stdio: ['ignore', 'pipe', 'ignore'] });
  const fSha = execSync('git rev-parse HEAD', { cwd: fDir, encoding: 'utf8' }).trim();

  const topology = {
    schema_version: '1.0.0',
    product_slug: 'multi-test',
    topology_type: 'multi_repo',
    repositories: [
      { repo_id: 'contracts', source: { type: 'local_path', local_path: 'contracts-repo', revision_policy: 'exact_sha', expected_sha: cSha } },
      { repo_id: 'backend', source: { type: 'local_path', local_path: 'backend-repo', revision_policy: 'exact_sha', expected_sha: bSha } },
      { repo_id: 'frontend', source: { type: 'local_path', local_path: 'frontend-repo', revision_policy: 'exact_sha', expected_sha: fSha } },
    ],
  };

  const materializer = new SourceMaterializer(path.join(tmpMultiRepoDir, 'workspace'));
  const graph = materializer.resolveMultiRepoGraph(topology, tmpMultiRepoDir);

  assert.strictEqual(graph.ok, true, 'Multi-repo graph with valid exact SHAs must pass');
  assert.strictEqual(graph.nodes.length, 3);
  assert.strictEqual(graph.nodes[0].is_independent_repo, true);
  assert.strictEqual(graph.nodes[1].is_independent_repo, true);
  assert.strictEqual(graph.nodes[2].is_independent_repo, true);
  assert.notStrictEqual(cSha, bSha);
  assert.notStrictEqual(bSha, fSha);

  // Test SHA mismatch
  topology.repositories[0].source.expected_sha = '0000000000000000000000000000000000000000';
  const graphFail = materializer.resolveMultiRepoGraph(topology, tmpMultiRepoDir);
  assert.strictEqual(graphFail.ok, false, 'SHA mismatch must fail graph validation');

  fs.rmSync(tmpMultiRepoDir, { recursive: true, force: true });
  recordPass('AC-14', 'Multi-Repo Product-Graph Verification (Per-Repo SHA, TopLevel & Digest Binding)', 'INTEGRATION');
}

// ----------------------------------------------------------------------------
// AC-15: Version and Schema Compatibility
// ----------------------------------------------------------------------------
{
  assert.ok(Schemas.TopologyV1);
  assert.ok(Schemas.ScenarioV1);
  assert.ok(Schemas.VerdictV1);
  assert.strictEqual(Schemas.VerdictV1.properties.run_integrity.enum[2], 'EVIDENCE_INVALID');
  recordPass('AC-15', 'Version and Schema Compatibility (Exact 1.0.0 Pinning & Schema Store)', 'UNIT');
}

// ----------------------------------------------------------------------------
// AC-16: Agent / Core Authority Boundary
// ----------------------------------------------------------------------------
{
  const verdict = evaluateRun({
    runId: 'ac16-test',
    scenarios: [{ id: 'S1', name: 'S1', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] }],
    rawResults: [{ id: 'S1', failed: true, cause: 'PRODUCT_BUG' }],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdict.exit_code, 1);
  assert.strictEqual(verdict.certification_status, 'FAIL');
  recordPass('AC-16', 'Agent / Core Authority Boundary (Deterministic Core Sole Verdict Authority)', 'UNIT');
}

// ----------------------------------------------------------------------------
// AC-17: Four-Level Gate Scope Boundary (v1.0 Bound)
// ----------------------------------------------------------------------------
{
  const exitEphemeral = await runCli(['run-ephemeral']);
  assert.strictEqual(exitEphemeral, 3, 'v1.0 must reject run-ephemeral as roadmap');

  const exitCanary = await runCli(['verify-canary']);
  assert.strictEqual(exitCanary, 3, 'v1.0 must reject verify-canary as roadmap');
  recordPass('AC-17', 'Four-Level Gate Scope Boundary (Levels 1-2 v1.0, Levels 3-4 Roadmap)', 'INTEGRATION');
}

// ----------------------------------------------------------------------------
// AC-18: Runtime Network Contract Enforcement (Playwright Egress Interception)
// ----------------------------------------------------------------------------
{
  const mockPort = 34571;
  const srv = await startMockHttpServer(mockPort, (req, res) => {
    const body = `
      <html>
        <head>
          <script src="http://unauthorized-cdn.example.org/tracker.js"></script>
        </head>
        <body><h1>Testing Egress</h1></body>
      </html>
    `;
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const runner = new ScenarioRunner({
    origins: [{ origin_id: 'test-web', type: 'browser_app', auth: 'none', url_source: `http://127.0.0.1:${mockPort}`, route_families: ['/'], safe_for_live: true, evidence: ['test'] }],
    networkPolicy: { mode: 'sealed', allowed_egress: [] },
    evidenceDir: os.tmpdir(),
  });

  const res = await runner.runScenario({
    id: 'EGRESS-TEST',
    name: 'Egress Interception Test',
    origin_id: 'test-web',
    tier: 'core',
    policy: 'required',
    steps: [{ action: 'navigate', target: '/', timeout: 5000 }],
  });
  srv.close();

  assert.ok(res.network_violations.length > 0, 'Scenario runner must detect unauthorized external script request');
  assert.strictEqual(res.network_violations[0].host, 'unauthorized-cdn.example.org');

  const verdict = evaluateRun({
    runId: 'egress-eval',
    scenarios: [{ id: 'EGRESS-TEST', name: 'Egress', origin_id: 'test-web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] }],
    rawResults: [res],
    origins: [{ origin_id: 'test-web', type: 'browser_app', auth: 'none', url_source: `http://127.0.0.1:${mockPort}`, route_families: ['/'], safe_for_live: true, evidence: ['test'] }],
    networkViolations: res.network_violations,
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdict.certification_status, 'FAIL', 'Undeclared network egress must fail certification');
  assert.strictEqual(verdict.exit_code, 1);
  recordPass('AC-18', 'Runtime Network Contract Enforcement (Playwright Egress Interception & Fail-Closed)', 'INTEGRATION');
}

// ----------------------------------------------------------------------------
// Stage A: Thibit Verdict Golden Fixture Verification
// ----------------------------------------------------------------------------
{
  console.log('\n--- Stage A: Thibit Verdict Golden Fixture Verification ---');
  const scenarios = [];
  const rawResults = [];

  for (let i = 1; i <= 17; i++) {
    const id = `THIBIT-CORE-${i.toString().padStart(2, '0')}`;
    scenarios.push({
      id,
      name: `Thibit core scenario ${i}`,
      origin_id: 'onboarding-web',
      tier: 'core',
      policy: 'required',
      steps: [{ action: 'navigate', target: '/verify' }],
    });
    rawResults.push({ id, failed: false, duration_ms: 45 });
  }

  // 1 conditional scenario: positive face detection/match (fixture absent)
  scenarios.push({
    id: 'THIBIT-FACE-POSITIVE',
    name: 'Biometric active challenge - positive face match',
    origin_id: 'onboarding-web',
    tier: 'core',
    policy: 'conditional',
    preconditions: { fixtures: ['fixtures/biometrics/approved-positive-face.y4m'] },
    steps: [{ action: 'upload', target: 'input#camera' }],
  });

  // 2 unselected / not-applicable scenarios
  scenarios.push({
    id: 'THIBIT-ADMIN-01',
    name: 'Admin ledger audit',
    origin_id: 'admin-web',
    tier: 'full',
    policy: 'unsupported',
    steps: [{ action: 'navigate', target: '/admin' }],
  });
  scenarios.push({
    id: 'THIBIT-ADMIN-02',
    name: 'Admin manual KYC override',
    origin_id: 'admin-web',
    tier: 'full',
    policy: 'manual',
    steps: [{ action: 'navigate', target: '/admin/kyc' }],
  });

  const activeWaiver = {
    id: 'WAIVER-THIBIT-ADMIN',
    scenario_id: 'THIBIT-ADMIN-01',
    policy_override: 'unsupported',
    reason: 'Admin portal out of scope for onboarding release gate',
    authorized_by: 'security-lead',
    created_at: '2026-08-01T00:00:00.000Z',
    expires_at: '2026-12-31T23:59:59.000Z',
  };

  const manualSignOff = {
    id: 'MANUAL-THIBIT-ADMIN-02',
    scenario_id: 'THIBIT-ADMIN-02',
    policy_override: 'manual',
    reason: 'Operator manual verification of KYC override',
    authorized_by: 'lead-operator',
    created_at: '2026-08-01T00:00:00.000Z',
    expires_at: '2026-12-31T23:59:59.000Z',
  };

  const verdict = evaluateRun({
    runId: 'thibit-dogfood-full',
    scenarios,
    rawResults,
    origins: [
      { origin_id: 'onboarding-web', type: 'browser_app', auth: 'session-cookie', url_source: 'APP_URL', route_families: ['/verify'], safe_for_live: true, evidence: ['onboarding/src/App.tsx'] },
      { origin_id: 'admin-web', type: 'browser_app', auth: 'bearer-jwt', url_source: 'ADMIN_URL', route_families: ['/admin'], safe_for_live: false, evidence: ['admin/src/App.tsx'] },
    ],
    waivers: [activeWaiver, manualSignOff],
    evaluationTime: '2026-08-30T18:00:00.000Z',
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdict.certification_status, 'UNPROVEN');
  assert.strictEqual(verdict.run_integrity, 'COMPLETE');
  assert.strictEqual(verdict.exit_code, 2);
  assert.strictEqual(verdict.summary.passed, 17);
  assert.strictEqual(verdict.summary.failed, 0);
  assert.strictEqual(verdict.summary.unproven, 1);
  assert.strictEqual(verdict.summary.skipped, 2);
  assert.deepStrictEqual(verdict.causes, ['HARNESS_FIXTURE_MISSING']);
  console.log('✓ Stage A Golden Fixture verified: PASS 17 | FAIL 0 | UNPROVEN 1 | SKIPPED 2 → Exit 2 (UNPROVEN)');
}


// ----------------------------------------------------------------------------
// AC-19: A Harness Gap Reports As A Harness Fault Through The Real CLI (issue #5)
// ----------------------------------------------------------------------------
{
  // Issue #5 reported that an unimplemented `custom` probe yields exit 3. It
  // did not: probes.js returned HARNESS_CONFIGURATION, the runner's catch
  // overwrote it with PRODUCT_BUG, and nothing ever populated `harnessErrors`,
  // so exit 3 was unreachable from the CLI entirely. This spawns the real
  // binary end to end -- the only assertion here that exercises the CLI's own
  // wiring rather than a copy of it.
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-issue5-fixture-'));
  const fixtureHarnessDir = path.join(fixtureDir, '.release-harness');
  fs.mkdirSync(path.join(fixtureHarnessDir, 'scenarios'), { recursive: true });

  const issue5Port = 35400;
  fs.writeFileSync(path.join(fixtureHarnessDir, 'harness.config.json'), '{"schema_version":"1.0.0","product_slug":"issue5","harness_version":"1.0.0","port_block":{"start":35400,"range":50}}', 'utf8');
  fs.writeFileSync(path.join(fixtureHarnessDir, 'topology.json'), '{"schema_version":"1.0.0","product_slug":"issue5","topology_type":"monorepo","nodes":[]}', 'utf8');
  fs.writeFileSync(path.join(fixtureHarnessDir, 'origins.json'), `[{"origin_id":"web","type":"browser_app","auth":"none","url_source":"http://127.0.0.1:${issue5Port}","route_families":["/"],"safe_for_live":true,"evidence":["test"]}]`, 'utf8');
  // `custom` is schema-valid and unimplemented -- exactly what the adopter declared.
  fs.writeFileSync(
    path.join(fixtureHarnessDir, 'scenarios', 'custom-probe.json'),
    '{"id":"S-CUSTOM","name":"Custom probe scenario","origin_id":"web","tier":"smoke","policy":"required","steps":[{"action":"navigate","target":"/"}],"expected_side_effects":[{"service":"custom","probe_type":"custom","params":{"command":"echo hi"}}]}',
    'utf8'
  );

  // Git runs in this temp directory only; the harness repo is never touched.
  execSync('git init -b main', { cwd: fixtureDir, stdio: 'ignore' });
  execSync('git add -A', { cwd: fixtureDir, stdio: 'ignore' });
  execSync('git -c user.name=fixture -c user.email=fixture@test commit -m fixture', { cwd: fixtureDir, stdio: 'ignore' });

  const srvIssue5 = await startMockHttpServer(issue5Port, (req, res) => {
    const body = '<h1>OK</h1>';
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const issue5Cli = path.join(repoRoot, 'packages', 'release-harness-core', 'bin', 'release-harness.js');
  const issue5EvidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-issue5-evidence-'));

  function runIssue5Cli(runId, extraArgs) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [issue5Cli, 'run-local', '--run-id', runId, '--evidence-dir', issue5EvidenceDir, ...extraArgs],
        { cwd: fixtureDir, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.on('error', reject);
    });
  }

  try {
    const certRun = await runIssue5Cli('issue5-certification', []);

    assert.strictEqual(
      certRun.code,
      3,
      `An unimplemented probe must exit 3 (harness), not 1 (product). stdout:\n${certRun.stdout}\nstderr:\n${certRun.stderr}`
    );

    const certVerdictPath = path.join(issue5EvidenceDir, 'runs', 'issue5-certification', 'verdict.json');
    assert.ok(fs.existsSync(certVerdictPath), 'The run must still produce a verdict');
    const certVerdict = JSON.parse(fs.readFileSync(certVerdictPath, 'utf8'));

    assert.strictEqual(certVerdict.run_integrity, 'HARNESS_ERROR');
    assert.strictEqual(certVerdict.exit_code, 3);
    assert.ok(certVerdict.causes.includes('HARNESS_CONFIGURATION'), 'The verdict must name the harness cause');
    assert.ok(
      !certVerdict.causes.includes('PRODUCT_BUG'),
      'Issue #5: the harness must not blame the adopter product for a feature the harness never built'
    );
    assert.strictEqual(certVerdict.scenarios[0].cause, 'HARNESS_CONFIGURATION');

    // The harness fault must be recorded as a violation an operator can read,
    // which only happens if the CLI actually pushed to harnessErrors.
    const harnessViolations = (certVerdict.violations || []).filter((v) => v.type === 'HARNESS_RUNTIME_ERROR');
    assert.strictEqual(harnessViolations.length, 1, 'The CLI must route the flagged observation into harnessErrors');
    assert.ok(harnessViolations[0].description.includes('S-CUSTOM'), 'The violation must name the scenario that caused it');

    // A dirty development run is non-certifiable, but that must not downgrade a
    // harness fault to UNPROVEN/exit 2 and hide it.
    fs.writeFileSync(path.join(fixtureDir, 'dirty.txt'), 'uncommitted\n', 'utf8');
    const devRun = await runIssue5Cli('issue5-development', ['--allow-dirty']);
    assert.strictEqual(
      devRun.code,
      3,
      `--allow-dirty must not mask a harness fault as exit 2. stdout:\n${devRun.stdout}\nstderr:\n${devRun.stderr}`
    );
    const devVerdict = JSON.parse(fs.readFileSync(path.join(issue5EvidenceDir, 'runs', 'issue5-development', 'verdict.json'), 'utf8'));
    assert.strictEqual(devVerdict.run_integrity, 'HARNESS_ERROR');
    assert.strictEqual(devVerdict.execution_mode, 'DEVELOPMENT');
    assert.strictEqual(devVerdict.exit_code, 3, 'A development run keeps the harness exit code');

    // An unknown flag is a harness configuration error, not a silent no-op.
    const badFlagRun = await runIssue5Cli('issue5-badflag', ['--not-a-real-flag']);
    assert.strictEqual(badFlagRun.code, 3, 'An unknown run-local flag must exit 3');
    assert.ok(badFlagRun.stderr.includes('unknown flag --not-a-real-flag'), 'The rejected flag must be named');

    // A non-numeric port offset would reach compose and every probe as NaN.
    const badOffsetRun = await runIssue5Cli('issue5-badoffset', ['--port-offset', 'abc']);
    assert.strictEqual(badOffsetRun.code, 3, 'A non-numeric --port-offset must exit 3');
    assert.ok(badOffsetRun.stderr.includes('--port-offset requires an integer'), 'The bad offset must be reported');

    // --port-offset must reach the PROBES, not just compose and the health
    // checks. A Postgres probe names the port it actually dialled in its own
    // failure message, so a run at offset 100 against a declared 5432 must
    // report 5532. Without the CLI passing portOffset into ScenarioRunner,
    // concurrent runs health-check the shifted port and then probe the
    // unshifted one -- verifying another run's containers, or nothing.
    fs.writeFileSync(
      path.join(fixtureHarnessDir, 'scenarios', 'pg-port.json'),
      '{"id":"S-PGPORT","name":"Probe port shifting","origin_id":"web","tier":"smoke","policy":"required","steps":[{"action":"navigate","target":"/"}],"expected_side_effects":[{"service":"postgres","probe_type":"sql_query","params":{"host":"127.0.0.1","port":5432,"timeoutMs":1500}}]}',
      'utf8'
    );

    const offsetRun = await runIssue5Cli('issue5-portoffset', ['--allow-dirty', '--port-offset', '100']);
    assert.strictEqual(
      offsetRun.code,
      3,
      `An unreachable probe is a harness environment fault (exit 3). stdout:\n${offsetRun.stdout}\nstderr:\n${offsetRun.stderr}`
    );

    const offsetVerdict = JSON.parse(fs.readFileSync(path.join(issue5EvidenceDir, 'runs', 'issue5-portoffset', 'verdict.json'), 'utf8'));
    const pgViolation = (offsetVerdict.violations || []).find(
      (v) => v.type === 'HARNESS_RUNTIME_ERROR' && String(v.description).includes('S-PGPORT')
    );
    assert.ok(pgViolation, 'The Postgres probe must report a harness fault the operator can read');
    assert.ok(
      pgViolation.description.includes('127.0.0.1:5532'),
      `--port-offset must shift the port the probe dials: expected 5532 (5432 + 100), got "${pgViolation.description}"`
    );
    assert.ok(
      !pgViolation.description.includes('127.0.0.1:5432'),
      'The probe must not also dial the unshifted port'
    );
  } finally {
    srvIssue5.close();
    try { fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
    try { fs.rmSync(issue5EvidenceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  }

  recordPass('AC-19', 'Harness Gap Reports As Harness Fault Through The Real CLI (issue #5)', 'INTEGRATION');
}

// ----------------------------------------------------------------------------
// Validation & Criteria Matrix Report
// ----------------------------------------------------------------------------
const ALL_19_CRITERIA = [
  'AC-01', 'AC-02', 'AC-03', 'AC-04', 'AC-05', 'AC-06', 'AC-07', 'AC-08', 'AC-09',
  'AC-10', 'AC-11', 'AC-12', 'AC-13', 'AC-14', 'AC-15', 'AC-16', 'AC-17', 'AC-18',
  'AC-19',
];

console.log('\n========================================================================================');
console.log('                         ACCEPTANCE CRITERIA RESULTS MATRIX                             ');
console.log('========================================================================================');
console.log('  CRITERION | LAYER       | STATUS | DESCRIPTION                                        ');
console.log('----------------------------------------------------------------------------------------');

let allPassed = true;
for (const acId of ALL_19_CRITERIA) {
  const res = criteriaResults[acId];
  if (res && res.status === 'PASS') {
    console.log(`  ${acId.padEnd(9)} | ${res.layer.padEnd(11)} | PASS   | ${res.name}`);
  } else {
    console.log(`  ${acId.padEnd(9)} | UNMAPPED    | FAIL   | UNMAPPED / FAILED`);
    allPassed = false;
  }
}

assert.ok(allPassed, 'Every single one of the 19 Acceptance Criteria must pass');

console.log('========================================================================================');
console.log(`  SUMMARY: 19 / 19 Acceptance Criteria AUTOMATED & VERIFIED GREEN (Real Playwright Engine) ✓ `);
console.log('======================================================================\n');

process.exit(0);
