import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { ScenarioRunner, networkDecision } from '../src/scenario-runner.js';
import { DockerComposeRunner } from '../src/runner.js';
import { EvidenceSealer } from '../src/sealer.js';
import { evaluateRun } from '../src/evaluator.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-security-'));
const policy = { mode: 'sealed', allowed_egress: [] };
const scenario = { id: 'S1', name: 'Redirect', origin_id: 'web', tier: 'smoke', policy: 'required', steps: [{ action: 'navigate', target: '/redirect' }] };
const runtime = { schema_version: '1.0.0', started_at: '2026-01-01T00:00:00.000Z', execution_mode: 'CERTIFICATION', startup: { phase: 'ready', blocked: false, health: [] } };
const brand = { origins: { web: { canary: { id: 'canary', expected_verdict: 'PASS' } } } };
let count = 0;
function bundle({ canaries, withRuntime = true, raw = [{ id: 'S1', failed: false, steps_executed: [{}] }], brandContract = brand } = {}) {
  const evidenceDir = path.join(root, `bundle-${count++}`);
  const sealer = new EvidenceSealer(evidenceDir, 'test');
  sealer.writeEvidence('raw-results.json', JSON.stringify(raw));
  if (withRuntime) sealer.writeEvidence('runtime-observations.json', JSON.stringify(runtime));
  if (canaries) sealer.writeEvidence('canary-results.json', JSON.stringify(canaries));
  const seal = sealer.sealEvidence({ scenarios: [scenario], origins: [], brand_contract: brandContract, ...(withRuntime ? { runtime_observations_version: '1.0.0' } : {}) });
  return { evidenceDir, runId: 'test', evaluationTime: seal.manifest.sealed_at };
}
try {
  assert.equal(networkDecision('http://example.test:443', policy, ['https://example.test']).allowed, false);
  assert.equal(networkDecision('ws://example.test:443', policy, ['https://example.test']).allowed, false);
  assert.equal(networkDecision('wss://example.test', policy, ['https://example.test']).allowed, true);
  assert.equal(networkDecision('ws://example.test', policy, ['http://example.test']).allowed, true);

  const secrets = 'AWS_SECRET_ACCESS_KEY=EXAMPLE_SYNTHETIC_VALUE\n{"password":"space containing synthetic secret"}\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC_TRUNCATED_KEY\n';
  const docker = new DockerComposeRunner({ composeFile: path.join(root, 'compose.yml'), workingDir: root, runId: 'test' });
  docker.execCompose = (args) => { assert.equal(args[0], 'ps'); return 'a'.repeat(64); };
  docker.execDocker = () => JSON.stringify({ id: 'a'.repeat(64), project: 'rh-test', service: 'web', state: { Running: false, ExitCode: 1, Error: secrets }, ports: {} });
  const diagnostic = docker.collectDiagnostics();
  assert.equal(diagnostic.logs_omitted, true);
  assert.equal(diagnostic.containers[0].error, 'CONTAINER_RUNTIME_ERROR');
  for (const token of ['EXAMPLE_SYNTHETIC_VALUE', 'containing synthetic secret', 'SYNTHETIC_TRUNCATED_KEY']) assert.ok(!JSON.stringify(diagnostic).includes(token));

  for (const withRuntime of [true, false]) {
    const options = bundle({ withRuntime });
    const first = evaluateRun(options);
    assert.equal(first.exit_code, 2);
    assert.deepEqual(evaluateRun({ ...options, canaryResults: [{ origin_id: 'web', verdict: 'PASS' }], startedAt: '2999-01-01T00:00:00Z', brandContract: {}, waivers: [], rawResults: [], scenarios: [{ ...scenario, policy: 'conditional' }] }), first);
  }
  assert.equal(evaluateRun(bundle({ canaries: [{ origin_id: 'web', verdict: 'PASS' }] })).exit_code, 0);
  assert.equal(evaluateRun(bundle({ withRuntime: false, raw: [{ id: 'S1', failed: false, steps_executed: [{}], canary_results: [{ origin_id: 'web', verdict: 'PASS' }] }] })).exit_code, 0);

  for (const name of ['runtime-observations.json', 'policy-snapshot.json', 'raw-results.json', 'canary-results.json']) {
    const options = bundle({ canaries: [{ origin_id: 'web', verdict: 'PASS' }] });
    const file = path.join(options.evidenceDir, name);
    const outside = path.join(root, `outside-${count}.json`);
    fs.copyFileSync(file, outside);
    fs.rmSync(file);
    try { fs.symlinkSync(outside, file, 'file'); }
    catch (err) {
      if (!['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) throw err;
      console.log(`SKIP symlink ${name}: ${err.code}`);
      continue;
    }
    assert.equal(new EvidenceSealer(options.evidenceDir, 'test').verifyIntegrity().ok, false);
    assert.equal(evaluateRun(options).exit_code, 4);
  }
  const uncovered = bundle();
  const manifestPath = path.join(uncovered.evidenceDir, 'evidence.manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.files = manifest.files.filter(f => f.path !== 'runtime-observations.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal(evaluateRun(uncovered).exit_code, 4);
  // Windows can usually create junctions without the privilege needed for file symlinks.
  const junction = path.join(root, 'linked-evidence');
  try {
    fs.symlinkSync(uncovered.evidenceDir, junction, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(evaluateRun({ ...uncovered, evidenceDir: junction }).exit_code, 4);
    fs.unlinkSync(junction);
  } catch (err) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) throw err;
    console.log(`SKIP directory link: ${err.code}`);
  }
  console.log('PASS: sealed authority, manifest coverage, symlink rejection, safe diagnostics and origin schemes');

  let destinationHits = 0;
  const received = [];
  const destination = http.createServer((req, res) => { destinationHits++; res.end('must not connect'); });
  await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve));
  const source = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${destination.address().port}/` }); return res.end(); }
    if (req.url === '/iframe') { res.setHeader('Content-Type', 'text/html'); return res.end('<iframe src="/child"></iframe>'); }
    if (req.url === '/iframe-denied') { res.setHeader('Content-Type', 'text/html'); return res.end('<iframe src="/redirect"></iframe>'); }
    if (req.url === '/background') { res.setHeader('Content-Type', 'text/html'); return res.end('<script>for(let i=0;i<50;i++)fetch("/slow?i="+i).catch(()=>{});</script>'); }
    if (req.url.startsWith('/slow')) { setTimeout(() => res.end('background'), 100); return; }
    if (req.url.startsWith('/post')) { res.writeHead(Number(req.url.slice(5)), { Location: '/received', 'Set-Cookie': 'redirect_cookie=present; Path=/' }); return res.end(); }
    if (req.url === '/received') {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => { received.push({ method: req.method, body, cookie: req.headers.cookie }); res.end('received'); }); return;
    }
    res.setHeader('Content-Type', 'text/html'); res.end('<html><body>test</body></html>');
  });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  try {
    const runner = new ScenarioRunner({ origins: [{ origin_id: 'web', url_source: `http://127.0.0.1:${source.address().port}` }], networkPolicy: policy, evidenceDir: root });
    if (process.env.RELEASE_HARNESS_TEST_PLAYWRIGHT_PACKAGE) {
      const require = createRequire(process.env.RELEASE_HARNESS_TEST_PLAYWRIGHT_PACKAGE);
      runner.playwright = require('playwright');
      console.log(`Testing external Playwright ${require('playwright/package.json').version}`);
    }
    assert.ok(runner.playwright, 'Real Playwright is required for redirect regression');
    const denied = await runner.runScenario(scenario);
    assert.equal(destinationHits, 0, '302 destination must be blocked before any connection');
    assert.ok(denied.network_violations.some(v => v.port === destination.address().port));
    const options = bundle({ raw: [denied], brandContract: null });
    assert.equal(evaluateRun(options).exit_code, 1);
    for (const code of [302, 303, 307, 308]) {
      runner.extensions.submit = async page => {
        await page.evaluate(async status => { await fetch(`/post${status}`, { method: 'POST', body: 'payload=hello', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); }, code);
      };
      const raw = await runner.runScenario({ ...scenario, steps: [{ action: 'navigate', target: '/' }, { action: 'extension:submit' }] });
      assert.equal(raw.failed, false, raw.error_message);
      assert.equal(raw.network_violations.length, 0);
      const observation = received.pop();
      assert.equal(observation.method, code >= 307 ? 'POST' : 'GET');
      assert.equal(observation.body, code >= 307 ? 'payload=hello' : '');
      assert.match(observation.cookie, /redirect_cookie=present/);
    }
    runner.extensions.popup = async page => {
      const opened = page.waitForEvent('popup');
      await page.evaluate(() => window.open('/redirect'));
      const popup = await opened;
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
    };
    const popup = await runner.runScenario({ ...scenario, steps: [{ action: 'navigate', target: '/' }, { action: 'extension:popup' }] });
    assert.equal(destinationHits, 0, 'Popup redirects must also be blocked');
    assert.ok(popup.network_violations.length > 0, popup.error_message);
    assert.ok(!popup.is_harness_error, popup.error_message);
    assert.equal(evaluateRun(bundle({ raw: [popup], brandContract: null })).exit_code, 1);
    runner.extensions.popup = async page => {
      const opened = page.waitForEvent('popup');
      await page.evaluate(() => window.open('/child'));
      const child = await opened;
      await child.waitForLoadState('domcontentloaded');
      assert.match(await child.content(), /test/);
    };
    const allowedPopup = await runner.runScenario({ ...scenario, steps: [{ action: 'navigate', target: '/' }, { action: 'extension:popup' }] });
    assert.equal(allowedPopup.failed, false, allowedPopup.error_message);
    assert.equal(allowedPopup.network_violations.length, 0);
    runner.extensions.frame = async page => { await page.frameLocator('iframe').locator('body').waitFor(); };
    const allowedFrame = await runner.runScenario({ ...scenario, steps: [{ action: 'navigate', target: '/iframe' }, { action: 'extension:frame' }] });
    assert.equal(allowedFrame.failed, false, allowedFrame.error_message);
    assert.equal(allowedFrame.network_violations.length, 0);
    runner.extensions.loaded = async page => { await page.waitForLoadState('load'); };
    const deniedFrame = await runner.runScenario({ ...scenario, steps: [{ action: 'navigate', target: '/iframe-denied' }, { action: 'extension:loaded' }] });
    assert.ok(deniedFrame.network_violations.length > 0, deniedFrame.error_message);
    assert.ok(!deniedFrame.is_harness_error, deniedFrame.error_message);
    assert.equal(destinationHits, 0);
    for (let attempt = 0; attempt < 10; attempt++) {
      const background = await runner.runScenario({ ...scenario, steps: [{ action: 'navigate', target: '/background' }] });
      assert.equal(background.failed, false, `background run ${attempt}: ${background.error_message}`);
      assert.ok(!background.is_harness_error);
    }
    console.log('PASS: real Chromium redirect blocking, allowed popup/iframe, denied child redirects, HTTP semantics, 10x50 background cleanup');
  } finally {
    await new Promise(resolve => source.close(resolve));
    await new Promise(resolve => destination.close(resolve));
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
