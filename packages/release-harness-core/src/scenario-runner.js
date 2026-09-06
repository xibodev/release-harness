import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import process from 'node:process';
import { verifySideEffect } from './probes.js';
import { validateNetworkPolicy } from './validator.js';
import { installNetworkGuard } from './network-guard.js';

const require = createRequire(import.meta.url);

function getPlaywright() {
  const candidateModules = [
    'playwright',
    '@playwright/test',
    path.join(os.homedir(), 'node_modules', 'playwright'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'playwright'),
  ];

  for (const modName of candidateModules) {
    try {
      const mod = require(modName);
      if (mod && mod.chromium) return mod;
    } catch {
      // search next candidate
    }
  }

  return null;
}

const SUPPORTED_ACTIONS = new Set([
  'navigate',
  'fill',
  'click',
  'select',
  'check',
  'upload',
  'wait-for',
  'assert',
  'screenshot',
]);

export function networkDecision(target, policy, localUrls = []) {
  const url = new URL(target);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error(`Unsupported network protocol ${url.protocol}`);
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  const port = Number(url.port || (['https:', 'wss:'].includes(url.protocol) ? 443 : 80));
  if (!policy || policy.mode === 'open') return { host, port, allowed: true, matched_rule: 'open network mode' };
  const local = localUrls.some((value) => {
    const endpoint = new URL(value);
    const scheme = (protocol) => protocol === 'ws:' ? 'http:' : protocol === 'wss:' ? 'https:' : protocol;
    return scheme(endpoint.protocol) === scheme(url.protocol)
      && endpoint.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '') === host
      && Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)) === port;
  });
  const rule = (policy.allowed_egress || []).find((r) => r.host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '') === host && r.port === port);
  return { host, port, allowed: local || Boolean(rule), matched_rule: local ? 'declared origin' : rule ? (rule.declared_in || rule.purpose || 'allowed_rule') : 'none' };
}

/**
 * Real Playwright Scenario Compiler and Execution Engine with Deep Observability.
 */
export class ScenarioRunner {
  constructor({ origins = [], topology = null, networkPolicy = null, evidenceDir, workspaceDir, customExtensions = {}, portOffset = 0 }) {
    if (networkPolicy) validateNetworkPolicy(networkPolicy);
    this.origins = origins;
    this.topology = topology;
    this.networkPolicy = networkPolicy;
    this.evidenceDir = evidenceDir;
    this.workspaceDir = workspaceDir || evidenceDir;
    this.extensions = customExtensions;
    this.portOffset = portOffset;
    this.playwright = getPlaywright();
  }

  /**
   * Shift a probe's port by the run's offset so concurrent runs verify their
   * own containers. Health checks already honoured `--port-offset` while probes
   * did not, so two simultaneous runs health-checked the shifted port and then
   * probed the unshifted one.
   *
   * A probe targeting a fixed external port sets `absolute_port: true` to opt
   * out. An absent port stays absent so each probe's own default applies.
   */
  applyPortOffset(params = {}) {
    if (!this.portOffset || params.absolute_port || typeof params.port !== 'number') {
      return params;
    }
    return { ...params, port: params.port + this.portOffset };
  }

  /**
   * Assemble the parameters one side-effect probe is invoked with.
   *
   * Ports shift with the run offset first. `evidenceDir` gives a probe
   * somewhere to seal its output, `cwd` defaults to the materialized workspace
   * so a probe that executes runs against the detached source rather than the
   * developer's working directory, and `probeId` gives that output a stable
   * name. A scenario that declares any of them explicitly keeps its own value.
   */
  buildProbeParams(scenario, sideEffect) {
    const baseParams = this.applyPortOffset(sideEffect.params || {});
    return {
      ...baseParams,
      evidenceDir: baseParams.evidenceDir || this.evidenceDir,
      cwd: baseParams.cwd || this.workspaceDir,
      probeId: baseParams.probeId || `${scenario.id}-${sideEffect.service}-${sideEffect.probe_type}`,
    };
  }

  resolveOriginUrl(originId) {
    const origin = this.origins.find((o) => o.origin_id === originId);
    if (!origin) {
      if (this.topology) {
        const nodes = this.topology.nodes || [];
        const matched = nodes.find((n) => n.id === originId || n.served_origin_id === originId);
        if (matched && matched.health_probe) {
          const p = matched.health_probe;
          const scheme = p.scheme || 'http';
          const host = p.host || '127.0.0.1';
          const port = p.port || 80;
          return `${scheme}://${host}:${port}`;
        }
      }
      throw new Error(`Fatal: Scenario references undeclared origin "${originId}". Must be declared in origins.json or topology.json.`);
    }

    const src = origin.url_source;
    if (!src) {
      throw new Error(`Fatal: Origin "${originId}" has no "url_source" defined.`);
    }

    if (src.startsWith('env:')) {
      const envVarMatch = src.match(/^env:([A-Z0-9_]+)/i);
      if (envVarMatch && process.env[envVarMatch[1]]) {
        return process.env[envVarMatch[1]];
      }
      const defaultMatch = src.match(/default\s+(https?:\/\/[^\s)]+)/i);
      if (defaultMatch) {
        return defaultMatch[1];
      }
      throw new Error(`Fatal: Origin "${originId}" url_source "${src}" could not be resolved from environment.`);
    }

    if (src.startsWith('http')) {
      return src;
    }

    throw new Error(`Fatal: Origin "${originId}" has unresolvable url_source "${src}".`);
  }

  /**
   * Executes a single declarative scenario using real Playwright browser automation and captures all observations.
   */
  async runScenario(scenario) {
    const start = Date.now();
    let baseUrl = null;

    try {
      baseUrl = this.resolveOriginUrl(scenario.origin_id);
    } catch (err) {
      return {
        id: scenario.id,
        scenario_id: scenario.id,
        origin_id: scenario.origin_id,
        failed: true,
        unproven: false,
        duration_ms: Date.now() - start,
        cause: 'HARNESS_CONFIGURATION',
        is_harness_error: true,
        disposition: 'CONDITION_UNMET',
        error_message: err.message,
      };
    }

    const rawResult = {
      id: scenario.id,
      scenario_id: scenario.id,
      origin_id: scenario.origin_id,
      target_base_url: baseUrl,
      failed: false,
      unproven: false,
      duration_ms: 0,
      evidence_files: [],
      error_message: undefined,
      cause: 'NONE',
      disposition: 'EXECUTED',
      steps_executed: [],
      negative_control_observations: null,
      side_effect_observations: [],
      network_observations: [],
      network_violations: [],
      negative_control_passed: true,
      side_effects_failed: false,
    };

    // Verify all actions are supported
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      if (step.action.startsWith('extension:')) {
        const extName = step.action.slice('extension:'.length);
        if (!this.extensions[extName]) {
          rawResult.failed = true;
          rawResult.cause = 'HARNESS_CONFIGURATION';
          rawResult.is_harness_error = true;
          rawResult.error_message = `Scenario step ${i + 1} requires unregistered extension "${extName}"`;
          rawResult.duration_ms = Date.now() - start;
          return rawResult;
        }
      } else if (!SUPPORTED_ACTIONS.has(step.action)) {
        rawResult.failed = true;
        rawResult.cause = 'HARNESS_CONFIGURATION';
        rawResult.is_harness_error = true;
        rawResult.error_message = `Scenario step ${i + 1} specifies unsupported action "${step.action}"`;
        rawResult.duration_ms = Date.now() - start;
        return rawResult;
      }
    }

    if (!this.playwright) {
      rawResult.failed = true;
      rawResult.cause = 'HARNESS_ENVIRONMENT';
      rawResult.is_harness_error = true;
      rawResult.error_message = 'Playwright browser automation engine is not installed or available.';
      rawResult.duration_ms = Date.now() - start;
      return rawResult;
    }

    let browser = null;
    let context = null;
    let page = null;
    let networkGuard = null;
    let setupComplete = false;
    let lastHttpStatus = 0;
    let lastResponseBody = '';

    try {

      const localUrls = [baseUrl];
      for (const origin of this.origins) {
        try { localUrls.push(this.resolveOriginUrl(origin.origin_id)); } catch { /* Unresolved origins are reported when executed. */ }
      }

      if (this.networkPolicy?.mode === 'sealed') {
        networkGuard = await installNetworkGuard(
          url => networkDecision(url, this.networkPolicy, localUrls),
          (url, { host, port, allowed, matched_rule }) => {
            rawResult.network_observations.push({ url, host, port, decision: allowed ? 'ALLOWED' : 'DENIED', matched_rule });
            if (!allowed) rawResult.network_violations.push({ host, port, url, attributed_to: 'product' });
          },
          err => {
            rawResult.failed = true;
            rawResult.is_harness_error = true;
            rawResult.cause = 'HARNESS_ENVIRONMENT';
            rawResult.error_message = `Chromium network guard failed: ${err.message}`;
            void context?.close().catch(() => {});
          });
      }

      browser = await this.playwright.chromium.launch({ headless: true, ...(networkGuard ? {
        proxy: networkGuard.proxy,
        args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      } : {}) });
      context = await browser.newContext({ baseURL: baseUrl, ignoreHTTPSErrors: true, serviceWorkers: 'block' });

      if (context.routeWebSocket) {
        await context.routeWebSocket('**/*', (socket) => {
          try {
            const { host, port, allowed, matched_rule } = networkDecision(socket.url(), this.networkPolicy, localUrls);
            rawResult.network_observations.push({ url: socket.url(), host, port, decision: allowed ? 'ALLOWED' : 'DENIED', matched_rule });
            if (allowed) return socket.connectToServer();
            rawResult.network_violations.push({ host, port, url: socket.url(), attributed_to: 'product' });
            return socket.close();
          } catch (err) {
            rawResult.failed = true;
            rawResult.is_harness_error = true;
            rawResult.cause = 'HARNESS_CONFIGURATION';
            rawResult.error_message = `WebSocket could not be classified: ${err.message}`;
            return socket.close();
          }
        });
      }

      // Track all network observations (both allowed rules and violations)
      if (!networkGuard) await context.route('**/*', async (route) => {
        try {
          const { host, port, allowed, matched_rule } = networkDecision(route.request().url(), this.networkPolicy, localUrls);

          rawResult.network_observations.push({
            url: route.request().url(),
            host,
            port,
            decision: allowed ? 'ALLOWED' : 'DENIED',
            matched_rule,
          });

          if (!allowed) {
            rawResult.network_violations.push({
              host,
              port,
              attributed_to: 'product',
              url: route.request().url(),
            });
            return route.abort('blockedbyclient');
          }

        } catch (err) {
          rawResult.is_harness_error = true;
          rawResult.cause = 'HARNESS_CONFIGURATION';
          rawResult.failed = true;
          rawResult.error_message = `Network request could not be classified: ${err.message}`;
          return route.abort('blockedbyclient');
        }
        return route.continue();
      });

      page = await context.newPage();
      setupComplete = true;

      page.on('response', async (res) => {
        lastHttpStatus = res.status();
        try {
          lastResponseBody = await res.text();
        } catch {
          // text read error
        }
      });

      // Execute each step in real browser
      for (let i = 0; i < scenario.steps.length; i++) {
        const step = scenario.steps[i];
        const stepTimeout = step.timeout || 15000;
        const stepStart = Date.now();

        if (step.action.startsWith('extension:')) {
          const extName = step.action.slice('extension:'.length);
          await this.extensions[extName](page, step.params || {});
          rawResult.steps_executed.push({ index: i + 1, action: step.action, duration_ms: Date.now() - stepStart, status: 'OK' });
          continue;
        }

        switch (step.action) {
          case 'navigate': {
            const targetUrl = step.target.startsWith('http') ? step.target : `${baseUrl}${step.target}`;
            const waitMode = scenario.negative_control ? 'commit' : 'domcontentloaded';
            const res = await page.goto(targetUrl, { waitUntil: waitMode, timeout: stepTimeout });
            if (res) {
              lastHttpStatus = res.status();
              rawResult.steps_executed.push({ index: i + 1, action: 'navigate', target: targetUrl, http_status: res.status(), duration_ms: Date.now() - stepStart });
              if (!scenario.negative_control && !res.ok()) {
                throw new Error(`Navigation to ${targetUrl} failed with HTTP ${res.status()}`);
              }
            }
            break;
          }

          case 'fill': {
            await page.locator(step.target).fill(String(step.value ?? ''), { timeout: stepTimeout });
            rawResult.steps_executed.push({ index: i + 1, action: 'fill', target: step.target, duration_ms: Date.now() - stepStart });
            break;
          }

          case 'click': {
            await page.locator(step.target).click({ timeout: stepTimeout });
            rawResult.steps_executed.push({ index: i + 1, action: 'click', target: step.target, duration_ms: Date.now() - stepStart });
            break;
          }

          case 'select': {
            await page.locator(step.target).selectOption(String(step.value ?? ''), { timeout: stepTimeout });
            rawResult.steps_executed.push({ index: i + 1, action: 'select', target: step.target, duration_ms: Date.now() - stepStart });
            break;
          }

          case 'check': {
            await page.locator(step.target).check({ timeout: stepTimeout });
            rawResult.steps_executed.push({ index: i + 1, action: 'check', target: step.target, duration_ms: Date.now() - stepStart });
            break;
          }

          case 'upload': {
            await page.locator(step.target).setInputFiles(String(step.value ?? ''), { timeout: stepTimeout });
            rawResult.steps_executed.push({ index: i + 1, action: 'upload', target: step.target, duration_ms: Date.now() - stepStart });
            break;
          }

          case 'wait-for': {
            await page.locator(step.target).waitFor({ state: 'visible', timeout: stepTimeout });
            rawResult.steps_executed.push({ index: i + 1, action: 'wait-for', target: step.target, duration_ms: Date.now() - stepStart });
            break;
          }

          case 'assert': {
            if (step.target.startsWith('text:')) {
              const text = step.target.slice('text:'.length);
              await page.getByText(text, { exact: false }).waitFor({ state: 'visible', timeout: stepTimeout });
            } else if (step.target.startsWith('url:')) {
              const urlPattern = step.target.slice('url:'.length);
              if (!page.url().includes(urlPattern)) {
                throw new Error(`Assertion failed: expected URL containing "${urlPattern}", current URL is "${page.url()}"`);
              }
            } else {
              await page.locator(step.target).waitFor({ state: 'visible', timeout: stepTimeout });
            }
            rawResult.steps_executed.push({ index: i + 1, action: 'assert', target: step.target, duration_ms: Date.now() - stepStart });
            break;
          }

          case 'screenshot': {
            const shotPath = path.join(this.evidenceDir, 'screenshots', `${scenario.id}-step-${i + 1}.png`);
            fs.mkdirSync(path.dirname(shotPath), { recursive: true });
            await page.screenshot({ path: shotPath, fullPage: true });
            rawResult.evidence_files.push(path.relative(this.evidenceDir, shotPath).replace(/\\/g, '/'));
            rawResult.steps_executed.push({ index: i + 1, action: 'screenshot', path: shotPath, duration_ms: Date.now() - stepStart });
            break;
          }
        }
      }

      // Deep Negative Control Observation Capture
      if (scenario.negative_control) {
        const expectedStatus = scenario.negative_control.expected_http_status || 400;
        const expectedReason = scenario.negative_control.expected_rejection_reason || 'rejection';
        const actualStatus = lastHttpStatus;

        const pageContent = await page.content().catch(() => '');
        const reasonFound = pageContent.includes(expectedReason) || lastResponseBody.includes(expectedReason);
        const actualReason = reasonFound ? expectedReason : (lastResponseBody.slice(0, 200) || 'no_rejection_reason_observed');

        const statusMatched = (actualStatus === expectedStatus);
        const reasonMatched = Boolean(reasonFound);

        rawResult.negative_control_observations = {
          expected_http_status: expectedStatus,
          actual_http_status: actualStatus,
          expected_rejection_reason: expectedReason,
          actual_rejection_reason: actualReason,
          status_matched: statusMatched,
          reason_matched: reasonMatched,
        };

        if (actualStatus >= 200 && actualStatus < 300) {
          rawResult.negative_control_passed = false;
          throw new Error(`Negative control failed: expected rejection HTTP ${expectedStatus}, but received HTTP ${actualStatus} (unexpected success)`);
        }

        if (actualStatus === 500) {
          rawResult.negative_control_passed = false;
          throw new Error(`Negative control failed with 500 Internal Server Error instead of expected rejection ${expectedStatus}`);
        }

        if (!statusMatched) {
          rawResult.negative_control_passed = false;
          throw new Error(`Negative control failed: expected rejection HTTP ${expectedStatus}, got HTTP ${actualStatus}`);
        }

        if (!reasonMatched) {
          rawResult.negative_control_passed = false;
          throw new Error(`Negative control failed: expected rejection reason "${expectedReason}" was not found in response or UI state`);
        }
      }

      // Deep Side Effect Observation Capture
      if (Array.isArray(scenario.expected_side_effects)) {
        for (const sideEffect of scenario.expected_side_effects) {
          const sideRes = await verifySideEffect({
            ...sideEffect,
            params: this.buildProbeParams(scenario, sideEffect),
          });

          rawResult.side_effect_observations.push({
            service: sideEffect.service,
            probe_type: sideEffect.probe_type,
            expected_condition: `${sideEffect.probe_type} on ${sideEffect.service}`,
            observed_result: sideRes.message,
            passed: sideRes.ok,
            cause: sideRes.cause || null,
            is_harness_error: Boolean(sideRes.isHarnessError),
          });

          if (!sideRes.ok) {
            rawResult.side_effects_failed = true;
            rawResult.side_effect_error = sideRes.message;
            // Carry the probe's own attribution out through the throw; the
            // catch below would otherwise call every failure a product bug.
            const probeErr = new Error(`Side effect verification failed: ${sideRes.message}`);
            probeErr.harnessCause = sideRes.cause || null;
            probeErr.isHarnessError = Boolean(sideRes.isHarnessError);
            throw probeErr;
          }
        }
      }
    } catch (err) {
      rawResult.failed = true;
      rawResult.error_message = err.message;
      // A probe that reported its own cause keeps it. Anything else — a
      // Playwright timeout, a failed assertion, a thrown navigation error —
      // is a product failure by default.
      rawResult.cause = err.harnessCause || (rawResult.is_harness_error ? rawResult.cause : !setupComplete ? 'HARNESS_ENVIRONMENT' : 'PRODUCT_BUG');
      rawResult.is_harness_error = Boolean(err.isHarnessError || rawResult.is_harness_error || !setupComplete);
    } finally {
      networkGuard?.beginClose();
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      await networkGuard?.close();
      rawResult.duration_ms = Date.now() - start;
    }

    return rawResult;
  }
}
