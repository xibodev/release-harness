import fs from 'node:fs';
import path from 'node:path';
import { EvidenceSealer } from './sealer.js';
import { validateVerdict, validateAgainstSchema, validateNetworkPolicy } from './validator.js';
import { Schemas } from '../../release-harness-schemas/index.js';

/**
 * The cause to record for a failure that carries its own attribution.
 *
 * A probe reports `cause: 'NONE'` alongside `ok: true`, so a raw `||` would
 * survive an inverted `passed` flag and file a FAIL under "no cause" — which
 * `discoveredCauses` skips, producing a failed run whose causes list is empty.
 * Absent, empty and 'NONE' all mean "the probe did not attribute this", and the
 * default for an unattributed failure is the product.
 */
function failureCause(reported) {
  if (!reported || reported === 'NONE') return 'PRODUCT_BUG';
  return reported;
}

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
  harnessErrors = [...harnessErrors];
  networkViolations = [...networkViolations];
  let runtime = null;
  let sealedPolicy = null;

  // 1. Evidence integrity verification and sealed policy/result ingestion
  let evidenceManifestSha256 = '0000000000000000000000000000000000000000000000000000000000000000';
  let evidenceInvalid = false;
  let chronologyInvalid = false;
  let sealedManifest = null;

  if (!skipIntegrityVerification && evidenceDir) {
    // Caller observations never participate in a sealed adjudication, including
    // older bundles. Missing historical policy/canaries remain non-certifying.
    scenarios = [];
    origins = [];
    waivers = [];
    brandContract = null;
    canaryResults = [];
    startedAt = null;
    rawResults = [];
    harnessErrors = [];
    networkViolations = [];
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

      if (!Number.isFinite(evalDate.getTime()) || evalDate.getTime() < Date.parse(sealedManifest.sealed_at)) {
        chronologyInvalid = true;
        violations.push({ type: 'TIMESTAMP_CHRONOLOGY_VIOLATION', description: 'evaluation_time must be at or after sealed_at' });
      }

      // Ingest sealed policy snapshot (Deterministic Replay)
      const policySnapshotFile = path.join(evidenceDir, 'policy-snapshot.json');
      if (fs.existsSync(policySnapshotFile)) {
        try {
          sealedPolicy = sealer.readVerifiedJson('policy-snapshot.json', sealedManifest);
          if (!sealedPolicy || typeof sealedPolicy !== 'object') throw new Error('Invalid policy snapshot');
          for (const key of ['scenarios', 'origins', 'waivers']) {
            if (sealedPolicy[key] !== undefined && !Array.isArray(sealedPolicy[key])) throw new Error(`Invalid policy ${key}`);
          }
          if (sealedPolicy.network_policy != null) validateNetworkPolicy(sealedPolicy.network_policy);

          // Sealed policy is authoritative even when callers supply live objects.
          scenarios = sealedPolicy.scenarios || [];
          origins = sealedPolicy.origins || [];
          waivers = sealedPolicy.waivers || [];
          brandContract = sealedPolicy.brand_contract || null;
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
      rawResults = [];
      if (fs.existsSync(rawResultsFile)) {
        try {
          const sealedRawResults = sealer.readVerifiedJson('raw-results.json', sealedManifest);
          if (!Array.isArray(sealedRawResults)) throw new Error('raw-results.json must be an array');
          for (const raw of sealedRawResults) {
            if (!raw || typeof raw !== 'object') throw new Error('Invalid raw result');
            for (const key of ['network_violations', 'network_observations', 'side_effect_observations']) {
              if (raw[key] !== undefined && (!Array.isArray(raw[key]) || raw[key].some((v) => !v || typeof v !== 'object'))) throw new Error(`Invalid result ${key}`);
            }
          }
          rawResults = sealedRawResults;
        } catch (e) {
          evidenceInvalid = true;
          violations.push({
            type: 'EVIDENCE_CORRUPTION_ERROR',
            description: `Failed to parse sealed raw-results.json: ${e.message}`,
          });
        }
      }
      const runtimeFile = path.join(evidenceDir, 'runtime-observations.json');
      if (fs.existsSync(runtimeFile)) {
        try {
          runtime = sealer.readVerifiedJson('runtime-observations.json', sealedManifest);
          validateAgainstSchema(Schemas.RuntimeObservationsV1, runtime, 'Runtime observations');
          if (!runtime.startup.blocked && (runtime.startup.error || runtime.startup.health.some((h) => !h.healthy))) throw new Error('Startup observations contradict blocked flag');
          if (!runtime.startup.blocked && !['ready', 'not_applicable'].includes(runtime.startup.phase)) throw new Error('Startup did not reach readiness');
          if (runtime.startup.blocked && !['compose_up', 'health'].includes(runtime.startup.phase)) throw new Error('Invalid blocked startup phase');
          if (!Number.isFinite(Date.parse(runtime.started_at))) throw new Error('Invalid runtime started_at');
          startedAt = runtime.started_at;
          if (Date.parse(startedAt) > Date.parse(sealedManifest.sealed_at) || evalDate.getTime() < Date.parse(sealedManifest.sealed_at)) {
            chronologyInvalid = true;
            violations.push({ type: 'TIMESTAMP_CHRONOLOGY_VIOLATION', description: 'Runtime timestamps must satisfy started_at <= sealed_at <= evaluation_time' });
          }
          if (!fs.existsSync(rawResultsFile)) throw new Error('Required raw-results.json is missing');
        } catch (err) {
          runtime = null;
          evidenceInvalid = true;
          violations.push({ type: 'EVIDENCE_CORRUPTION_ERROR', description: err.message });
        }
      } else if (sealedPolicy?.runtime_observations_version) {
        evidenceInvalid = true;
        violations.push({ type: 'EVIDENCE_CORRUPTION_ERROR', description: 'Required runtime-observations.json is missing' });
      }
      const canaryFile = path.join(evidenceDir, 'canary-results.json');
      try {
        const observed = fs.existsSync(canaryFile)
          ? sealer.readVerifiedJson('canary-results.json', sealedManifest)
          : rawResults.flatMap((r) => r.canary_results || []);
        if (!Array.isArray(observed) || observed.some((c) => !c || typeof c !== 'object' || typeof c.verdict !== 'string' || !(c.origin_id || c.canary_id))) throw new Error('Invalid sealed canary results');
        canaryResults = observed;
      } catch (err) {
        evidenceInvalid = true;
        violations.push({ type: 'EVIDENCE_CORRUPTION_ERROR', description: err.message });
      }
      // Reconstruct these inputs from sealed observations, never caller-only arrays.
      harnessErrors = [];
      networkViolations = [];
    }
  }

  for (const raw of rawResults) {
    networkViolations.push(...(raw.network_violations || []));
    for (const obs of raw.network_observations || []) {
      if (obs.decision === 'DENIED' && !(raw.network_violations || []).some((v) => v.host === obs.host && v.port === obs.port && v.url === obs.url)) {
        networkViolations.push({ host: obs.host, port: obs.port, url: obs.url, attributed_to: 'product' });
      }
    }
    const flagged = (raw.side_effect_observations || []).filter((o) => o.is_harness_error);
    for (const obs of flagged) harnessErrors.push({ cause: obs.cause || 'HARNESS_CONFIGURATION', message: `[${raw.id || raw.scenario_id}] ${obs.observed_result}`, scenario_id: raw.id || raw.scenario_id });
    if (!flagged.length && (raw.is_harness_error || (raw.failed && ['HARNESS_ENVIRONMENT', 'HARNESS_CONFIGURATION'].includes(raw.cause)))) {
      harnessErrors.push({ cause: raw.cause || 'HARNESS_ENVIRONMENT', message: raw.error_message, scenario_id: raw.id || raw.scenario_id });
    }
  }
  // Existing direct evaluator callers can supply the same event twice. Keep diagnostics stable.
  networkViolations = [...new Map(networkViolations.map((v) => [JSON.stringify(v), v])).values()];
  harnessErrors = [...new Map(harnessErrors.map((v) => [JSON.stringify(v), v])).values()];
  let startupCause = null;
  if (runtime?.startup.blocked) {
    const startup = runtime.startup;
    startupCause = 'UNKNOWN';
    if (startup.error?.kind === 'configuration') startupCause = 'HARNESS_CONFIGURATION';
    else if (['ENOENT', 'EACCES', 'EPERM'].includes(startup.error?.code)) startupCause = 'HARNESS_ENVIRONMENT';
    else {
      const failures = startup.health.filter((h) => !h.healthy);
      const services = [...(sealedPolicy?.topology?.nodes || []), ...(sealedPolicy?.topology?.repositories || []).flatMap((r) => r.services || [])];
      // A transport failure or container exit alone cannot assign blame. Only an
      // actual 5xx from a published endpoint of a running product service does.
      const productResponse = (h) => h.probe_type === 'http' && h.status >= 500 && h.status <= 599 && !h.error_code
        && services.some((s) => s.id === h.service_id && ['browser_app', 'api', 'worker'].includes(s.type) && s.health_probe?.type === 'http'
          && (s.health_probe.expected_status ?? 200) === (h.expected_status ?? 200)
          && (s.health_probe.path || '/health') === (h.path || '/health'))
        && (startup.diagnostics?.containers || []).some((c) => c.service_id === h.service_id && c.running && !c.oom_killed && !c.error
          && Object.values(c.ports || {}).flatMap((p) => p || []).some((p) => Number(p.HostPort) === h.port
            && (p.HostIp === h.host || (p.HostIp === '0.0.0.0' && h.host === '127.0.0.1') || (p.HostIp === '::' && ['::1', '[::1]'].includes(h.host)))));
      if (!startup.error && failures.length && !startup.diagnostics?.errors?.length && failures.every(productResponse)) startupCause = 'PRODUCT_BUG';
    }
    if (startupCause !== 'PRODUCT_BUG') harnessErrors.push({ cause: startupCause, message: 'Startup/readiness failed; see sealed runtime observations', phase: startup.phase });
    discoveredCauses.add(startupCause);
    violations.push({ type: 'STARTUP_FAILURE', description: `Startup blocked scenario execution (${startupCause})`, details: { phase: startup.phase } });
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
    } else if (!raw && startupCause) {
      status = startupCause === 'PRODUCT_BUG' ? 'FAIL' : 'UNPROVEN';
      disposition = 'CONDITION_UNMET';
      cause = startupCause;
      errorMessage = 'Scenario not executed: startup/readiness failed';
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
        cause = failureCause(raw.cause);
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
              // The probe recorded why it failed. A harness gap attributed to
              // the product teaches an adopter something false about their own
              // code, so the observation's own cause wins.
              cause = failureCause(probeObs.cause);
              errorMessage = `Side-effect verification failed: ${probeObs.observed_result}`;
            }
          }
        } else if (raw.side_effects_failed) {
          status = 'FAIL';
          disposition = 'EXECUTED';
          cause = failureCause(raw.cause);
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

  if (startupCause === 'PRODUCT_BUG' || summary.failed > 0 || networkViolations.length > 0 || hasUncoveredRequiredOrigins) {
    certificationStatus = 'FAIL';
  } else if (summary.unproven > 0 || isAllSkippedOrConditional || coverageFloorViolated) {
    certificationStatus = 'UNPROVEN';
  }

  let runIntegrity = 'COMPLETE';
  if (evidenceInvalid) {
    runIntegrity = 'EVIDENCE_INVALID';
  } else if (harnessErrors.length > 0 || chronologyInvalid || coverageFloorViolated) {
    runIntegrity = 'HARNESS_ERROR';
    if (chronologyInvalid || coverageFloorViolated) discoveredCauses.add('HARNESS_CONFIGURATION');
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

  if (runtime?.execution_mode === 'DEVELOPMENT') {
    certificationStatus = 'UNPROVEN';
    if (runIntegrity === 'COMPLETE') exitCode = 2;
    discoveredCauses.add('HARNESS_CONFIGURATION');
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
    ...(runtime?.execution_mode === 'DEVELOPMENT' ? { execution_mode: 'DEVELOPMENT', certification_eligible: false } : {}),
  };

  validateVerdict(verdict);
  return verdict;
}
