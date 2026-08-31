import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateRun } from '../src/evaluator.js';
import { EvidenceSealer } from '../src/sealer.js';
import { SecretRedactor } from '../src/redactor.js';

console.log('Running Evaluator Golden Tests...');

// 1. All-pass golden test
{
  const scenarios = [
    { id: 'SCEN-01', name: 'Login', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] },
    { id: 'SCEN-02', name: 'Dashboard', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] },
  ];
  const rawResults = [
    { id: 'SCEN-01', failed: false, duration_ms: 120 },
    { id: 'SCEN-02', failed: false, duration_ms: 240 },
  ];
  const verdict = evaluateRun({
    runId: 'run-001',
    scenarios,
    rawResults,
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdict.certification_status, 'PASS');
  assert.strictEqual(verdict.run_integrity, 'COMPLETE');
  assert.strictEqual(verdict.exit_code, 0);
  assert.deepStrictEqual(verdict.causes, ['NONE']);
  assert.strictEqual(verdict.summary.passed, 2);
  assert.strictEqual(verdict.summary.failed, 0);
  console.log('✓ All-pass golden test passed (exit 0)');
}

// 2. Product assertion failure test
{
  const scenarios = [
    { id: 'SCEN-01', name: 'Login', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] },
    { id: 'SCEN-02', name: 'Checkout', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'click' }] },
  ];
  const rawResults = [
    { id: 'SCEN-01', failed: false, duration_ms: 100 },
    { id: 'SCEN-02', failed: true, error_message: 'Button not clickable', cause: 'PRODUCT_BUG', duration_ms: 150 },
  ];
  const verdict = evaluateRun({
    runId: 'run-002',
    scenarios,
    rawResults,
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdict.certification_status, 'FAIL');
  assert.strictEqual(verdict.run_integrity, 'COMPLETE');
  assert.strictEqual(verdict.exit_code, 1);
  assert.deepStrictEqual(verdict.causes, ['PRODUCT_BUG']);
  assert.strictEqual(verdict.summary.failed, 1);
  console.log('✓ Product failure golden test passed (exit 1)');
}

// 3. Conditional scenario missing fixture -> UNPROVEN (Exit 2)
{
  const scenarios = [
    { id: 'SCEN-01', name: 'Basic Flow', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] },
    { id: 'SCEN-02', name: 'Positive Biometric Face Match', origin_id: 'web', tier: 'core', policy: 'conditional', steps: [{ action: 'upload' }] },
  ];
  const rawResults = [
    { id: 'SCEN-01', failed: false, duration_ms: 100 },
  ];
  const verdict = evaluateRun({
    runId: 'run-003',
    scenarios,
    rawResults,
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdict.certification_status, 'UNPROVEN');
  assert.strictEqual(verdict.run_integrity, 'COMPLETE');
  assert.strictEqual(verdict.exit_code, 2);
  assert.deepStrictEqual(verdict.causes, ['HARNESS_FIXTURE_MISSING']);
  assert.strictEqual(verdict.summary.unproven, 1);
  console.log('✓ Conditional missing fixture golden test passed (exit 2)');
}

// 4. Required scenario missing fixture -> FAIL (Exit 1)
{
  const scenarios = [
    { id: 'SCEN-01', name: 'Required Auth Flow', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] },
  ];
  const rawResults = [];
  const verdict = evaluateRun({
    runId: 'run-004',
    scenarios,
    rawResults,
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdict.certification_status, 'FAIL');
  assert.strictEqual(verdict.exit_code, 1);
  assert.deepStrictEqual(verdict.causes, ['HARNESS_FIXTURE_MISSING']);
  console.log('✓ Required missing fixture golden test passed (exit 1)');
}

// 5. Mixed failure + harness crash -> Exit 3 (HARNESS_ERROR precedence, multi-cause retention)
{
  const scenarios = [
    { id: 'SCEN-01', name: 'Checkout', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'click' }] },
  ];
  const rawResults = [
    { id: 'SCEN-01', failed: true, error_message: '500 Internal Server Error', cause: 'PRODUCT_BUG' },
  ];
  const verdict = evaluateRun({
    runId: 'run-005',
    scenarios,
    rawResults,
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    harnessErrors: [{ message: 'Docker daemon terminated during teardown', cause: 'HARNESS_ENVIRONMENT' }],
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdict.certification_status, 'FAIL');
  assert.strictEqual(verdict.run_integrity, 'HARNESS_ERROR');
  assert.strictEqual(verdict.exit_code, 3);
  assert.ok(verdict.causes.includes('PRODUCT_BUG'), 'Must retain PRODUCT_BUG cause');
  assert.ok(verdict.causes.includes('HARNESS_ENVIRONMENT'), 'Must retain HARNESS_ENVIRONMENT cause');
  console.log('✓ Mixed failure + harness crash golden test passed (exit 3 with multi-cause)');
}

// 6. Evidence integrity & tampering test -> Exit 4 (EVIDENCE_INVALID)
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-evidence-test-'));
  const logFile = path.join(tmpDir, 'test.log');
  fs.writeFileSync(logFile, 'initial logs', 'utf8');

  const sealer = new EvidenceSealer(tmpDir, 'run-006');
  sealer.sealEvidence();

  // Tamper with evidence file after sealing
  fs.writeFileSync(logFile, 'tampered logs!', 'utf8');

  const verdict = evaluateRun({
    runId: 'run-006',
    evidenceDir: tmpDir,
    scenarios: [],
    rawResults: [],
    origins: [],
    skipIntegrityVerification: false,
  });

  assert.strictEqual(verdict.run_integrity, 'EVIDENCE_INVALID');
  assert.strictEqual(verdict.exit_code, 4);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('✓ Evidence tampering detection golden test passed (exit 4)');
}

// 7. Negative control assertion tests
{
  const scenarios = [
    {
      id: 'SCEN-NEG',
      name: 'Synthetic camera rejected',
      origin_id: 'web',
      tier: 'core',
      policy: 'required',
      steps: [{ action: 'navigate' }],
      negative_control: {
        expected_rejection_reason: 'active_challenge_failed',
        expected_http_status: 400,
      },
    },
  ];

  // Case A: Correct rejection
  const passVerdict = evaluateRun({
    runId: 'run-neg-pass',
    scenarios,
    rawResults: [{
      id: 'SCEN-NEG',
      failed: false,
      negative_control_observations: {
        expected_http_status: 400,
        actual_http_status: 400,
        expected_rejection_reason: 'active_challenge_failed',
        actual_rejection_reason: 'active_challenge_failed',
        status_matched: true,
        reason_matched: true,
      },
    }],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    skipIntegrityVerification: true,
  });
  assert.strictEqual(passVerdict.certification_status, 'PASS');
  assert.strictEqual(passVerdict.exit_code, 0);

  // Case B: Regression Test: Expected 400 / observed 200 cannot pass even if a stale boolean says true
  const staleBoolVerdict = evaluateRun({
    runId: 'run-neg-stale-bool',
    scenarios,
    rawResults: [{
      id: 'SCEN-NEG',
      failed: false,
      negative_control_passed: true, // Stale boolean!
      negative_control_observations: {
        expected_http_status: 400,
        actual_http_status: 200, // Observed 200 unexpected success!
        expected_rejection_reason: 'active_challenge_failed',
        actual_rejection_reason: 'none',
        status_matched: false,
        reason_matched: false,
      },
    }],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    skipIntegrityVerification: true,
  });
  assert.strictEqual(staleBoolVerdict.certification_status, 'FAIL', 'Observed 200 must fail negative control despite stale boolean');
  assert.strictEqual(staleBoolVerdict.exit_code, 1);

  // Case C: Regression Test: Expected rejection reason mismatch cannot pass
  const reasonMismatchVerdict = evaluateRun({
    runId: 'run-neg-reason-mismatch',
    scenarios,
    rawResults: [{
      id: 'SCEN-NEG',
      failed: false,
      negative_control_passed: true,
      negative_control_observations: {
        expected_http_status: 400,
        actual_http_status: 400,
        expected_rejection_reason: 'active_challenge_failed',
        actual_rejection_reason: 'unrelated_bad_request',
        status_matched: true,
        reason_matched: false, // Reason mismatch!
      },
    }],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    skipIntegrityVerification: true,
  });
  assert.strictEqual(reasonMismatchVerdict.certification_status, 'FAIL', 'Reason mismatch must fail negative control');
  assert.strictEqual(reasonMismatchVerdict.exit_code, 1);
  console.log('✓ Negative control observation & stale boolean regression tests passed');
}

// 8. Regression Test: Executed side-effect probes auditability
{
  const scenarios = [
    {
      id: 'SCEN-SIDE',
      name: 'Storage probe',
      origin_id: 'web',
      tier: 'core',
      policy: 'required',
      steps: [{ action: 'navigate' }],
      expected_side_effects: [{ service: 'minio', probe_type: 's3_object_exists' }],
    },
  ];

  const failedProbeVerdict = evaluateRun({
    runId: 'run-side-failed',
    scenarios,
    rawResults: [{
      id: 'SCEN-SIDE',
      failed: false,
      side_effect_observations: [
        {
          service: 'minio',
          probe_type: 's3_object_exists',
          expected_condition: 's3_object_exists on minio',
          observed_result: 'Object missing from MinIO; /tmp bypass detected',
          passed: false, // Failed probe observation!
        },
      ],
    }],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    skipIntegrityVerification: true,
  });
  assert.strictEqual(failedProbeVerdict.certification_status, 'FAIL', 'Failed side-effect probe observation must fail certification');
  assert.strictEqual(failedProbeVerdict.exit_code, 1);
  console.log('✓ Auditable side-effect probe observation regression test passed');
}

// 9. Thibit Dogfood Golden Test: 17 PASS, 0 FAIL, 1 UNPROVEN, 2 SKIPPED (NOT_APPLICABLE)
{
  const scenarios = [];
  const rawResults = [];

  for (let i = 1; i <= 17; i++) {
    const id = `THIBIT-CORE-${i.toString().padStart(2, '0')}`;
    scenarios.push({ id, name: `Core scenario ${i}`, origin_id: 'onboarding-web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] });
    rawResults.push({ id, failed: false, duration_ms: 50 });
  }

  scenarios.push({
    id: 'THIBIT-FACE-POSITIVE',
    name: 'Approved positive face sequence match',
    origin_id: 'onboarding-web',
    tier: 'core',
    policy: 'conditional',
    preconditions: { fixtures: ['approved-positive-face.y4m'] },
    steps: [{ action: 'upload' }],
  });

  const verdict = evaluateRun({
    runId: 'thibit-dogfood-eval',
    scenarios,
    rawResults,
    origins: [{ origin_id: 'onboarding-web', type: 'browser_app', auth: 'session-cookie', url_source: 'APP_URL', route_families: ['/verify'], safe_for_live: true, evidence: ['onboarding/src/App.tsx'] }],
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdict.certification_status, 'UNPROVEN');
  assert.strictEqual(verdict.run_integrity, 'COMPLETE');
  assert.strictEqual(verdict.exit_code, 2);
  assert.strictEqual(verdict.summary.passed, 17);
  assert.strictEqual(verdict.summary.failed, 0);
  assert.strictEqual(verdict.summary.unproven, 1);
  console.log('✓ Thibit Dogfood Golden Test passed (17 passed, 1 unproven -> Exit 2)');
}

// 10. Deterministic Replay Test
{
  const sampleScenarios = [
    { id: 'SCEN-01', name: 'Step 1', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] },
    { id: 'SCEN-02', name: 'Step 2', origin_id: 'web', tier: 'core', policy: 'conditional', steps: [{ action: 'click' }] },
  ];
  const sampleRaw = [{ id: 'SCEN-01', failed: false }];
  const fixedTime = '2026-08-30T18:00:00.000Z';

  const firstVerdict = JSON.stringify(evaluateRun({
    runId: 'replay-test',
    scenarios: sampleScenarios,
    rawResults: sampleRaw,
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    evaluationTime: fixedTime,
    skipIntegrityVerification: true,
  }));

  for (let i = 0; i < 100; i++) {
    const replayVerdict = JSON.stringify(evaluateRun({
      runId: 'replay-test',
      scenarios: sampleScenarios,
      rawResults: sampleRaw,
      origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
      evaluationTime: fixedTime,
      skipIntegrityVerification: true,
    }));
    assert.strictEqual(replayVerdict, firstVerdict, `Replay mismatch at iteration ${i}`);
  }
  console.log('✓ 100x Deterministic replay verified: identical byte output guaranteed');
}

// 11. Secret Redactor Test
{
  const redactor = new SecretRedactor(['super-secret-seed-key']);
  const rawText = 'Authorization: Bearer abcdef123456\nDATABASE_URL=postgres://user:super_secret_pw@localhost:5432/db\nAPI_KEY=super-secret-seed-key';
  const redacted = redactor.redactText(rawText);

  assert.ok(!redacted.includes('abcdef123456'), 'Bearer token should be redacted');
  assert.ok(!redacted.includes('super_secret_pw'), 'Password in URL should be redacted');
  assert.ok(!redacted.includes('super-secret-seed-key'), 'Custom seed key should be redacted');
  console.log('✓ Secret Redactor passed (Bearer, URL credentials, seed patterns redacted)');
}

console.log('\nAll Evaluator, Sealer, and Observation Regression Tests PASSED successfully!');
