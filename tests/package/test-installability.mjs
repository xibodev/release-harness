import assert from 'node:assert';
import crypto from 'node:crypto';
import http from 'node:http';
import { execSync, spawn, spawnSync } from 'node:child_process';
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
const corePkgVersion = JSON.parse(fs.readFileSync(path.join(corePkgDir, 'package.json'), 'utf8')).version;
const versionOut = execSync(`${npxCmd} release-harness --version`, { cwd: consumerRepoDir, encoding: 'utf8' }).trim();
console.log(`  • Version: ${versionOut}`);
// Asserted against the published package version, not a literal: the defect this
// catches is a bumped package.json with a stale HARNESS_VERSION, which would seal
// the wrong engine version into every run manifest.
assert.ok(versionOut.includes(corePkgVersion), `Version must report the published core version ${corePkgVersion} (got "${versionOut}")`);

// 4b. Help test
const helpOut = execSync(`${npxCmd} release-harness --help`, { cwd: consumerRepoDir, encoding: 'utf8' });
// The lifecycle, as a consumer of the published package sees it. These are the
// commands that exist; `check-pr`, `run-local`, `evaluate` and `clean` were
// deleted with the architecture they drove, and this test went on requiring
// them -- which is how a suite nobody runs keeps reporting on a product that no
// longer exists.
for (const command of ['init', 'draft', 'validate', 'accept', 'bind', 'run', 'verify', 'doctor']) {
  assert.ok(helpOut.includes(command), `Help must list the ${command} command`);
}
for (const gone of ['check-pr', 'run-local', 'evaluate', 'clean']) {
  assert.ok(!helpOut.includes(gone), `Help must not advertise the removed ${gone} command`);
}
console.log('  ✓ release-harness --help verified');

// 4c. Doctor test
// `doctor` exits non-zero in a repository where nothing has been accepted, and
// that is the product working: 3 means not installed, 2 means installed with
// nothing proven. Exit 0 would be the old defect -- enumerating absent
// contracts and calling the installation Ready. So the exit code is asserted
// rather than assumed, and execSync's throw-on-nonzero is handled.
let doctorOut;
let doctorCode = 0;
try {
  doctorOut = execSync(`${npxCmd} release-harness doctor`, { cwd: consumerRepoDir, encoding: 'utf8' });
} catch (err) {
  doctorOut = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  doctorCode = err.status;
}
assert.notStrictEqual(
  doctorCode,
  0,
  'doctor must not report success in a repository with no accepted contract'
);
assert.ok(
  !/Ready/.test(doctorOut),
  'doctor must never print "Ready" -- that was the original defect'
);
console.log(`  ✓ release-harness doctor executed (exit ${doctorCode}, correctly non-zero)`);

// 4d. Bootstrap must invent nothing
console.log('\n5. Testing release-harness init...');

// This section used to assert that `init` created topology.json, origins.json
// and a smoke scenario. That behaviour is the defect this release removed: the
// tool wrote a topology claiming a browser app on port 3000 into repositories
// containing no such thing, and `doctor` then reported the fabrication as valid
// and the installation as Ready.
//
// So the assertions are inverted. What is checked now is that nothing `init`
// writes makes any claim about the consumer's software.
const initOut = execSync(`${npxCmd} release-harness init`, { cwd: consumerRepoDir, encoding: 'utf8' });
const harnessDir = path.join(consumerRepoDir, '.release-harness');

assert.ok(fs.existsSync(harnessDir), 'init must create the harness directory');
for (const dir of ['drafts', 'accepted', 'bindings', 'runs']) {
  assert.ok(fs.existsSync(path.join(harnessDir, dir)), `init must create ${dir}/`);
}
assert.strictEqual(
  fs.readdirSync(path.join(harnessDir, 'accepted')).length,
  0,
  'init must accept nothing'
);
assert.strictEqual(
  fs.readdirSync(path.join(harnessDir, 'drafts')).length,
  0,
  'init must propose nothing'
);

// Read every byte written outside examples/ and prove no claim about the
// consumer's project is in it.
const written = [];
(function walk(d) {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'examples') walk(full);
    } else written.push(full);
  }
})(harnessDir);

const blob = written.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
for (const fabrication of [/3000/, /localhost/i, /127\.0\.0\.1/, /Welcome/i, /topology/i, /origins/i]) {
  assert.ok(!fabrication.test(blob), `init must never write ${fabrication} into a runtime location`);
}
assert.ok(
  !blob.includes(path.basename(consumerRepoDir)),
  'init must not derive any identity from the directory name'
);
assert.match(initOut, /does not inspect your project/i, 'and must say what it did not do');
console.log('  ✓ init created directories and asserted nothing about the project');

// 4e. The lifecycle, through the installed package
console.log('\n6. Testing the lifecycle through the installed binary...');

// Author a draft the way an operator would: by editing the files `draft new`
// wrote. The subject is a trivial CLI so the assertion is real rather than
// mocked -- the probe layer is genuinely exercised.
fs.writeFileSync(path.join(consumerRepoDir, 'greet.js'), "console.log('hello');\n");
execSync(`${npxCmd} release-harness draft new greeter`, { cwd: consumerRepoDir, encoding: 'utf8' });

const draftPath = path.join(harnessDir, 'drafts', 'greeter.draft.json');
const recordPath = path.join(harnessDir, 'drafts', 'greeter.record.json');

const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
draft.proposition.subject = { id: 'greeter', name: 'Greeter' };
draft.proposition.assertions = [
  {
    id: 'A1',
    kind: 'cli',
    target: 'cli',
    description: 'the CLI greets and exits cleanly',
    expect: { exit_code: 0, stdout_contains: 'hello' },
    supported_by: ['entrypoint'],
  },
];
draft.questions = [
  {
    id: 'Q1',
    question: 'Is a clean exit sufficient?',
    blocking: true,
    resolution: 'Yes for this gate.',
    resolved_by: 'consumer',
  },
];
fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2) + '\n');

const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
record.authored_by = 'consumer';
record.claims = [
  {
    id: 'entrypoint',
    claim: 'greet.js prints a greeting and exits 0',
    status: 'observed',
    evidence: { source: 'greet.js:1' },
  },
];
fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');

execSync(`${npxCmd} release-harness validate`, { cwd: consumerRepoDir, encoding: 'utf8' });
console.log('  ✓ validate passed on a resolved draft');

const acceptOut = execSync(`${npxCmd} release-harness accept --draft greeter --by consumer`, {
  cwd: consumerRepoDir,
  encoding: 'utf8',
});
const digest = acceptOut.match(/Accepted ([0-9a-f]{16})/);
assert.ok(digest, 'accept must report the contract digest');

// The accepted contract is named by its own digest -- the boundary that makes
// editing detectable.
const accepted = fs.readdirSync(path.join(harnessDir, 'accepted'));
assert.ok(
  accepted.some((f) => f.startsWith(digest[1]) && f.endsWith('.contract.json')),
  'the accepted contract must be stored under its own digest'
);
console.log(`  ✓ accepted ${digest[1]}…`);

execSync(`${npxCmd} release-harness bind local --target "cli=node greet.js"`, {
  cwd: consumerRepoDir,
  encoding: 'utf8',
});

const runOut = execSync(`${npxCmd} release-harness run --binding local`, {
  cwd: consumerRepoDir,
  encoding: 'utf8',
});
assert.match(runOut, /Certifying run/, 'the run must certify');
assert.match(runOut, /Status: PASS/, 'and pass');

// The facade version is the engine identity a consumer sees and the run seals.
// A prerelease bump that updates package.json but not the run manifest would
// produce a certificate misidentifying the engine that created it.
const runId = fs.readdirSync(path.join(harnessDir, 'runs'))[0];
const manifest = JSON.parse(
  fs.readFileSync(path.join(harnessDir, 'runs', runId, 'manifest.json'), 'utf8')
);
assert.strictEqual(
  manifest.harness_version,
  corePkgVersion,
  `run manifest must seal the installed engine version ${corePkgVersion}`
);
console.log(`  ✓ certifying run passed and sealed engine ${manifest.harness_version}`);

const verifyOut = execSync(`${npxCmd} release-harness verify`, {
  cwd: consumerRepoDir,
  encoding: 'utf8',
});
assert.match(verifyOut, /whole chain verifies/, 'the chain must verify from the files alone');
for (const link of ['contract', 'evidence', 'verdict']) {
  assert.ok(new RegExp(`ok\\s+${link}`).test(verifyOut), `${link} must be verified`);
}
console.log('  ✓ verify confirmed the whole chain');


// Done. What this suite proves, end to end: a consumer can install the three
// published packages, bootstrap without the tool asserting anything about their
// software, author a proposition by hand, accept it, exercise it, and verify the
// result -- all through the published binary.
//
// The section removed here drove `run-local` against a mock server serving the
// word "Welcome". That command no longer exists, and the page it served is the
// literal text the old `init` fabricated into strangers' repositories.

console.log('\n' + '='.repeat(70));
console.log('PACKAGING & CONSUMER INSTALLATION: ALL CHECKS PASSED');
console.log('='.repeat(70) + '\n');

fs.rmSync(packOutputDir, { recursive: true, force: true });
fs.rmSync(consumerRepoDir, { recursive: true, force: true });
