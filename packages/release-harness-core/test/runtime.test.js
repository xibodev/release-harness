import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DockerComposeRunner } from '../src/runner.js';
import { resolveNetworkPolicy, validateHealthProbe, validateTopology } from '../src/validator.js';
import { networkDecision, ScenarioRunner } from '../src/scenario-runner.js';
import { evaluateRun } from '../src/evaluator.js';
import { EvidenceSealer } from '../src/sealer.js';
import { SourceMaterializer } from '../src/materializer.js';
import { runCli } from '../src/cli.js';
import { probeHttp } from '../src/probes.js';

console.log('Running Docker-free startup, network policy and replay tests...');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-runtime-'));
const scenario = { id: 'S1', name: 'Smoke', origin_id: 'web', policy: 'required', tier: 'smoke', steps: [{ action: 'navigate', target: '/' }] };
const service = { id: 'web', type: 'browser_app', health_probe: { type: 'http', host: '127.0.0.1', port: 3000 } };
const topology = { schema_version: '1.0.0', product_slug: 'runtime-test', topology_type: 'monorepo', nodes: [service] };
const sealedPolicy = { scenarios: [scenario], origins: [], waivers: [], topology, network_policy: null, runtime_observations_version: '1.0.0' };
const makeRuntime = () => ({ schema_version: '1.0.0', started_at: '2026-01-01T00:00:00.000Z', execution_mode: 'CERTIFICATION', startup: { phase: 'health', blocked: true, health: [{ service_id: 'web', healthy: false, probe_type: 'http', host: '127.0.0.1', port: 3000, attempts: 1, status: 0, error_code: 'ECONNREFUSED' }], diagnostics: { containers: [], errors: [] } } });
let sequence = 0;
function sealed(runtime, raw = [], policy = sealedPolicy) {
  const evidenceDir = path.join(tmp, `evidence-${sequence++}`);
  const sealer = new EvidenceSealer(evidenceDir, 'test');
  sealer.writeEvidence('raw-results.json', JSON.stringify(raw));
  if (runtime) sealer.writeEvidence('runtime-observations.json', JSON.stringify(runtime));
  const seal = sealer.sealEvidence(policy);
  return { evidenceDir, runId: 'test', evaluationTime: seal.manifest.sealed_at };
}

try {
  const policy = { mode: 'sealed', allowed_egress: [{ host: 'example.com', port: 443 }] };
  assert.equal(resolveNetworkPolicy({ network_policy: policy }), policy);
  assert.equal(resolveNetworkPolicy({}, { network_policy: policy }), policy);
  assert.equal(resolveNetworkPolicy({ network_policy: policy }, { network_policy: { allowed_egress: [{ port: 443, host: 'EXAMPLE.COM.', purpose: 'different text' }], mode: 'sealed' } }), policy);
  assert.equal(resolveNetworkPolicy({}), null);
  assert.throws(() => resolveNetworkPolicy({ network_policy: policy }, { network_policy: { mode: 'open' } }), /Conflicting/);
  assert.throws(() => resolveNetworkPolicy({ network_policy: { mode: 'sealed', allowed_egress: [{ host: 'x', port: 0 }] } }));
  assert.equal(networkDecision('https://example.com/a', policy).allowed, true);
  for (const url of ['https://example.com:444/a', 'https://example.com.attacker.test', 'http://example.com', 'http://127.0.0.1:3001', 'http://foo.internal', 'http://192.0.2.1']) {
    assert.equal(networkDecision(url, policy, ['http://127.0.0.1:3000']).allowed, false, url);
  }
  assert.equal(networkDecision('http://127.0.0.1:3000/a', policy, ['http://127.0.0.1:3000']).allowed, true);
  assert.equal(networkDecision('http://[::1]:3000/a', policy, ['http://[::1]:3000']).allowed, true);
  assert.equal(networkDecision('https://example.org', null).allowed, true);
  assert.equal(networkDecision('https://example.org', { mode: 'open' }).allowed, true);
  for (const type of ['command', 'container-state', 'typo']) assert.throws(() => validateHealthProbe({ type }));
  assert.throws(() => validateHealthProbe({ type: 'http', port: 65535 }, 1));
  assert.throws(() => validateHealthProbe({ type: 'http', timeout_seconds: 0 }));
  assert.throws(() => validateHealthProbe({ type: 'tcp' }));
  assert.equal(validateTopology({ ...topology, legacy_field: true }), true);
  console.log('PASS: canonical/legacy/conflicting policy, exact host+port, local endpoint boundaries, health validation');

  const server = http.createServer((req, res) => {
    if (req.url === '/hang') return;
    res.writeHead(req.url === '/healthy' ? 200 : 503);
    res.end(req.url === '/large' ? 'x'.repeat(1000) : 'ready');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const runner = new DockerComposeRunner({ composeFile: path.join(tmp, 'compose.yml'), workingDir: tmp, runId: 'test' });
  runner.execCompose = () => { throw new Error('Docker is forbidden in this test'); };
  try {
    const results = await runner.healthCheckServices([
      { id: 'bad', health_probe: { type: 'http', port, path: '/' } },
      { id: 'good', health_probe: { type: 'http', port, path: '/healthy' } },
    ], 0.05);
    assert.equal(results[0].healthy, false);
    assert.equal(results[0].status, 503);
    assert.equal(results[1].healthy, true, 'Each service gets its own deadline');
    assert.ok(results.every(r => r.attempts > 0));
    const timedOut = await probeHttp({ port, path: '/hang', timeoutMs: 30 });
    assert.equal(timedOut.error_code, 'ETIMEDOUT');
    const oversized = await probeHttp({ port, path: '/large', maxBodyBytes: 10 });
    assert.equal(oversized.error_code, 'RESPONSE_TOO_LARGE');
  } finally { await new Promise(resolve => server.close(resolve)); }
  const refused = await runner.healthCheckServices([{ id: 'web', health_probe: { type: 'http', port } }], 0.05);
  assert.ok(['ECONNREFUSED', 'ECONNRESET'].includes(refused[0].error_code), 'A just-closed keepalive socket may reset before refusing');
  console.log('PASS: actual loopback 503/success/refusal produce structured bounded health observations');

  let intercepted;
  let websocket;
  const browserRunner = new ScenarioRunner({ origins: [{ origin_id: 'web', url_source: 'http://127.0.0.1:3000' }], networkPolicy: null, evidenceDir: tmp });
  const frame = {};
  const page = { mainFrame: () => frame, on() {}, async goto() {
    browserRunner.networkPolicy = policy;
    let aborted = false;
    await intercepted({ request: () => ({ frame: () => frame, url: () => 'https://example.com:444/a' }), abort: () => { aborted = true; }, continue: () => assert.fail('Wrong port was allowed') });
    assert.equal(aborted, true);
    let closed = false;
    websocket({ url: () => 'wss://example.com:444/ws', close: () => { closed = true; }, connectToServer: () => assert.fail('Wrong WebSocket port was allowed') });
    assert.equal(closed, true);
    return { status: () => 200, ok: () => true };
  } };
  const context = { newCDPSession: async () => ({ on() {}, send: async () => {} }), newPage: async () => page, route: async (_, handler) => { intercepted = handler; }, routeWebSocket: async (_, handler) => { websocket = handler; }, close: async () => {} };
  browserRunner.playwright = { chromium: { launch: async () => ({ newContext: async options => { assert.equal(options.serviceWorkers, 'block'); return context; }, close: async () => {} }) } };
  const browserRaw = await browserRunner.runScenario(scenario);
  assert.equal(browserRaw.network_violations[0].port, 444);
  assert.equal(evaluateRun(sealed(null, [browserRaw], { ...sealedPolicy, runtime_observations_version: undefined })).exit_code, 1);
  browserRunner.playwright = { chromium: { launch: async () => { throw new Error('Proxy/browser guard setup unsupported'); } } };
  const unsupportedBrowser = await browserRunner.runScenario(scenario);
  assert.equal(unsupportedBrowser.cause, 'HARNESS_ENVIRONMENT');
  assert.equal(evaluateRun(sealed(null, [unsupportedBrowser], { ...sealedPolicy, runtime_observations_version: undefined })).exit_code, 3);
  console.log('PASS: browser interception records denied host/port as sealed evaluator input');

  const ambiguous = makeRuntime();
  const options = sealed(ambiguous);
  const unknown = evaluateRun(options);
  assert.equal(unknown.exit_code, 3);
  assert.deepEqual(unknown.causes, ['UNKNOWN']);
  assert.equal(unknown.scenarios[0].status, 'UNPROVEN');
  assert.equal(unknown.scenarios[0].disposition, 'CONDITION_UNMET');
  assert.ok(!unknown.causes.includes('HARNESS_FIXTURE_MISSING'));
  assert.deepEqual(evaluateRun({ ...options, rawResults: [{ id: 'S1', failed: false }], networkViolations: [{ host: 'invented', port: 1 }], harnessErrors: [{ cause: 'PRODUCT_BUG' }] }), unknown, 'Live arrays cannot override sealed observations');
  const product = makeRuntime();
  product.startup.health[0].status = 503;
  product.startup.health[0].error_code = null;
  product.startup.diagnostics.containers.push({ service_id: 'web', running: true, oom_killed: false, error: '', ports: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3000' }] } });
  assert.equal(evaluateRun(sealed(product)).exit_code, 1);
  for (const mutate of [r => { r.startup.diagnostics.containers[0].oom_killed = true; }, r => { r.startup.diagnostics.containers[0].ports = {}; }, r => { r.startup.diagnostics.errors = ['inspect failed']; }, r => { r.startup.health[0].status = 404; }]) {
    const altered = structuredClone(product); mutate(altered);
    assert.equal(evaluateRun(sealed(altered)).exit_code, 3);
  }
  const dev = structuredClone(product); dev.execution_mode = 'DEVELOPMENT';
  assert.equal(evaluateRun(sealed(dev)).exit_code, 2);
  ambiguous.execution_mode = 'DEVELOPMENT';
  assert.equal(evaluateRun(sealed(ambiguous)).exit_code, 3);
  const env = makeRuntime(); env.startup.error = { code: 'ENOENT' };
  assert.ok(evaluateRun(sealed(env)).causes.includes('HARNESS_ENVIRONMENT'));
  const tamper = sealed(product);
  fs.appendFileSync(path.join(tamper.evidenceDir, 'runtime-observations.json'), ' ');
  assert.equal(evaluateRun(tamper).exit_code, 4);
  const missing = sealed(product);
  fs.rmSync(path.join(missing.evidenceDir, 'runtime-observations.json'));
  assert.equal(evaluateRun(missing).exit_code, 4);
  assert.equal(evaluateRun(sealed(null)).exit_code, 4, 'New snapshots require runtime evidence');
  const malformed = makeRuntime(); malformed.schema_version = '9.0.0';
  assert.equal(evaluateRun(sealed(malformed)).exit_code, 4);
  const future = makeRuntime(); future.started_at = '2999-01-01T00:00:00.000Z';
  assert.equal(evaluateRun(sealed(future)).exit_code, 3);
  console.log('PASS: startup attribution, blocked-not-fixture-missing, development, chronology and tamper precedence');

  const raw = [{ id: 'S1', failed: true, cause: 'HARNESS_CONFIGURATION', side_effect_observations: [{ passed: false, is_harness_error: true, cause: 'HARNESS_CONFIGURATION', observed_result: 'Unsupported probe' }], network_violations: [{ host: 'external.test', port: 443, attributed_to: 'product' }] }];
  const legacyOptions = sealed(null, raw, { ...sealedPolicy, runtime_observations_version: undefined });
  const replay = evaluateRun(legacyOptions);
  assert.equal(replay.exit_code, 3);
  assert.ok(replay.causes.includes('PRODUCT_BUG'));
  assert.equal(replay.violations.filter(v => v.type === 'HARNESS_RUNTIME_ERROR').length, 1);
  assert.equal(replay.violations.filter(v => v.type === 'NETWORK_EGRESS_VIOLATION').length, 1);
  assert.deepEqual(evaluateRun({ ...legacyOptions, harnessErrors: [{ cause: 'UNKNOWN' }] }), replay);
  const passedWithEgress = sealed(null, [{ id: 'S1', failed: false, steps_executed: [{}], network_violations: raw[0].network_violations }], { ...sealedPolicy, runtime_observations_version: undefined });
  assert.equal(evaluateRun(passedWithEgress).exit_code, 1);
  const deniedOnly = sealed(null, [{ id: 'S1', failed: false, steps_executed: [{}], network_observations: [{ host: 'external.test', port: 443, decision: 'DENIED' }] }], { ...sealedPolicy, runtime_observations_version: undefined });
  assert.equal(evaluateRun(deniedOnly).exit_code, 1);
  console.log('PASS: legacy sealed results reconstruct harness and network events without live arrays');

  const lifecycle = new DockerComposeRunner({ composeFile: path.join(tmp, 'compose.yml'), workingDir: tmp, runId: 'test' });
  const events = [];
  lifecycle.execCompose = args => { events.push(args[0]); if (args[0] === 'up') throw new Error('partial startup'); return ''; };
  await assert.rejects(lifecycle.up());
  lifecycle.teardown();
  assert.deepEqual(events, ['up', 'down']);
  lifecycle.running = true;
  lifecycle.execCompose = () => { throw new Error('down failed'); };
  assert.equal(lifecycle.teardown(), false);
  assert.equal(lifecycle.running, true, 'Failed teardown remains retryable');
  const diagnosticRunner = new DockerComposeRunner({ composeFile: path.join(tmp, 'compose.yml'), workingDir: tmp, runId: 'test' });
  diagnosticRunner.execCompose = args => { assert.equal(args[0], 'ps', 'Arbitrary container logs must never be requested'); return 'a'.repeat(64); };
  diagnosticRunner.execDocker = () => JSON.stringify({ id: 'a'.repeat(64), project: 'rh-test', service: 'web', state: { Running: false, Status: 'exited', ExitCode: 1, Error: '' }, ports: {} });
  const diagnostics = diagnosticRunner.collectDiagnostics();
  assert.equal(diagnostics.containers[0].exit_code, 1);
  assert.equal(diagnostics.logs, undefined);
  assert.equal(diagnostics.logs_omitted, true);
  console.log('PASS: partial-up teardown and bounded redacted diagnostics');

  // Exercise run-local finalization with only Docker and source materialization doubled.
  const fixture = path.join(tmp, 'fixture');
  fs.mkdirSync(path.join(fixture, '.release-harness', 'scenarios'), { recursive: true });
  fs.writeFileSync(path.join(fixture, '.release-harness', 'topology.json'), JSON.stringify(topology));
  fs.writeFileSync(path.join(fixture, '.release-harness', 'harness.config.json'), JSON.stringify({ schema_version: '1.0.0', product_slug: 'runtime-test', harness_version: '1.2.0', port_block: { start: 3000, range: 10 }, network_policy: policy }));
  fs.writeFileSync(path.join(fixture, '.release-harness', 'scenarios', 'smoke.json'), JSON.stringify(scenario));
  fs.writeFileSync(path.join(fixture, 'docker-compose.yml'), 'services: {}');
  const originals = { materialize: SourceMaterializer.prototype.materializeRepo, cleanup: SourceMaterializer.prototype.cleanup, up: DockerComposeRunner.prototype.up, health: DockerComposeRunner.prototype.healthCheckServices, diagnostics: DockerComposeRunner.prototype.collectDiagnostics, exec: DockerComposeRunner.prototype.execCompose, scenario: ScenarioRunner.prototype.runScenario };
  const cwd = process.cwd();
  const cliEvents = [];
  try {
    SourceMaterializer.prototype.materializeRepo = function () { return { targetDir: fixture, sourceInfo: { commitSha: 'a'.repeat(40), isClean: true, statusResolved: true }, stats: { fileCount: 0, byteCount: 0, emptyDirCount: 0, elapsedMs: 0, strategy: 'test', warnings: [] } }; };
    SourceMaterializer.prototype.cleanup = () => cliEvents.push('cleanup');
    DockerComposeRunner.prototype.up = async function () { this.running = true; return { artifacts: [] }; };
    DockerComposeRunner.prototype.healthCheckServices = async () => makeRuntime().startup.health;
    DockerComposeRunner.prototype.collectDiagnostics = () => { cliEvents.push('diagnostics'); return { containers: [], errors: [], logs: 'password=secretvalue' }; };
    DockerComposeRunner.prototype.execCompose = args => { assert.equal(args[0], 'down'); cliEvents.push('down'); return ''; };
    ScenarioRunner.prototype.runScenario = () => { throw new Error('Blocked scenarios must not execute'); };
    process.chdir(fixture);
    const root = path.join(tmp, 'cli-evidence');
    assert.equal(await runCli(['run-local', '--evidence-dir', root, '--run-id', 'cli']), 3);
    const runDir = path.join(root, 'runs', 'cli');
    const v = JSON.parse(fs.readFileSync(path.join(runDir, 'verdict.json')));
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'run.manifest.json')));
    assert.ok(manifest.verdict_sha256);
    assert.deepEqual(cliEvents, ['diagnostics', 'down', 'cleanup']);
    DockerComposeRunner.prototype.up = async function () { this.running = true; return { artifacts: [] }; };
    DockerComposeRunner.prototype.healthCheckServices = async () => [];
    ScenarioRunner.prototype.runScenario = async function () { assert.deepEqual(this.networkPolicy, policy); return { id: 'S1', failed: false, steps_executed: [{}], network_violations: [{ host: 'example.com', port: 444, attributed_to: 'product' }] }; };
    assert.equal(await runCli(['run-local', '--evidence-dir', root, '--run-id', 'egress']), 1);
    const networkRun = path.join(root, 'runs', 'egress');
    const networkVerdict = JSON.parse(fs.readFileSync(path.join(networkRun, 'verdict.json')));
    assert.equal(JSON.stringify(evaluateRun({ evidenceDir: path.join(networkRun, 'evidence'), runId: 'egress', evaluationTime: networkVerdict.evaluation_time }), null, 2) + '\n', fs.readFileSync(path.join(networkRun, 'verdict.json'), 'utf8'));
    const evidenceDir = path.join(runDir, 'evidence');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(evidenceDir, 'policy-snapshot.json'))).network_policy, policy);
    assert.ok(!fs.readFileSync(path.join(evidenceDir, 'runtime-observations.json'), 'utf8').includes('secretvalue'));
    assert.equal(JSON.stringify(evaluateRun({ evidenceDir, runId: 'cli', evaluationTime: v.evaluation_time }), null, 2) + '\n', fs.readFileSync(path.join(runDir, 'verdict.json'), 'utf8'));
    assert.equal(await runCli(['evaluate', '--evidence-dir', evidenceDir, '--run-id', 'cli', '--time', v.evaluation_time]), 3);
    cliEvents.length = 0;
    DockerComposeRunner.prototype.up = async function () { this.running = true; throw Object.assign(new Error('runtime unavailable'), { code: 'ENOENT' }); };
    assert.equal(await runCli(['run-local', '--evidence-dir', root, '--run-id', 'up-failure']), 3);
    const upFailure = JSON.parse(fs.readFileSync(path.join(root, 'runs', 'up-failure', 'verdict.json')));
    assert.ok(upFailure.causes.includes('HARNESS_ENVIRONMENT'));
    assert.deepEqual(cliEvents, ['diagnostics', 'down', 'cleanup']);
    fs.writeFileSync(path.join(fixture, '.release-harness', 'topology.json'), JSON.stringify({ ...topology, network_policy: { mode: 'open' } }));
    SourceMaterializer.prototype.materializeRepo = () => assert.fail('Conflicting policy must fail before materialization');
    assert.equal(await runCli(['run-local', '--evidence-dir', root, '--run-id', 'conflict']), 3);
  } finally {
    process.chdir(cwd);
    SourceMaterializer.prototype.materializeRepo = originals.materialize;
    SourceMaterializer.prototype.cleanup = originals.cleanup;
    DockerComposeRunner.prototype.up = originals.up;
    DockerComposeRunner.prototype.healthCheckServices = originals.health;
    DockerComposeRunner.prototype.collectDiagnostics = originals.diagnostics;
    DockerComposeRunner.prototype.execCompose = originals.exec;
    ScenarioRunner.prototype.runScenario = originals.scenario;
  }
  console.log('PASS: Docker-free run-local/evaluate parity, sealed effective policy, artifacts, redaction and cleanup ordering');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log('All startup/network/replay regression tests PASSED.');
