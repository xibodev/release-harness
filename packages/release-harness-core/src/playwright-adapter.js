import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * First-class Existing-Playwright Test Suite Adapter.
 * Ingests and normalizes results from product-owned Playwright suites without rewriting test code.
 */
export class PlaywrightSuiteAdapter {
  constructor({ workingDir, configPath = null, expectedTestIds = [], timeoutMs = 120000 }) {
    this.workingDir = path.resolve(workingDir);
    this.configPath = configPath ? path.resolve(configPath) : null;
    this.expectedTestIds = new Set(expectedTestIds);
    this.timeoutMs = timeoutMs;
  }

  /**
   * Executes product-owned Playwright suite with JSON reporter and normalizes evidence.
   */
  async executeSuite({ testMatch = null, grep = null, project = null, env = process.env } = {}) {
    const start = Date.now();
    const args = ['playwright', 'test', '--reporter=json'];

    if (this.configPath) {
      args.push('--config', this.configPath);
    }
    if (testMatch) {
      args.push(testMatch);
    }
    if (grep) {
      args.push('-g', grep);
    }
    if (project) {
      args.push('--project', project);
    }

    const isWin = process.platform === 'win32';
    const npxCmd = isWin ? 'npx.cmd' : 'npx';

    return new Promise((resolve) => {
      const child = spawn(npxCmd, args, {
        cwd: this.workingDir,
        env: { ...env, CI: '1' },
        shell: true,
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (d) => (stdout += d));
      child.stderr?.on('data', (d) => (stderr += d));

      const timer = setTimeout(() => {
        child.kill();
        resolve(this.normalizeFailure('Playwright suite execution timed out', Date.now() - start, stdout, stderr));
      }, this.timeoutMs);

      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve(this.parseAndNormalize(stdout, stderr, exitCode, Date.now() - start));
      });
    });
  }

  parseAndNormalize(stdout, stderr, exitCode, totalDurationMs) {
    let report = null;

    // Extract JSON payload from stdout (handling any pre/post console logs)
    const jsonStart = stdout.indexOf('{');
    const jsonEnd = stdout.lastIndexOf('}');

    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      try {
        const jsonStr = stdout.slice(jsonStart, jsonEnd + 1);
        report = JSON.parse(jsonStr);
      } catch {
        // failed to parse JSON
      }
    }

    if (!report) {
      return {
        ok: false,
        scenarios: [],
        discovered_count: 0,
        causes: ['HARNESS_CONFIGURATION'],
        error: 'Failed to parse machine-readable JSON report from Playwright test output',
        raw_output: stdout || stderr,
        duration_ms: totalDurationMs,
      };
    }

    const scenarios = [];
    const discoveredTestIds = new Set();
    const causes = new Set();
    let totalPassed = 0;
    let totalFailed = 0;
    let totalSkipped = 0;

    const extractSpecs = (suite, fileContext = '') => {
      const file = suite.file || fileContext;
      for (const spec of suite.specs || []) {
        const title = spec.title;
        const id = spec.id || `${path.basename(file, path.extname(file))}-${title.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        discoveredTestIds.add(id);

        for (const test of spec.tests || []) {
          for (const res of test.results || []) {
            const status = res.status; // 'passed', 'failed', 'timedOut', 'skipped', 'interrupted'
            const isFailed = status === 'failed' || status === 'timedOut' || status === 'interrupted';
            const isSkipped = status === 'skipped';
            const isPassed = status === 'passed';

            if (isPassed) totalPassed++;
            if (isFailed) {
              totalFailed++;
              causes.add('PRODUCT_BUG');
            }
            if (isSkipped) totalSkipped++;

            const attachments = (res.attachments || []).map((a) => a.path).filter(Boolean);
            const errMessage = res.error?.message || (isFailed ? `Test failed with status ${status}` : undefined);

            scenarios.push({
              id,
              scenario_id: id,
              name: title,
              origin_id: 'playwright-suite',
              failed: isFailed,
              unproven: false,
              duration_ms: res.duration || 0,
              evidence_files: attachments,
              error_message: errMessage,
              cause: isFailed ? 'PRODUCT_BUG' : 'NONE',
              disposition: isSkipped ? 'SKIPPED' : 'EXECUTED',
              steps_executed: [{ action: 'playwright_spec', target: file, duration_ms: res.duration || 0 }],
            });
          }
        }
      }

      for (const childSuite of suite.suites || []) {
        extractSpecs(childSuite, file);
      }
    };

    for (const rootSuite of report.suites || []) {
      extractSpecs(rootSuite);
    }

    // Check coverage floor: no tests found
    if (scenarios.length === 0) {
      return {
        ok: false,
        scenarios: [],
        discovered_count: 0,
        causes: ['HARNESS_CONFIGURATION'],
        error: 'Playwright reported 0 tests found. Quality gate cannot pass without executable tests.',
        duration_ms: totalDurationMs,
      };
    }

    // Check expected inventory
    const missingExpected = [];
    for (const expId of this.expectedTestIds) {
      if (!discoveredTestIds.has(expId)) {
        missingExpected.push(expId);
        causes.add('HARNESS_FIXTURE_MISSING');
      }
    }

    const allPassed = totalFailed === 0 && missingExpected.length === 0 && exitCode === 0;

    return {
      ok: allPassed,
      scenarios,
      discovered_count: scenarios.length,
      passed_count: totalPassed,
      failed_count: totalFailed,
      skipped_count: totalSkipped,
      missing_expected_ids: missingExpected,
      causes: Array.from(causes),
      duration_ms: totalDurationMs,
      exit_code: exitCode,
    };
  }

  normalizeFailure(msg, durationMs, stdout, stderr) {
    return {
      ok: false,
      scenarios: [],
      discovered_count: 0,
      causes: ['HARNESS_ENVIRONMENT'],
      error: msg,
      raw_output: `${stdout}\n${stderr}`,
      duration_ms: durationMs,
    };
  }
}
