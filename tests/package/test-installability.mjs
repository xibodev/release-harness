import assert from 'node:assert';
import crypto from 'node:crypto';
import http from 'node:http';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

console.log('======================================================================');
console.log('  Release-Harness Packaging & Consumer Installation Acceptance Test   ');
console.log('======================================================================\n');

const repoRoot = path.resolve('.');
const packagesDir = path.join(repoRoot, 'packages');
const schemasPkgDir = path.join(packagesDir, 'release-harness-schemas');
const corePkgDir = path.join(packagesDir, 'release-harness-core');
const facadePkgDir = path.join(packagesDir, 'release-harness');

const packOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-pack-output-'));
const consumerRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-consumer-repo-'));

console.log(`Pack output dir     : ${packOutputDir}`);
console.log(`Consumer test repo  : ${consumerRepoDir}\n`);

// 1. Pack all 3 packages into tarballs
console.log('1. Packing npm tarballs with npm pack...');

const packSchemasOut = execSync('npm pack --pack-destination ' + JSON.stringify(packOutputDir), { cwd: schemasPkgDir, encoding: 'utf8' }).trim();
const schemasTarball = path.join(packOutputDir, packSchemasOut.split('\n').pop().trim());

const packCoreOut = execSync('npm pack --pack-destination ' + JSON.stringify(packOutputDir), { cwd: corePkgDir, encoding: 'utf8' }).trim();
const coreTarball = path.join(packOutputDir, packCoreOut.split('\n').pop().trim());

const packFacadeOut = execSync('npm pack --pack-destination ' + JSON.stringify(packOutputDir), { cwd: facadePkgDir, encoding: 'utf8' }).trim();
const facadeTarball = path.join(packOutputDir, packFacadeOut.split('\n').pop().trim());

console.log(`  ✓ Packed: ${path.basename(schemasTarball)}`);
console.log(`  ✓ Packed: ${path.basename(coreTarball)}`);
console.log(`  ✓ Packed: ${path.basename(facadeTarball)}`);

// 2. Initialize independent consumer repository
console.log('\n2. Initializing independent consumer repository...');
execSync('npm init -y', { cwd: consumerRepoDir, stdio: ['ignore', 'ignore', 'ignore'] });
execSync('git init -b main && git config user.name "Consumer" && git config user.email "consumer@example.com"', { cwd: consumerRepoDir, stdio: ['ignore', 'ignore', 'ignore'] });

// 3. Install packed tarballs
console.log('3. Installing packed tarballs into consumer repository...');
execSync(`npm install --save-dev "${schemasTarball}" "${coreTarball}" "${facadeTarball}"`, {
  cwd: consumerRepoDir,
  stdio: ['ignore', 'inherit', 'inherit'],
});
console.log('  ✓ Installed @xibodev/release-harness from packed tarball');

// 4. Test installed CLI commands from consumer repo
console.log('\n4. Verifying installed binary from consumer repository...');
const isWin = process.platform === 'win32';
const npxCmd = isWin ? 'npx.cmd' : 'npx';

// 4a. Version test
const versionOut = execSync(`${npxCmd} release-harness --version`, { cwd: consumerRepoDir, encoding: 'utf8' }).trim();
console.log(`  • Version: ${versionOut}`);
assert.ok(versionOut.includes('1.0.0'), 'Version must report 1.0.0');

// 4b. Help test
const helpOut = execSync(`${npxCmd} release-harness --help`, { cwd: consumerRepoDir, encoding: 'utf8' });
assert.ok(helpOut.includes('doctor'), 'Help must list doctor command');
assert.ok(helpOut.includes('check-pr'), 'Help must list check-pr command');
assert.ok(helpOut.includes('run-local'), 'Help must list run-local command');
assert.ok(helpOut.includes('clean'), 'Help must list clean command');
console.log('  ✓ release-harness --help verified');

// 4c. Doctor test
const doctorOut = execSync(`${npxCmd} release-harness doctor`, { cwd: consumerRepoDir, encoding: 'utf8' });
console.log('  ✓ release-harness doctor executed');

// 4d. Init scaffolding test
console.log('\n5. Testing release-harness init scaffolding...');
const initOut = execSync(`${npxCmd} release-harness init`, { cwd: consumerRepoDir, encoding: 'utf8' });
assert.ok(fs.existsSync(path.join(consumerRepoDir, '.release-harness', 'topology.json')), 'topology.json must be created');
assert.ok(fs.existsSync(path.join(consumerRepoDir, '.release-harness', 'origins.json')), 'origins.json must be created');
assert.ok(fs.existsSync(path.join(consumerRepoDir, '.release-harness', 'scenarios', 'smoke.json')), 'smoke.json must be created');
console.log('  ✓ .release-harness/ scaffolded successfully');

// Point origin to designated test port 38500
const originsPath = path.join(consumerRepoDir, '.release-harness', 'origins.json');
const origins = JSON.parse(fs.readFileSync(originsPath, 'utf8'));
origins[0].url_source = 'http://127.0.0.1:38500';
fs.writeFileSync(originsPath, JSON.stringify(origins, null, 2), 'utf8');

// Also update topology health probe port to 38500
const topologyPath = path.join(consumerRepoDir, '.release-harness', 'topology.json');
const topology = JSON.parse(fs.readFileSync(topologyPath, 'utf8'));
topology.nodes[0].health_probe.port = 38500;
fs.writeFileSync(topologyPath, JSON.stringify(topology, null, 2), 'utf8');

// Commit consumer repo to make it clean git state
execSync('git add . && git commit -m "consumer: initial commit"', { cwd: consumerRepoDir, stdio: ['ignore', 'ignore', 'ignore'] });
const consumerSha = execSync('git rev-parse HEAD', { cwd: consumerRepoDir, encoding: 'utf8' }).trim();
console.log(`  ✓ Consumer Git SHA: ${consumerSha.slice(0, 12)} (clean)`);

// 4e. check-pr test
console.log('\n6. Testing release-harness check-pr on consumer repository...');
const checkPrOut = execSync(`${npxCmd} release-harness check-pr`, { cwd: consumerRepoDir, encoding: 'utf8' });
assert.ok(checkPrOut.includes('Level 1 Gate: PASS'), 'check-pr must pass on clean consumer repo');
console.log('  ✓ check-pr passed on clean consumer repository');

// 4f. run-local Playwright test with non-blocking child process
console.log('\n7. Testing release-harness run-local with real Playwright execution...');

// Start mock server answering consumer landing page
const srv = http.createServer((req, res) => {
  const body = '<html><body><h1>Welcome</h1><p>Consumer Web App Ready</p></body></html>';
  res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
});
await new Promise((r) => srv.listen(38500, '127.0.0.1', r));

const consumerEvidenceDir = path.join(os.tmpdir(), 'rh-consumer-evidence');

function spawnAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

try {
  const envWithoutSourceWorkspace = { ...process.env };
  delete envWithoutSourceWorkspace.NODE_PATH;

  const runLocalProc = await spawnAsync(npxCmd, ['release-harness', 'run-local', '--evidence-dir', consumerEvidenceDir], {
    cwd: consumerRepoDir,
    env: envWithoutSourceWorkspace,
    shell: true,
  });

  console.log(runLocalProc.stdout);
  if (runLocalProc.status !== 0) {
    console.error('stderr:', runLocalProc.stderr);
  }

  assert.strictEqual(runLocalProc.status, 0, 'run-local must exit 0 on clean consumer fixture');

  // Verify sealed artifacts in consumerEvidenceDir
  const productRunsDir = path.join(consumerEvidenceDir, 'runs');
  assert.ok(fs.existsSync(productRunsDir), 'Runs directory must exist in evidence directory');
  const runDirs = fs.readdirSync(productRunsDir);
  assert.ok(runDirs.length > 0, 'Run directory must exist');
  const runId = runDirs[0];
  const latestRunDir = path.join(productRunsDir, runId);

  const verdict = JSON.parse(fs.readFileSync(path.join(latestRunDir, 'verdict.json'), 'utf8'));
  const runManifest = JSON.parse(fs.readFileSync(path.join(latestRunDir, 'run.manifest.json'), 'utf8'));
  const evidenceManifest = JSON.parse(fs.readFileSync(path.join(latestRunDir, 'evidence', 'evidence.manifest.json'), 'utf8'));

  assert.strictEqual(verdict.certification_status, 'PASS', 'Certification status must be PASS');
  assert.strictEqual(verdict.run_integrity, 'COMPLETE', 'Run integrity must be COMPLETE');
  assert.strictEqual(verdict.exit_code, 0, 'Exit code must be 0');
  assert.strictEqual(runManifest.harness_core_version, '1.0.0', 'Recorded harness core version must be 1.0.0');
  assert.strictEqual(runManifest.sources[0].commit_sha, consumerSha, 'Recorded commit SHA must match consumer repository SHA');
  assert.strictEqual(runManifest.sources[0].is_clean, true, 'Consumer repo must be recorded clean');

  console.log('  ✓ run-local produced certified PASS verdict');
  console.log('  ✓ run.manifest.json recorded exact consumer provenance');

  // 8. Test clean command from consumer repo
  console.log('\n8. Testing release-harness clean on consumer repository...');
  const cleanOut = execSync(`${npxCmd} release-harness clean --evidence-dir "${consumerEvidenceDir}" --run-id "${runId}"`, { cwd: consumerRepoDir, encoding: 'utf8' });
  console.log('  ✓ release-harness clean executed successfully');
} finally {
  srv.close();
  // Cleanup test workspaces
  try { fs.rmSync(packOutputDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  try { fs.rmSync(consumerRepoDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  try { fs.rmSync(consumerEvidenceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
}

console.log('\n======================================================================');
console.log('  ALL PACKAGING & CONSUMER INSTALLATION CHECKS PASSED VERIFIED GREEN ✓ ');
console.log('======================================================================\n');
