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
    { id: 'SCEN-01', failed: false, duration_ms: 120, steps_executed: [{ action: 'navigate' }] },
    { id: 'SCEN-02', failed: false, duration_ms: 240, steps_executed: [{ action: 'navigate' }] },
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
    { id: 'SCEN-01', failed: false, duration_ms: 100, steps_executed: [{ action: 'navigate' }] },
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
    { id: 'SCEN-01', failed: false, duration_ms: 100, steps_executed: [{ action: 'navigate' }] },
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

// 5. Mixed failure + harness crash -> HARNESS_ERROR (Exit 3 with multi-cause)
{
  const scenarios = [
    { id: 'SCEN-01', name: 'Broken Component', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] },
  ];
  const rawResults = [
    { id: 'SCEN-01', failed: true, error_message: '500 Internal Server Error', cause: 'PRODUCT_BUG' },
  ];
  const harnessErrors = [{ message: 'Docker Compose socket timeout', cause: 'HARNESS_ENVIRONMENT' }];

  const verdict = evaluateRun({
    runId: 'run-005',
    scenarios,
    rawResults,
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    harnessErrors,
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdict.run_integrity, 'HARNESS_ERROR');
  assert.strictEqual(verdict.exit_code, 3);
  assert.ok(verdict.causes.includes('PRODUCT_BUG'));
  assert.ok(verdict.causes.includes('HARNESS_ENVIRONMENT'));
  console.log('✓ Mixed failure + harness crash golden test passed (exit 3 with multi-cause)');
}

// 6. Evidence Tampering Detection -> EVIDENCE_INVALID (Exit 4)
{
  const tmpEvidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-tamper-'));
  fs.writeFileSync(path.join(tmpEvidenceDir, 'execution.log'), 'clean log\n', 'utf8');
  fs.writeFileSync(path.join(tmpEvidenceDir, 'raw-results.json'), '[{"id":"SCEN-01","failed":false}]\n', 'utf8');

  const sealer = new EvidenceSealer(tmpEvidenceDir, 'run-tamper');
  sealer.sealEvidence();

  // Tamper with log file
  fs.writeFileSync(path.join(tmpEvidenceDir, 'execution.log'), 'tampered log injected\n', 'utf8');

  const verdict = evaluateRun({
    runId: 'run-tamper',
    evidenceDir: tmpEvidenceDir,
    scenarios: [{ id: 'SCEN-01', name: 'Test', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] }],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
  });

  assert.strictEqual(verdict.run_integrity, 'EVIDENCE_INVALID');
  assert.strictEqual(verdict.exit_code, 4);
  console.log('✓ Evidence tampering detection golden test passed (exit 4)');

  fs.rmSync(tmpEvidenceDir, { recursive: true, force: true });
}

// 7. Negative Control Observation Regression Test
{
  const negativeScenario = {
    id: 'NEG-01',
    name: 'Fake Webcam Rejection',
    origin_id: 'onboarding-web',
    tier: 'core',
    policy: 'required',
    negative_control: {
      expected_http_status: 400,
      expected_rejection_reason: 'challenge_failed',
    },
    steps: [{ action: 'navigate' }],
  };

  // Case 7a: Unexpected HTTP 200 (Success) on Negative Control MUST FAIL
  const rawUnexpectedSuccess = {
    id: 'NEG-01',
    failed: false,
    duration_ms: 100,
    steps_executed: [{ action: 'navigate' }],
    negative_control_observations: {
      expected_http_status: 400,
      actual_http_status: 200,
      expected_rejection_reason: 'challenge_failed',
      actual_rejection_reason: 'ok',
      status_matched: false,
      reason_matched: false,
    },
  };

  const verdictUnexpected = evaluateRun({
    runId: 'neg-run-1',
    scenarios: [negativeScenario],
    rawResults: [rawUnexpectedSuccess],
    origins: [{ origin_id: 'onboarding-web', type: 'browser_app', auth: 'session-cookie', url_source: 'APP_URL', route_families: ['/verify'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdictUnexpected.certification_status, 'FAIL');
  assert.strictEqual(verdictUnexpected.exit_code, 1);
  assert.strictEqual(verdictUnexpected.scenarios[0].status, 'FAIL');
  assert.ok(verdictUnexpected.scenarios[0].error_message.includes('unexpected success'));

  // Case 7b: Correct Rejection Match MUST PASS
  const rawCorrectRejection = {
    id: 'NEG-01',
    failed: false,
    duration_ms: 100,
    steps_executed: [{ action: 'navigate' }],
    negative_control_observations: {
      expected_http_status: 400,
      actual_http_status: 400,
      expected_rejection_reason: 'challenge_failed',
      actual_rejection_reason: 'challenge_failed',
      status_matched: true,
      reason_matched: true,
    },
  };

  const verdictPassed = evaluateRun({
    runId: 'neg-run-2',
    scenarios: [negativeScenario],
    rawResults: [rawCorrectRejection],
    origins: [{ origin_id: 'onboarding-web', type: 'browser_app', auth: 'session-cookie', url_source: 'APP_URL', route_families: ['/verify'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdictPassed.certification_status, 'PASS');
  assert.strictEqual(verdictPassed.exit_code, 0);
  assert.strictEqual(verdictPassed.scenarios[0].status, 'PASS');
  console.log('✓ Negative control observation & stale boolean regression tests passed');
}

// 8. Auditable Side-Effect Probe Observation Regression Test
{
  const sideEffectScenario = {
    id: 'SIDE-01',
    name: 'Document Upload with Storage Assertion',
    origin_id: 'web',
    tier: 'core',
    policy: 'required',
    expected_side_effects: [
      { service: 'minio', probe_type: 's3_object_exists' },
    ],
    steps: [{ action: 'upload' }],
  };

  // Case 8a: Probe Failed in observations MUST FAIL Evaluator
  const rawProbeFailed = {
    id: 'SIDE-01',
    failed: false,
    duration_ms: 100,
    steps_executed: [{ action: 'upload' }],
    side_effect_observations: [
      { service: 'minio', probe_type: 's3_object_exists', observed_result: 'Object absent in bucket', passed: false },
    ],
  };

  const verdictProbeFail = evaluateRun({
    runId: 'side-run-1',
    scenarios: [sideEffectScenario],
    rawResults: [rawProbeFailed],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdictProbeFail.certification_status, 'FAIL');
  assert.strictEqual(verdictProbeFail.exit_code, 1);
  assert.ok(verdictProbeFail.scenarios[0].error_message.includes('Side-effect verification failed'));

  // Case 8b: Probe Passed in observations MUST PASS Evaluator
  const rawProbePassed = {
    id: 'SIDE-01',
    failed: false,
    duration_ms: 100,
    steps_executed: [{ action: 'upload' }],
    side_effect_observations: [
      { service: 'minio', probe_type: 's3_object_exists', observed_result: 'Object verified in 8ms', passed: true },
    ],
  };

  const verdictProbePass = evaluateRun({
    runId: 'side-run-2',
    scenarios: [sideEffectScenario],
    rawResults: [rawProbePassed],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdictProbePass.certification_status, 'PASS');
  assert.strictEqual(verdictProbePass.exit_code, 0);
  console.log('✓ Auditable side-effect probe observation regression test passed');
}

// 9. Thibit Dogfood Golden Adjudication Test
{
  const scenarios = [];
  const rawResults = [];

  for (let i = 1; i <= 17; i++) {
    const id = `THIBIT-CORE-${i.toString().padStart(2, '0')}`;
    scenarios.push({ id, name: `Core scenario ${i}`, origin_id: 'onboarding-web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] });
    rawResults.push({ id, failed: false, duration_ms: 50, steps_executed: [{ action: 'navigate' }] });
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
  const sampleRaw = [{ id: 'SCEN-01', failed: false, steps_executed: [{ action: 'navigate' }] }];
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

// 12. Coverage Floor: Zero Discovered Scenarios -> HARNESS_ERROR (Exit 3)
{
  const verdict = evaluateRun({
    runId: 'empty-scenarios-run',
    scenarios: [],
    rawResults: [],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdict.run_integrity, 'HARNESS_ERROR');
  assert.strictEqual(verdict.exit_code, 3);
  assert.ok(verdict.causes.includes('HARNESS_CONFIGURATION'));
  console.log('✓ Coverage floor: Zero discovered scenarios returns HARNESS_ERROR (exit 3)');
}

// 13. Coverage Floor: Zero Required Scenarios -> UNPROVEN (Exit 2)
{
  const verdict = evaluateRun({
    runId: 'all-conditional-run',
    scenarios: [
      { id: 'SCEN-01', name: 'Optional face check', origin_id: 'web', tier: 'core', policy: 'conditional', steps: [{ action: 'upload' }] },
    ],
    rawResults: [{ id: 'SCEN-01', failed: false, steps_executed: [{ action: 'upload' }] }],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdict.certification_status, 'UNPROVEN');
  assert.strictEqual(verdict.exit_code, 2);
  assert.ok(verdict.causes.includes('HARNESS_CONFIGURATION'));
  console.log('✓ Coverage floor: Zero required scenarios returns UNPROVEN (exit 2)');
}

// 14. Coverage Floor: Uncovered Required Origin -> FAIL (Exit 1)
{
  const verdict = evaluateRun({
    runId: 'uncovered-origin-run',
    scenarios: [
      { id: 'SCEN-01', name: 'Web flow', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] },
    ],
    rawResults: [{ id: 'SCEN-01', failed: false, steps_executed: [{ action: 'navigate' }] }],
    origins: [
      { origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] },
      { origin_id: 'core-api', type: 'api', auth: 'bearer', url_source: 'API_URL', route_families: ['/api'], safe_for_live: true, evidence: ['api/routes.py'] },
    ],
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdict.certification_status, 'FAIL');
  assert.strictEqual(verdict.exit_code, 1);
  assert.strictEqual(verdict.summary.by_origin['core-api'].status, 'FAIL');
  assert.ok(verdict.causes.includes('HARNESS_CONFIGURATION'));
  console.log('✓ Coverage floor: Uncovered required origin returns FAIL (exit 1)');
}

// 15. Gate-Relative Skip Policy: Required scenario skipped during execution -> FAIL (Exit 1)
{
  const verdict = evaluateRun({
    runId: 'unexpected-skip-run',
    scenarios: [
      { id: 'SCEN-01', name: 'Crucial Checkout', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] },
    ],
    rawResults: [
      { id: 'SCEN-01', failed: false, status: 'SKIPPED', disposition: 'SKIPPED' },
    ],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdict.certification_status, 'FAIL');
  assert.strictEqual(verdict.exit_code, 1);
  assert.deepStrictEqual(verdict.causes, ['PRODUCT_BUG']);
  assert.ok(verdict.scenarios[0].error_message.includes('Required scenario skipped'));
  console.log('✓ Gate-relative skip policy: Required scenario skipped returns FAIL (exit 1)');
}

// 16. Empty Observation Set on Executed Scenario -> FAIL (Exit 1)
{
  const verdict = evaluateRun({
    runId: 'empty-obs-run',
    scenarios: [
      { id: 'SCEN-01', name: 'Ghost Test', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] },
    ],
    rawResults: [
      { id: 'SCEN-01', failed: false, steps_executed: [], network_observations: [], side_effect_observations: [] },
    ],
    origins: [{ origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] }],
    skipIntegrityVerification: true,
  });

  assert.strictEqual(verdict.certification_status, 'FAIL');
  assert.strictEqual(verdict.exit_code, 1);
  assert.deepStrictEqual(verdict.causes, ['PRODUCT_BUG']);
  assert.ok(verdict.scenarios[0].error_message.includes('empty observation set'));
  console.log('✓ Empty observation set on executed scenario returns FAIL (exit 1)');
}

// 17. Sealed Policy Snapshot & Replay Reconstruction
{
  const tmpEvidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sealed-policy-'));
  fs.writeFileSync(path.join(tmpEvidenceDir, 'execution.log'), 'execution trace\n', 'utf8');
  fs.writeFileSync(path.join(tmpEvidenceDir, 'raw-results.json'), JSON.stringify([
    { id: 'SCEN-01', failed: false, steps_executed: [{ action: 'navigate' }] }
  ]) + '\n', 'utf8');

  const sealer = new EvidenceSealer(tmpEvidenceDir, 'run-policy-seal');
  const policySnapshot = {
    schema_version: '1.0.0',
    product_slug: 'test-policy-proj',
    scenarios: [
      { id: 'SCEN-01', name: 'Sealed Auth', origin_id: 'web', tier: 'core', policy: 'required', steps: [{ action: 'navigate' }] },
    ],
    origins: [
      { origin_id: 'web', type: 'browser_app', auth: 'cookie', url_source: 'APP_URL', route_families: ['/'], safe_for_live: true, evidence: ['web/app.tsx'] },
    ],
    waivers: [],
  };

  sealer.sealEvidence(policySnapshot);

  // Replay without providing in-memory scenarios or origins -> loaded from sealed policy snapshot
  const replayVerdict = evaluateRun({
    runId: 'run-policy-seal',
    evidenceDir: tmpEvidenceDir,
  });

  assert.strictEqual(replayVerdict.certification_status, 'PASS');
  assert.strictEqual(replayVerdict.run_integrity, 'COMPLETE');
  assert.strictEqual(replayVerdict.exit_code, 0);
  assert.strictEqual(replayVerdict.scenarios.length, 1);
  assert.strictEqual(replayVerdict.scenarios[0].name, 'Sealed Auth');
  console.log('✓ Sealed policy snapshot correctly reconstructed during deterministic replay (exit 0)');

  fs.rmSync(tmpEvidenceDir, { recursive: true, force: true });
}

console.log('\nAll Evaluator, Sealer, and Observation Regression Tests PASSED successfully!');
