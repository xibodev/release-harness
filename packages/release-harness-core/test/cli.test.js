import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, readBundledSkills, skillScaffoldStatus, SKILL_TARGETS } from '../src/cli.js';
import { assertSkillSupport } from '../../../tests/package/skill-support.mjs';

async function captureCli(args) {
  const stdout = [], stderr = [];
  const originals = { log: console.log, error: console.error, warn: console.warn };
  try {
    console.log = (...parts) => stdout.push(parts.join(' '));
    console.error = console.warn = (...parts) => stderr.push(parts.join(' '));
    return { exitCode: await runCli(args), stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    Object.assign(console, originals);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-skills-'));
const originalCwd = process.cwd();
const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(coreDir, '../..');
const canonicalName = 'release-harness-project-cartographer';
const valid = `---\nname: ${canonicalName}\ndescription: >\n  Scans the project\n  repository.\n---\n# Instructions\n`;

try {
  process.chdir(tmp);
  const baseline = fs.readdirSync(tmp);
  const list = await captureCli(['skills', 'list']);
  assert.equal(list.exitCode, 0);
  assert.match(list.stdout, /18 bundled/);
  for (const target of SKILL_TARGETS) {
    assert.ok(list.stdout.includes(`${target.relativeDir}/ (0/18 scaffolded; 0 invalid)`));
  }
  assert.equal((await captureCli(['skills'])).stdout, list.stdout);
  assert.equal((await captureCli(['skills', 'list'])).stdout, list.stdout, 'listing is deterministic');
  assert.match(list.stdout, /Scaffold status checks files, not the active host registry/);
  const bare = await captureCli(['skills', 'info', 'project-cartographer']);
  const prefixed = await captureCli(['skills', 'info', canonicalName]);
  assert.equal(bare.exitCode, 0);
  assert.equal(bare.stdout, prefixed.stdout);
  assert.match(bare.stdout, /Capability: Scans the project repository/);
  assert.deepEqual(fs.readdirSync(tmp), baseline, 'list/info must not scaffold or create files');

  for (const args of [
    ['skills', 'info'], ['skills', 'unknown'], ['skills', 'list', '--json'],
    ['skills', 'info', 'project-cartographer', 'extra'], ['skills', '--help', 'extra'],
    ['skills', 'info', '../project-cartographer'], ['skills', 'info', 'missing'],
    ['skills', 'info', 'C:\\secrets'], ['doctor', '--skills'],
  ]) {
    const result = await captureCli(args);
    assert.equal(result.exitCode, 3, JSON.stringify(args));
    assert.match(result.stderr, /Error:/);
  }
  assert.equal((await captureCli(['skills', '--help'])).exitCode, 0);
  assert.match((await captureCli(['--help'])).stdout, /skills/);
  console.log('PASS skills aliases, deterministic read-only listing, help and invalid arguments');

  const bundled = readBundledSkills();
  assert.deepEqual(bundled.map((skill) => skill.name), bundled.map((skill) => skill.name).sort());
  assert.equal(new Set(bundled.map((skill) => skill.name)).size, 18);
  const bundle = path.join(tmp, 'bundle');
  fs.mkdirSync(bundle);
  assert.throws(() => readBundledSkills(bundle), /empty/);
  assert.throws(() => readBundledSkills(path.join(tmp, 'absent')), /ENOENT/);
  const skillDir = path.join(bundle, 'project-cartographer');
  fs.mkdirSync(skillDir);
  const skillFile = path.join(skillDir, 'SKILL.md');
  assert.throws(() => readBundledSkills(bundle), /bundled skill project-cartographer/);
  for (const content of [
    'No frontmatter', '---\n[one, two]\n---\n',
    `---\nname: ${canonicalName}\nname: duplicate\ndescription: test\n---\n`,
    '---\nname: project-cartographer\ndescription: test\n---\n',
    '---\nname: ../../outside\ndescription: test\n---\n',
    `---\nname: ${canonicalName}\ndescription: []\n---\n`,
    `---\nname: ${canonicalName}\ndescription: " "\n---\n`,
    '---\ndescription: test\n---\n',
  ]) {
    fs.writeFileSync(skillFile, content);
    assert.throws(() => readBundledSkills(bundle), /bundled skill project-cartographer/);
  }
  fs.writeFileSync(skillFile, valid.replace(/\n/g, '\r\n'));
  assert.deepEqual(readBundledSkills(bundle), [{ name: canonicalName, description: 'Scans the project repository.' }]);
  const invalidDir = path.join(bundle, 'release-harness-duplicate');
  fs.mkdirSync(invalidDir);
  assert.throws(() => readBundledSkills(bundle), /bare lowercase slug/);
  fs.rmSync(invalidDir, { recursive: true });
  console.log('PASS bundled metadata/path validation, CRLF and folded descriptions');

  for (const target of SKILL_TARGETS) {
    const dir = path.join(tmp, target.relativeDir, canonicalName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), valid);
    assert.equal(skillScaffoldStatus(target, canonicalName), 'scaffolded');
  }
  const statusList = await captureCli(['skills', 'list']);
  for (const target of SKILL_TARGETS) assert.ok(statusList.stdout.includes(`${target.relativeDir}/ (1/18 scaffolded; 0 invalid)`));
  const scaffoldFile = path.join(tmp, SKILL_TARGETS[0].relativeDir, canonicalName, 'SKILL.md');
  fs.writeFileSync(scaffoldFile, 'broken user file');
  assert.equal(skillScaffoldStatus(SKILL_TARGETS[0], canonicalName), 'invalid scaffold');
  assert.match((await captureCli(['skills', 'info', canonicalName])).stdout, /invalid scaffold/);
  assert.equal(fs.readFileSync(scaffoldFile, 'utf8'), 'broken user file', 'discovery must preserve broken scaffolds');
  assert.throws(() => skillScaffoldStatus(SKILL_TARGETS[0], '../escape'), /invalid skill/);
  assert.throws(() => skillScaffoldStatus({ relativeDir: '../escape' }, canonicalName), /invalid skill/);

  // Junctions work without Windows symlink privilege and exercise parent-path escape.
  const outside = path.join(tmp, 'outside');
  const consumer = path.join(tmp, 'consumer');
  fs.mkdirSync(outside);
  fs.mkdirSync(consumer);
  const outsideSkill = path.join(outside, 'skills', canonicalName);
  fs.mkdirSync(outsideSkill, { recursive: true });
  fs.writeFileSync(path.join(outsideSkill, 'SKILL.md'), valid);
  const link = path.join(consumer, '.claude');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(skillScaffoldStatus(SKILL_TARGETS[0], canonicalName, consumer), 'invalid scaffold');
  fs.symlinkSync(outside, path.join(bundle, 'linked-skill'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readBundledSkills(bundle), /symlink/);
  console.log('PASS all target statuses, partial/invalid scaffolds and symlink escape rejection');

  for (const name of ['fix-planner', 'fix-executor']) {
    const text = fs.readFileSync(path.join(coreDir, 'templates', 'skills', name, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(text, /scripts\/[\w-]+\.py|references\/[\w-]+\.md/);
    assert.match(text, /execution-plan\.json/);
    assert.match(text, /UNKNOWN/);
    assert.match(text, /preserve/i);
  }
  const skillsRoot = path.join(coreDir, 'templates', 'skills');
  const skillDirs = fs.readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.equal(skillDirs.length, 18);
  for (const entry of skillDirs) assertSkillSupport(path.join(skillsRoot, entry.name));
  const supportFixture = path.join(tmp, 'support-fixture');
  fs.mkdirSync(supportFixture);
  fs.writeFileSync(path.join(supportFixture, 'SKILL.md'), 'Run `scripts/missing.py`.');
  assert.throws(() => assertSkillSupport(supportFixture), /missing support/);
  fs.writeFileSync(path.join(supportFixture, 'SKILL.md'), 'Read [checklist](references/missing.md).');
  assert.throws(() => assertSkillSupport(supportFixture), /missing support/);
  fs.writeFileSync(path.join(supportFixture, 'SKILL.md'), 'Product-owned example: `scripts/probe.sh` is supplied by the project.');
  assertSkillSupport(supportFixture);
  fs.writeFileSync(path.join(supportFixture, 'SKILL.md'), 'Read [instructions](SKILL.md).');
  assertSkillSupport(supportFixture);
  const decider = fs.readFileSync(path.join(skillsRoot, 'release-decider', 'SKILL.md'), 'utf8');
  assert.match(decider, /sole verdict authority/);
  assert.match(decider, /Nonzero exit/);
  assert.doesNotMatch(decider, /risk-scorer\.py|CONDITIONAL GO.*when release/);
  console.log('PASS all 18 skill support paths, explicit product examples and non-authoritative readiness');
  const body = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  const canonical = body(path.join(coreDir, 'templates', 'agents', 'release-conductor.md'));
  for (const file of [
    'agents/release-conductor.md', '.claude/agents/release-conductor.md',
    '.copilot/agents/release-conductor.md', '.github/agents/release-conductor.agent.md',
    'packages/release-harness-core/templates/agents/release-conductor.agent.md',
  ]) assert.equal(body(path.join(repoDir, file)), canonical, `${file}: body must match canonical protocol`);
  for (const relative of ['README.md', 'docs/index.html', 'docs/docs.html', 'packages/release-harness-core/templates/AI-ADOPTION.md']) {
    const text = fs.readFileSync(path.join(repoDir, relative), 'utf8');
    assert.ok(text.includes('skills list'), relative);
    assert.ok(text.includes('release-harness-project-cartographer'), relative);
    assert.ok(text.includes('release-harness-scenario-compiler'), relative);
    assert.ok(text.includes('release-harness-fix-planner'), relative);
    assert.ok(text.includes('release-harness-fix-executor'), relative);
    assert.match(text, /UNKNOWN/, relative);
    assert.match(text, /preserve/i, relative);
    assert.match(text, /playbooks/i, relative);
    assert.match(text, /(?:logs may be omitted|may omit raw logs|may be retained without raw logs)/i, relative);
    assert.doesNotMatch(text, /Clean corrupted workspace|Clean workspace and re-run|Clean the run directory with/, relative);
  }
  console.log('PASS self-contained remediation skills and tracked conductor body parity');
} finally {
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
