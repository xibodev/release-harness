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
assert.ok(helpOut.includes('doctor'), 'Help must list doctor command');
assert.ok(helpOut.includes('skills'), 'Help must list skills command');
assert.ok(helpOut.includes('check-pr'), 'Help must list check-pr command');
assert.ok(helpOut.includes('run-local'), 'Help must list run-local command');
assert.ok(helpOut.includes('clean'), 'Help must list clean command');
console.log('  ✓ release-harness --help verified');

// 4c. Skills can be inspected from the package before any templates are extracted.
const skillsListOut = execSync(`${npxCmd} release-harness skills list`, { cwd: consumerRepoDir, encoding: 'utf8' });
assert.ok(skillsListOut.includes('18 bundled'), 'skills list must report the bundled skill count');
assert.ok(skillsListOut.includes('release-harness-project-cartographer'), 'skills list must use canonical prefixed names');
assert.ok(skillsListOut.includes('.claude/skills/'), 'skills list must name the Claude scaffold target');
assert.ok(skillsListOut.includes('.agents/skills/'), 'skills list must name the shared Agent Skills target');
assert.ok(skillsListOut.includes('.opencode/skills/'), 'skills list must name the opencode scaffold target');
assert.ok(skillsListOut.includes('Scaffold all skills: npx release-harness init --with-agents'), 'skills list output must reach its final guidance');
assert.ok(!fs.existsSync(path.join(consumerRepoDir, '.claude')), 'skills list must not extract templates');
assert.ok(!fs.existsSync(path.join(consumerRepoDir, '.agents')), 'skills list must not create the shared target');

const skillInfoOut = execSync(`${npxCmd} release-harness skills info project-cartographer`, {
  cwd: consumerRepoDir,
  encoding: 'utf8',
});
assert.ok(skillInfoOut.includes('Skill: release-harness-project-cartographer'), 'skills info must accept a bare skill name');
assert.ok(skillInfoOut.includes('Capability:'), 'skills info must describe the skill capability');
console.log('  ✓ Bundled skills inspected before scaffolding');

// 4d. Doctor test
const doctorOut = execSync(`${npxCmd} release-harness doctor`, { cwd: consumerRepoDir, encoding: 'utf8' });
assert.ok(doctorOut.includes('init --with-agents'), 'doctor must point agents to bundle scaffolding');
assert.ok(doctorOut.includes('skills list'), 'doctor must point agents to in-flight skill discovery');
console.log('  ✓ release-harness doctor executed');

// 4e. Init scaffolding test
console.log('\n5. Testing release-harness init scaffolding...');

// A bare init writes contracts only. Agent scaffolding is explicit opt-in, so
// nothing may appear under .claude/ until --with-agents is passed.
const bareInitOut = execSync(`${npxCmd} release-harness init`, { cwd: consumerRepoDir, encoding: 'utf8' });
assert.ok(fs.existsSync(path.join(consumerRepoDir, '.release-harness', 'topology.json')), 'topology.json must be created');
assert.ok(fs.existsSync(path.join(consumerRepoDir, '.release-harness', 'origins.json')), 'origins.json must be created');
assert.ok(fs.existsSync(path.join(consumerRepoDir, '.release-harness', 'scenarios', 'smoke.json')), 'smoke.json must be created');
assert.ok(!fs.existsSync(path.join(consumerRepoDir, 'AGENTS.md')), 'A bare init must not scaffold AGENTS.md');
assert.ok(!fs.existsSync(path.join(consumerRepoDir, 'AI-ADOPTION.md')), 'A bare init must not scaffold AI-ADOPTION.md');
assert.ok(!fs.existsSync(path.join(consumerRepoDir, '.claude')), 'A bare init must not scaffold agents implicitly');
assert.ok(!fs.existsSync(path.join(consumerRepoDir, '.agents')), 'A bare init must not scaffold shared skills implicitly');
assert.ok(bareInitOut.includes('--with-agents'), 'A bare init must name the flag that scaffolds the agent bundle');
console.log('  ✓ Bare init wrote contracts only and pointed at --with-agents');

// An unknown flag is a harness configuration error (exit 3), not a silent no-op.
const unknownFlag = spawnSync(npxCmd, ['release-harness', 'init', '--nonsense'], {
  cwd: consumerRepoDir, encoding: 'utf8', shell: true,
});
assert.strictEqual(unknownFlag.status, 3, 'An unknown flag must exit 3');
assert.ok(String(unknownFlag.stderr).includes('unknown flag --nonsense'), 'The rejected flag must be named');
console.log('  ✓ Unknown flags rejected with exit 3');

// Contradictory scaffolding flags are a configuration error too.
const conflictInit = spawnSync(npxCmd, ['release-harness', 'init', '--with-agents', '--contracts-only'], {
  cwd: consumerRepoDir, encoding: 'utf8', shell: true,
});
assert.strictEqual(conflictInit.status, 3, '--with-agents with --contracts-only must exit 3');
console.log('  ✓ --with-agents + --contracts-only rejected with exit 3');

// Now the explicit opt-in.
const initOut = execSync(`${npxCmd} release-harness init --with-agents`, { cwd: consumerRepoDir, encoding: 'utf8' });
assert.match(initOut, /restart or reload the active agent session/i, 'Agent scaffolding must tell an active host to reindex skills');
assert.ok(fs.existsSync(path.join(consumerRepoDir, 'AGENTS.md')), 'AGENTS.md must be scaffolded');
assert.ok(fs.readFileSync(path.join(consumerRepoDir, 'AGENTS.md'), 'utf8').includes('.agents/skills/release-harness-*'), 'AGENTS.md must identify the shared skill target');
assert.ok(fs.existsSync(path.join(consumerRepoDir, '.claude', 'agents', 'release-conductor.md')), 'Claude agent must be scaffolded');
assert.ok(fs.existsSync(path.join(consumerRepoDir, '.github', 'agents', 'release-conductor.agent.md')), 'GitHub Copilot agent must be scaffolded');
assert.ok(fs.existsSync(path.join(consumerRepoDir, '.opencode', 'agents', 'release-conductor.md')), 'opencode agent must be scaffolded');
assert.ok(fs.existsSync(path.join(consumerRepoDir, '.copilot', 'agents', 'release-conductor.md')), 'Copilot CLI agent must be scaffolded');
const scaffoldedSkillsOut = execSync(`${npxCmd} release-harness skills list`, { cwd: consumerRepoDir, encoding: 'utf8' });
assert.match(scaffoldedSkillsOut, /Claude Code\s+\.claude\/skills\/ \(18\/18 scaffolded\)/);
assert.match(scaffoldedSkillsOut, /Agent Skills\s+\.agents\/skills\/ \(18\/18 scaffolded\)/);
assert.match(scaffoldedSkillsOut, /opencode\s+\.opencode\/skills\/ \(18\/18 scaffolded\)/);

// The adoption guide reaches the project the same way the skills do -- through
// init. It has to state that, or an agent that looked for the bundle before
// running init concludes the bundle does not exist.
const adoptionPath = path.join(consumerRepoDir, 'AI-ADOPTION.md');
assert.ok(fs.existsSync(adoptionPath), 'AI-ADOPTION.md must be scaffolded with --with-agents');
const adoption = fs.readFileSync(adoptionPath, 'utf8');
assert.ok(/init --with-agents/.test(adoption), 'AI-ADOPTION.md must name the command that scaffolds the bundle');
assert.ok(/not with `npm install`|not with npm install/.test(adoption), 'AI-ADOPTION.md must say the bundle does not arrive with npm install');
assert.ok(adoption.includes('release-harness-project-cartographer'), 'AI-ADOPTION.md must use the canonical cartographer name');
assert.ok(adoption.includes('release-harness-scenario-compiler'), 'AI-ADOPTION.md must use the canonical compiler name');
assert.ok(adoption.includes('generated review artifacts'), 'AI-ADOPTION.md must frame contracts as generated artifacts');
assert.match(adoption, /present the\s+resulting diff for approval/, 'AI-ADOPTION.md must require human artifact review');
assert.ok(adoption.includes('check-pr') && adoption.includes('release branches'), 'AI-ADOPTION.md must cover CI/CD integration');
for (const code of ['| 0 |', '| 1 |', '| 2 |', '| 3 |', '| 4 |']) {
  assert.ok(adoption.includes(code), `AI-ADOPTION.md exit-code table must cover ${code}`);
}
assert.ok(/[Ee]xit 3 means the harness could not do its job/.test(adoption), 'AI-ADOPTION.md must explain that exit 3 is not a product failure');
console.log('  ✓ AI-ADOPTION.md scaffolded with the adoption order and exit-code table');

for (const conductorPath of [
  path.join(consumerRepoDir, '.claude', 'agents', 'release-conductor.md'),
  path.join(consumerRepoDir, '.copilot', 'agents', 'release-conductor.md'),
  path.join(consumerRepoDir, '.opencode', 'agents', 'release-conductor.md'),
  path.join(corePkgDir, 'templates', 'agents', 'release-conductor.agent.md'),
]) {
  const conductor = fs.readFileSync(conductorPath, 'utf8');
  assert.ok(conductor.includes('npx release-harness skills list'), `${conductorPath} must inspect packaged skills`);
  assert.ok(conductor.includes('release-harness-project-cartographer'), `${conductorPath} must use the prefixed cartographer`);
  assert.ok(conductor.includes('generated artifact diff'), `${conductorPath} must require human artifact review`);
  assert.ok(conductor.includes('Inspect underlying scenario statuses and causes'), `${conductorPath} must preserve dirty-run failures`);
  assert.match(conductor, /do not edit product code solely because of exit 3/i, `${conductorPath} must route exit 3 correctly`);
}
console.log('  ✓ Multi-runtime conductors enforce prefixed, artifact-first adoption');

// Skills scaffold under the release-harness- namespace so they cannot shadow a
// same-named skill the consumer already has installed globally.
assert.ok(
  fs.existsSync(path.join(consumerRepoDir, '.claude', 'skills', 'release-harness-project-cartographer', 'SKILL.md')),
  'Claude skill must be scaffolded under its namespaced name'
);
assert.ok(
  !fs.existsSync(path.join(consumerRepoDir, '.claude', 'skills', 'project-cartographer')),
  'No skill may be scaffolded under its bare, shadowing name'
);

// Assert the count against the shipped bundle AND against a literal, so that
// adding or removing a skill fails here until the docs are updated with it.
const bundledSkills = fs
  .readdirSync(path.join(corePkgDir, 'templates', 'skills'), { withFileTypes: true })
  .filter((e) => e.isDirectory()).length;
assert.strictEqual(bundledSkills, 18, 'The bundle must ship exactly 18 skills (update the docs and this number together)');

for (const runtime of ['.claude', '.agents', '.opencode']) {
  const scaffolded = fs.readdirSync(path.join(consumerRepoDir, runtime, 'skills'));
  assert.strictEqual(scaffolded.length, bundledSkills, `All ${bundledSkills} skills must be scaffolded into ${runtime}/skills`);
  for (const skillDir of scaffolded) {
    assert.ok(skillDir.startsWith('release-harness-'), `Skill "${skillDir}" in ${runtime} must be namespaced`);
    // A runtime resolves a skill by its frontmatter name, not its directory, so
    // both must carry the namespace or the skill still shadows a global one.
    const frontmatter = fs.readFileSync(path.join(consumerRepoDir, runtime, 'skills', skillDir, 'SKILL.md'), 'utf8');
    const declaredName = /^name:[ \t]*(\S+)/m.exec(frontmatter)?.[1];
    assert.strictEqual(declaredName, skillDir, `Skill "${skillDir}" must declare its namespaced name in frontmatter (got "${declaredName}")`);
  }
}
console.log(`  ✓ .release-harness/ and multi-runtime AI agents scaffolded (${bundledSkills} namespaced skills per runtime)`);

// The bundle must teach the agent to author side-effect probes. An implemented
// probe that no skill can emit is unreachable in practice: the adopting agent
// writes scenarios from scenario-compiler, so a probe absent from that skill is
// a probe nobody declares.
const compilerSkill = fs.readFileSync(
  path.join(consumerRepoDir, '.claude', 'skills', 'release-harness-scenario-compiler', 'SKILL.md'),
  'utf8'
);
assert.ok(compilerSkill.includes('expected_side_effects'), 'scenario-compiler must teach expected_side_effects');
assert.ok(compilerSkill.includes('probe_type'), 'scenario-compiler must teach probe_type');
assert.ok(compilerSkill.includes('"service": "custom"'), 'scenario-compiler must show the custom probe form');
assert.ok(compilerSkill.includes('sql_query'), 'scenario-compiler must warn that sql_query is unimplemented');
console.log('  ✓ scenario-compiler teaches side-effect probes including the custom form');

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
  assert.strictEqual(runManifest.harness_core_version, corePkgVersion, 'Recorded harness core version must match the published core package version');
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
