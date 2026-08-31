import fs from 'node:fs';
import path from 'node:path';
import { EvidenceSealer } from './sealer.js';
import { validateVerdict } from './validator.js';

/**
 * Pure-function deterministic release adjudication engine.
 */
export function evaluateRun({
  runId,
  evidenceDir,
  scenarios = [],
  rawResults = [],
  origins = [],
  brandContract = null,
  canaryResults = [],
  waivers = [],
  startedAt = null,
  evaluationTime = new Date().toISOString(),
  harnessErrors = [],
  networkViolations = [],
  skipIntegrityVerification = false,
}) {
  const evalDate = new Date(evaluationTime);
  const discoveredCauses = new Set();
  const violations = [];

  // 1. Evidence integrity verification and sealed policy/result ingestion
  let evidenceManifestSha256 = '0000000000000000000000000000000000000000000000000000000000000000';
  let evidenceInvalid = false;
  let chronologyInvalid = false;
  let sealedManifest = null;

  if (!skipIntegrityVerification && evidenceDir) {
    const sealer = new EvidenceSealer(evidenceDir, runId);
    const integrity = sealer.verifyIntegrity();
    if (!integrity.ok) {
      evidenceInvalid = true;
      violations.push({
        type: 'EVIDENCE_INTEGRITY_VIOLATION',
        description: integrity.error,
        details: { missing: integrity.missingFiles, modified: integrity.modifiedFiles, unexpected: integrity.unexpectedFiles },
      });
    } else {
      evidenceManifestSha256 = integrity.manifestSha256;
      sealedManifest = integrity.manifest;

      // Timestamp Chronology Verification: started_at <= sealed_at <= evaluation_time
      if (startedAt && sealedManifest.sealed_at) {
        const startTimestamp = new Date(startedAt).getTime();
        const sealedTimestamp = new Date(sealedManifest.sealed_at).getTime();
        const evalTimestamp = evalDate.getTime();

        if (sealedTimestamp < startTimestamp) {
          chronologyInvalid = true;
          violations.push({
            type: 'TIMESTAMP_CHRONOLOGY_VIOLATION',
            description: `Invalid chronology: sealed_at (${sealedManifest.sealed_at}) is earlier than started_at (${startedAt})`,
          });
        } else if (evalTimestamp < sealedTimestamp) {
          chronologyInvalid = true;
          violations.push({
            type: 'TIMESTAMP_CHRONOLOGY_VIOLATION',
            description: `Invalid chronology: evaluation_time (${evaluationTime}) is earlier than sealed_at (${sealedManifest.sealed_at})`,
          });
        }
      }

      // Ingest sealed policy snapshot (Deterministic Replay)
      const policySnapshotFile = path.join(evidenceDir, 'policy-snapshot.json');
      if (fs.existsSync(policySnapshotFile)) {
        try {
          const sealedPolicy = JSON.parse(fs.readFileSync(policySnapshotFile, 'utf8'));

          if (scenarios.length === 0 && Array.isArray(sealedPolicy.scenarios)) {
            scenarios = sealedPolicy.scenarios;
          }
          if (origins.length === 0 && Array.isArray(sealedPolicy.origins)) {
            origins = sealedPolicy.origins;
          }
          if (waivers.length === 0 && Array.isArray(sealedPolicy.waivers)) {
            waivers = sealedPolicy.waivers;
          }
          if (!brandContract && sealedPolicy.brand_contract) {
            brandContract = sealedPolicy.brand_contract;
          }

          // Verify that unsealed caller parameters do not contradict the sealed policy snapshot
          if (Array.isArray(sealedPolicy.scenarios) && scenarios.length > 0) {
            const sealedScenMap = new Map(sealedPolicy.scenarios.map((s) => [s.id, s]));
            for (const s of scenarios) {
              const matchedSealed = sealedScenMap.get(s.id);
              if (!matchedSealed || matchedSealed.policy !== s.policy) {
                evidenceInvalid = true;
                violations.push({
                  type: 'POLICY_SUBSTITUTION_VIOLATION',
                  description: `Caller-provided unsealed scenario "${s.id}" conflicts with sealed policy snapshot`,
                });
              }
            }
          }
        } catch (e) {
          evidenceInvalid = true;
          violations.push({
            type: 'EVIDENCE_CORRUPTION_ERROR',
            description: `Failed to parse sealed policy-snapshot.json: ${e.message}`,
          });
        }
      }

      // Load sealed raw results if available
      const rawResultsFile = path.join(evidenceDir, 'raw-results.json');
      if (fs.existsSync(rawResultsFile)) {
        try {
          const sealedRawResults = JSON.parse(fs.readFileSync(rawResultsFile, 'utf8'));
          if (rawResults.length === 0) {
            rawResults = sealedRawResults;
          }
        } catch (e) {
          evidenceInvalid = true;
          violations.push({
            type: 'EVIDENCE_CORRUPTION_ERROR',
            description: `Failed to parse sealed raw-results.json: ${e.message}`,
          });
        }
      }
    }
  }

  // 2. Enforce Coverage Floors (Zero scenarios or zero required scenarios cannot certify PASS)
  let coverageFloorViolated = false;
  if (scenarios.length === 0) {
    coverageFloorViolated = true;
    discoveredCauses.add('HARNESS_CONFIGURATION');
    violations.push({
      type: 'COVERAGE_FLOOR_VIOLATION',
      description: 'Zero scenarios discovered: quality gate cannot pass without executable scenario coverage',
    });
  } else {
    const requiredScenariosCount = scenarios.filter((s) => s.policy === 'required').length;
    if (requiredScenariosCount === 0) {
      discoveredCauses.add('HARNESS_CONFIGURATION');
      violations.push({
        type: 'COVERAGE_FLOOR_VIOLATION',
        description: 'Zero required scenarios declared: all-skipped/all-conditional/all-manual suites cannot certify PASS',
      });
    }

    // Required origin coverage floor (all browser_app and api origins must have declared scenario coverage)
    const requiredOriginIds = origins.filter((o) => o.type === 'browser_app' || o.type === 'api').map((o) => o.origin_id);
    const coveredOriginIds = new Set(scenarios.map((s) => s.origin_id));
    for (const oId of requiredOriginIds) {
      if (!coveredOriginIds.has(oId)) {
        discoveredCauses.add('HARNESS_CONFIGURATION');
        violations.push({
          type: 'COVERAGE_FLOOR_VIOLATION',
          description: `Required origin "${oId}" has zero scenario coverage`,
        });
      }
    }
  }

  // 3. Index raw execution results
  const rawMap = new Map(rawResults.map((r) => [r.id || r.scenario_id, r]));
  const canaryMap = new Map(canaryResults.map((c) => [c.origin_id || c.canary_id, c]));

  // Index active valid waivers
  const activeWaiverMap = new Map();
  for (const w of waivers) {
    if (!w.scenario_id || !w.expires_at || !w.created_at) continue;
    const createdAt = new Date(w.created_at);
    const expiresAt = new Date(w.expires_at);
    if (createdAt <= evalDate && evalDate <= expiresAt) {
      activeWaiverMap.set(w.scenario_id, w);
    }
  }

  // 4. Evaluate each scenario directly from sealed observations
  const evaluatedScenarios = [];

  for (const scenario of scenarios) {
    const raw = rawMap.get(scenario.id);
    const waiver = activeWaiverMap.get(scenario.id);

    let status = 'PASS';
    let disposition = 'EXECUTED';
    let cause = 'NONE';
    let errorMessage = raw?.error_message || undefined;

    // Check waivers first
    if (waiver) {
      if (waiver.policy_override === 'unsupported') {
        status = 'SKIPPED';
        disposition = 'WAIVED';
        cause = 'NONE';
      } else if (waiver.policy_override === 'manual') {
        status = 'SKIPPED';
        disposition = 'MANUAL_APPROVED';
        cause = 'NONE';
      }
    } else if (scenario.policy === 'unsupported') {
      status = 'FAIL';
      disposition = 'CONDITION_UNMET';
      cause = 'HARNESS_CONFIGURATION';
      errorMessage = 'Unsupported scenario executed without valid active waiver';
    } else if (scenario.policy === 'manual') {
      status = 'FAIL';
      disposition = 'CONDITION_UNMET';
      cause = 'HARNESS_CONFIGURATION';
      errorMessage = 'Manual scenario requires explicit structured sign-off';
    } else if (!raw) {
      // Scenario was not executed
      if (scenario.policy === 'required') {
        status = 'FAIL';
        disposition = 'CONDITION_UNMET';
        cause = 'HARNESS_FIXTURE_MISSING';
        errorMessage = 'Required scenario was not executed';
      } else if (scenario.policy === 'conditional') {
        status = 'UNPROVEN';
        disposition = 'CONDITION_UNMET';
        cause = 'HARNESS_FIXTURE_MISSING';
        errorMessage = 'Conditional scenario preconditions unmet (e.g. fixture absent)';
      }
    } else {
      // Scenario was executed - evaluate from sealed observations
      const durationMs = raw.duration_ms;
      const evidenceFiles = raw.evidence_files || [];

      // Check Gate-Relative Skip Policy (Playwright test.skip() on required scenario fails gate)
      if (scenario.policy === 'required' && (raw.status === 'SKIPPED' || raw.disposition === 'SKIPPED')) {
        status = 'FAIL';
        disposition = 'EXECUTED';
        cause = 'PRODUCT_BUG';
        errorMessage = 'Required scenario skipped during execution without valid active waiver';
      } else if (raw.failed) {
        status = 'FAIL';
        disposition = 'EXECUTED';
        cause = raw.cause || 'PRODUCT_BUG';
        errorMessage = raw.error_message || 'Assertion failed';
      } else if (raw.unproven) {
        status = 'UNPROVEN';
        disposition = raw.disposition || 'CONDITION_UNMET';
        cause = raw.cause || 'HARNESS_FIXTURE_MISSING';
      } else {
        // Enforce non-empty observation set: scenario cannot pass from 0 steps and 0 assertions
        const totalObservations = (raw.network_observations?.length || 0) + (raw.side_effect_observations?.length || 0);
        if (Array.isArray(raw.steps_executed) && raw.steps_executed.length === 0 && totalObservations === 0 && !scenario.negative_control) {
          status = 'FAIL';
          disposition = 'EXECUTED';
          cause = 'PRODUCT_BUG';
          errorMessage = 'Scenario passed with an empty observation set (zero steps executed and zero assertions observed)';
        }

        // Deep verification from sealed negative control observations
        if (scenario.negative_control) {
          const obs = raw.negative_control_observations;
          if (obs) {
            if (obs.actual_http_status >= 200 && obs.actual_http_status < 300) {
              status = 'FAIL';
              disposition = 'EXECUTED';
              cause = 'PRODUCT_BUG';
              errorMessage = `Negative control failed: expected rejection HTTP ${obs.expected_http_status}, but observed HTTP ${obs.actual_http_status} (unexpected success)`;
            } else if (!obs.status_matched) {
              status = 'FAIL';
              disposition = 'EXECUTED';
              cause = 'PRODUCT_BUG';
              errorMessage = `Negative control failed: expected HTTP ${obs.expected_http_status}, got HTTP ${obs.actual_http_status}`;
            } else if (!obs.reason_matched) {
              status = 'FAIL';
              disposition = 'EXECUTED';
              cause = 'PRODUCT_BUG';
              errorMessage = `Negative control failed: expected rejection reason "${obs.expected_rejection_reason}", but observed "${obs.actual_rejection_reason}"`;
            }
          } else if (!raw.negative_control_passed) {
            status = 'FAIL';
            disposition = 'EXECUTED';
            cause = 'PRODUCT_BUG';
            errorMessage = `Negative control failed: expected rejection "${scenario.negative_control.expected_rejection_reason}" did not occur or wrong HTTP status`;
          }
        }

        // Deep verification from sealed side-effect observations
        if (Array.isArray(raw.side_effect_observations) && raw.side_effect_observations.length > 0) {
          for (const probeObs of raw.side_effect_observations) {
            if (!probeObs.passed) {
              status = 'FAIL';
              disposition = 'EXECUTED';
              cause = 'PRODUCT_BUG';
              errorMessage = `Side-effect verification failed: ${probeObs.observed_result}`;
            }
          }
        } else if (raw.side_effects_failed) {
          status = 'FAIL';
          disposition = 'EXECUTED';
          cause = 'PRODUCT_BUG';
          errorMessage = `Side-effect verification failed: ${raw.side_effect_error || 'Probe assertion failed'}`;
        }
      }

      // Check brand canary if applicable for this origin
      if (brandContract && brandContract.origins && brandContract.origins[scenario.origin_id]) {
        const originBrand = brandContract.origins[scenario.origin_id];
        if (originBrand.canary) {
          const canaryRes = canaryMap.get(scenario.origin_id) || canaryMap.get(originBrand.canary.id);
          if (!canaryRes || canaryRes.verdict !== originBrand.canary.expected_verdict) {
            status = 'UNPROVEN';
            cause = 'HARNESS_CANARY_MISMATCH';
            errorMessage = `Brand canary mismatch for origin "${scenario.origin_id}": expected "${originBrand.canary.expected_verdict}", got "${canaryRes?.verdict || 'none'}"`;
          }
        }
      }
    }

    if (cause !== 'NONE') {
      discoveredCauses.add(cause);
    }

    evaluatedScenarios.push({
      id: scenario.id,
      name: scenario.name,
      origin_id: scenario.origin_id,
      policy: scenario.policy,
      status,
      disposition,
      cause,
      duration_ms: raw?.duration_ms,
      evidence_files: raw?.evidence_files,
      error_message: errorMessage,
    });
  }

  // 5. Process network egress violations
  for (const violation of networkViolations) {
    violations.push({
      type: 'NETWORK_EGRESS_VIOLATION',
      description: `Undeclared network egress to ${violation.host}:${violation.port}`,
      details: violation,
    });
    if (violation.attributed_to === 'product') {
      discoveredCauses.add('PRODUCT_BUG');
    } else if (violation.attributed_to === 'harness_config') {
      discoveredCauses.add('HARNESS_CONFIGURATION');
    } else {
      discoveredCauses.add('HARNESS_ENVIRONMENT');
    }
  }

  // 6. Process explicit harness errors
  for (const err of harnessErrors) {
    discoveredCauses.add(err.cause || 'HARNESS_ENVIRONMENT');
    violations.push({
      type: 'HARNESS_RUNTIME_ERROR',
      description: err.message || 'Harness runtime fault',
      details: err,
    });
  }

  // 7. Roll up summaries by origin
  const byOrigin = {};
  const allOriginIds = new Set([
    ...origins.map((o) => o.origin_id),
    ...scenarios.map((s) => s.origin_id),
  ]);

  for (const oId of allOriginIds) {
    byOrigin[oId] = { total: 0, passed: 0, failed: 0, unproven: 0, skipped: 0, status: 'PASS' };
  }

  for (const s of evaluatedScenarios) {
    const o = byOrigin[s.origin_id] || (byOrigin[s.origin_id] = { total: 0, passed: 0, failed: 0, unproven: 0, skipped: 0, status: 'PASS' });
    o.total++;
    if (s.status === 'PASS') o.passed++;
    else if (s.status === 'FAIL') o.failed++;
    else if (s.status === 'UNPROVEN') o.unproven++;
    else if (s.status === 'SKIPPED') o.skipped++;
  }

  for (const oId of Object.keys(byOrigin)) {
    const o = byOrigin[oId];
    if (o.failed > 0) {
      o.status = 'FAIL';
    } else if (o.unproven > 0 || (o.total > 0 && o.passed === 0 && o.skipped === 0)) {
      o.status = 'UNPROVEN';
    } else {
      o.status = 'PASS';
    }
  }

  // Check required origins with zero coverage
  for (const oId of origins.filter((o) => o.type === 'browser_app' || o.type === 'api').map((o) => o.origin_id)) {
    if (byOrigin[oId] && byOrigin[oId].total === 0) {
      byOrigin[oId].status = 'FAIL';
    }
  }

  const summary = {
    total: evaluatedScenarios.length,
    passed: evaluatedScenarios.filter((s) => s.status === 'PASS').length,
    failed: evaluatedScenarios.filter((s) => s.status === 'FAIL').length,
    unproven: evaluatedScenarios.filter((s) => s.status === 'UNPROVEN').length,
    error: evaluatedScenarios.filter((s) => s.status === 'ERROR').length,
    skipped: evaluatedScenarios.filter((s) => s.status === 'SKIPPED').length,
    by_origin: byOrigin,
  };

  // 8. Resolve top-level certification_status, run_integrity, and exit_code via aggregation lattice
  let certificationStatus = 'PASS';
  const hasUncoveredRequiredOrigins = origins
    .filter((o) => o.type === 'browser_app' || o.type === 'api')
    .some((o) => byOrigin[o.origin_id]?.status === 'FAIL');

  const requiredCount = scenarios.filter((s) => s.policy === 'required').length;
  const isAllSkippedOrConditional = scenarios.length > 0 && (requiredCount === 0 || summary.passed === 0 && summary.skipped > 0);

  if (summary.failed > 0 || networkViolations.length > 0 || hasUncoveredRequiredOrigins) {
    certificationStatus = 'FAIL';
  } else if (summary.unproven > 0 || isAllSkippedOrConditional || coverageFloorViolated) {
    certificationStatus = 'UNPROVEN';
  }

  let runIntegrity = 'COMPLETE';
  if (evidenceInvalid) {
    runIntegrity = 'EVIDENCE_INVALID';
  } else if (harnessErrors.length > 0 || chronologyInvalid || coverageFloorViolated) {
    runIntegrity = 'HARNESS_ERROR';
    discoveredCauses.add('HARNESS_CONFIGURATION');
  }

  let exitCode = 0;
  if (runIntegrity === 'EVIDENCE_INVALID') {
    exitCode = 4;
  } else if (runIntegrity === 'HARNESS_ERROR') {
    exitCode = 3;
  } else if (certificationStatus === 'FAIL') {
    exitCode = 1;
  } else if (certificationStatus === 'UNPROVEN') {
    exitCode = 2;
  } else {
    exitCode = 0;
  }

  const causesArray = Array.from(discoveredCauses).sort();
  if (causesArray.length === 0) {
    causesArray.push('NONE');
  }

  const verdict = {
    schema_version: '1.0.0',
    run_id: runId,
    evaluation_time: evaluationTime,
    certification_status: certificationStatus,
    run_integrity: runIntegrity,
    exit_code: exitCode,
    causes: causesArray,
    scenarios: evaluatedScenarios,
    summary,
    evidence_manifest_sha256: evidenceManifestSha256,
    violations: violations.length > 0 ? violations : undefined,
  };

  validateVerdict(verdict);
  return verdict;
}
