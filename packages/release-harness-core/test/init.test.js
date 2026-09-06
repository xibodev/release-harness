import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync, spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { renderAgentTemplates } from '../src/agent-templates.js';
import { validateAgainstSchema } from '../src/validator.js';
import { Schemas } from '../../release-harness-schemas/index.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tempParent = process.env.RELEASE_HARNESS_TEST_TMP || os.tmpdir();
assert.ok(fs.statSync(tempParent).isDirectory());
const root = fs.mkdtempSync(path.join(tempParent, 'rh-init-'));
const core = path.join(repo, 'packages/release-harness-core');
let cli = path.join(core, 'bin/release-harness.js');
const env = { ...process.env, npm_config_cache: path.join(root, 'npm-cache'), npm_config_offline: 'true' };
function project(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function init(cwd, args = [], expected = 0) {
  const result = spawnSync(process.execPath, [cli, 'init', ...args], { cwd, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, expected, result.stderr || result.error?.message);
  return result;
}
function json(dir, name) { return JSON.parse(fs.readFileSync(path.join(dir, '.release-harness', name), 'utf8')); }
function write(dir, name, value) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function snapshot(dir) {
  const result = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [key, value] of Object.entries(snapshot(file))) result[`${entry.name}/${key}`] = value;
    } else result[entry.name] = fs.readFileSync(file, 'utf8');
  }
  return result;
}
function frontmatter(text) { return YAML.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)[1]); }
const targets = {
  claude: '.claude/agents/release-conductor.md', opencode: '.opencode/agents/release-conductor.md',
  github: '.github/agents/release-conductor.agent.md', copilot: '.copilot/agents/release-conductor.md',
};

try {
  console.log('Running init and runtime template regression tests...');
  for (const [name, slug] of [
    ['my_test_project', 'my-test-project'], ['My  Test', 'my-test'], ['-edge-', 'edge'],
    ['my--project', 'my-project'], ['valid-project', 'valid-project'], ['123', '123'],
    ['a...b___C', 'a-b-c'], ['caf\u00e9-app', 'caf-app'],
  ]) {
    const dir = project(name);
    init(dir);
    const config = json(dir, 'harness.config.json');
    const topology = json(dir, 'topology.json');
    assert.equal(config.product_slug, slug);
    assert.equal(topology.product_slug, slug);
    assert.equal(config.network_policy, undefined);
    assert.deepEqual(topology.network_policy, { mode: 'sealed', allowed_egress: [] });
    validateAgainstSchema(Schemas.HarnessConfigV1, config, name);
    validateAgainstSchema(Schemas.TopologyV1, topology, name);
    validateAgainstSchema(Schemas.OriginsV1, json(dir, 'origins.json'), name);
    validateAgainstSchema(Schemas.ScenarioV1, json(dir, 'scenarios/smoke.json'), name);
    assert.ok(fs.readFileSync(path.join(dir, '.release-harness/README.md'), 'utf8').includes(slug));
  }
  for (const name of ['!!!', '---', '\u6771\u4eac']) {
    const dir = project(name);
    for (const flags of [[], ['--with-agents'], ['--dry-run'], ['--force']]) {
      assert.match(init(dir, flags, 3).stderr, /non-empty/);
      assert.deepEqual(fs.readdirSync(dir), []);
    }
  }
  for (const name of ['harness.config.json', 'topology.json']) {
    const dir = project(`partial-${name}`);
    const existing = { product_slug: 'owned-identity', custom: 'keep', network_policy: { mode: 'open', allowed_egress: [] } };
    write(dir, `.release-harness/${name}`, existing);
    const before = fs.readFileSync(path.join(dir, '.release-harness', name), 'utf8');
    init(dir);
    assert.equal(fs.readFileSync(path.join(dir, '.release-harness', name), 'utf8'), before);
    assert.equal(json(dir, 'harness.config.json').product_slug, 'owned-identity');
    assert.equal(json(dir, 'topology.json').product_slug, 'owned-identity');
    if (name === 'harness.config.json') assert.deepEqual(json(dir, 'topology.json').network_policy, existing.network_policy);
  }
  const renamed = project('!!!/!!!');
  write(renamed, '.release-harness/topology.json', { product_slug: 'original-identity' });
  init(renamed, ['--force']);
  assert.equal(json(renamed, 'harness.config.json').product_slug, 'original-identity');
  assert.equal(json(renamed, 'topology.json').product_slug, 'original-identity');
  for (const [name, config, topology] of [
    ['conflict', { product_slug: 'one' }, { product_slug: 'two' }],
    ['invalid', { product_slug: 'bad_slug' }, null],
    ['missing-slug', {}, null], ['malformed', '{', null],
    ['invalid-policy', { product_slug: 'valid', network_policy: { mode: 'invalid' } }, null],
  ]) {
    const dir = project(name);
    write(dir, '.release-harness/harness.config.json', config);
    if (topology) write(dir, '.release-harness/topology.json', topology);
    const before = snapshot(dir);
    for (const flags of [[], ['--with-agents'], ['--overwrite'], ['--dry-run']]) {
      init(dir, flags, 3);
      assert.deepEqual(snapshot(dir), before, `${name} mutated existing files`);
    }
  }
  const source = fs.readFileSync(path.join(core, 'templates/agents/release-conductor.md'), 'utf8');
  const rendered = renderAgentTemplates(source);
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const capabilities = frontmatter(source)['claude-tools'];
  assert.deepEqual(frontmatter(rendered.claude).tools, capabilities);
  assert.ok(frontmatter(rendered.claude).tools.includes('Skill'));
  assert.equal(frontmatter(rendered.opencode).tools.skill, true);
  for (const [runtime, text] of Object.entries(rendered)) {
    assert.equal(text.replace(/^---\n[\s\S]*?\n---\n/, ''), body);
    const fm = frontmatter(text);
    assert.equal(fm['claude-tools'], undefined);
    assert.equal(fm.handoffs, undefined);
    assert.equal(fm.agents, undefined);
    if (runtime === 'opencode') {
      assert.equal(fm.mode, 'primary');
      assert.ok(!Array.isArray(fm.tools));
      for (const [tool, enabled] of Object.entries(fm.tools)) {
        assert.ok(['read', 'write', 'edit', 'bash', 'grep', 'glob', 'task', 'webfetch', 'websearch', 'skill'].includes(tool));
        assert.equal(enabled, true);
      }
    } else if (runtime !== 'claude') {
      for (const tool of fm.tools) assert.ok(['read', 'edit', 'execute', 'search', 'agent', 'web'].includes(tool));
    }
  }
  assert.throws(() => renderAgentTemplates(source.replace(/^claude-tools:.*$/m, 'claude-tools: [Read, UnknownTool]')), /Unsupported agent tool/);
  assert.throws(() => renderAgentTemplates(source.replace(/^claude-tools:.*$/m, 'claude-tools: []')), /non-empty/);
  assert.throws(() => renderAgentTemplates('no frontmatter'), /frontmatter/);
  const allTools = renderAgentTemplates(source.replace(/^claude-tools:.*$/m,
    'claude-tools: [Read, Write, Edit, Bash, Grep, Glob, Agent, WebFetch, WebSearch, Skill]'));
  assert.deepEqual(frontmatter(allTools.opencode).tools, {
    read: true, write: true, edit: true, bash: true, grep: true, glob: true, task: true, webfetch: true, websearch: true, skill: true,
  });
  assert.deepEqual(frontmatter(allTools.copilot).tools, ['read', 'edit', 'execute', 'search', 'agent', 'web']);
  assert.equal(allTools.github, allTools.copilot);

  const agents = project('agents');
  write(agents, 'AGENTS.md', '# Project instructions\n');
  const sharedSkill = '.agents/skills/release-harness-project-cartographer/SKILL.md';
  write(agents, sharedSkill, '# Customized shared skill\n');
  const collision = init(agents, ['--with-agents']).stdout;
  assert.match(collision, /already present in \.agents\/skills/);
  assert.match(collision, /merge or update only the affected skill files/);
  assert.match(collision, /resets project contracts/);
  assert.doesNotMatch(collision, /pass --force to overwrite/);
  assert.equal(fs.readFileSync(path.join(agents, sharedSkill), 'utf8'), '# Customized shared skill\n');
  assert.ok(fs.existsSync(path.join(agents, '.agents/skills/release-harness-scenario-compiler/SKILL.md')));
  assert.equal(fs.readFileSync(path.join(agents, 'AGENTS.md'), 'utf8'), '# Project instructions\n');
  for (const [runtime, target] of Object.entries(targets)) assert.equal(fs.readFileSync(path.join(agents, target), 'utf8'), rendered[runtime]);
  const config = json(agents, 'harness.config.json');
  config.port_block.start = 32000;
  config.network_policy = { mode: 'open', allowed_egress: [] };
  write(agents, '.release-harness/harness.config.json', config);
  write(agents, targets.claude, '# Customized agent\n');
  const customized = snapshot(agents);
  for (const flags of [['--with-agents'], ['--contracts-only'], ['--with-agents', '--force', '--dry-run']]) {
    init(agents, flags);
    assert.deepEqual(snapshot(agents), customized);
  }
  init(agents, ['--with-agents', '--overwrite']);
  assert.equal(json(agents, 'harness.config.json').port_block.start, 31000);
  assert.equal(fs.readFileSync(path.join(agents, targets.claude), 'utf8'), rendered.claude);
  assert.equal(fs.readFileSync(path.join(agents, sharedSkill), 'utf8'), fs.readFileSync(path.join(core, 'templates/skills/project-cartographer/SKILL.md'), 'utf8'));
  const dry = project('dry');
  init(dry, ['--with-agents', '--dry-run']);
  assert.deepEqual(fs.readdirSync(dry), []);
  init(dry, ['--with-agents', '--contracts-only'], 3);
  assert.deepEqual(fs.readdirSync(dry), []);

  // Exercise the actual packed assets, not the repository's runtime variants.
  const packageRoot = project('packed');
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(packageRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const name of ['release-harness-core', 'release-harness-schemas']) {
    const result = JSON.parse(execSync(`npm pack --ignore-scripts --json --pack-destination "${root}"`, {
      cwd: path.join(repo, 'packages', name), env, encoding: 'utf8', timeout: 60000,
    }));
    const unpacked = project(`packed/${name}`);
    execFileSync('tar', ['-xf', path.join(root, result[0].filename), '-C', unpacked, '--strip-components=1']);
  }
  cli = path.join(packageRoot, 'release-harness-core/bin/release-harness.js');
  const consumer = project('packed_consumer');
  init(consumer, ['--with-agents']);
  for (const [runtime, target] of Object.entries(targets)) assert.equal(fs.readFileSync(path.join(consumer, target), 'utf8'), rendered[runtime]);
  assert.equal(json(consumer, 'topology.json').product_slug, 'packed-consumer');
  assert.ok(fs.existsSync(path.join(consumer, sharedSkill)));
  // Opt-in host acceptance: no model invocation, user configuration or plugins.
  if (process.env.RELEASE_HARNESS_TEST_OPENCODE) {
    const home = project('runtime-home');
    const isolated = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|pathext|systemdrive)$/i.test(key)));
    Object.assign(isolated, {
      HOME: home, USERPROFILE: home, OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home, XDG_STATE_HOME: home,
      APPDATA: home, LOCALAPPDATA: home, TEMP: root, TMP: root,
      OPENCODE_PURE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_CONFIG_CONTENT: '{"autoupdate":false,"snapshot":false,"enabled_providers":[],"plugin":[],"mcp":{}}',
    });
    const host = spawnSync(process.env.RELEASE_HARNESS_TEST_OPENCODE, ['debug', 'config', '--pure'], {
      cwd: consumer, env: isolated, encoding: 'utf8', timeout: 60000,
    });
    assert.equal(host.status, 0, host.stderr || host.error?.message);
    const loaded = JSON.parse(host.stdout).agent['release-conductor'];
    assert.equal(loaded.mode, 'primary');
    assert.deepEqual(loaded.tools, frontmatter(rendered.opencode).tools);
    console.log('Packed opencode agent accepted by isolated opencode debug config.');
  }
  const canonical = path.join(packageRoot, 'release-harness-core/templates/agents/release-conductor.md');
  fs.writeFileSync(canonical, source.replace(/^claude-tools:.*$/m, 'claude-tools: [UnknownTool]'));
  const broken = project('broken-package');
  init(broken, ['--with-agents'], 3);
  assert.deepEqual(fs.readdirSync(broken), []);
  fs.unlinkSync(canonical);
  init(broken, ['--with-agents'], 3);
  assert.deepEqual(fs.readdirSync(broken), []);
  init(broken, ['--contracts-only']);
  fs.writeFileSync(canonical, source);
  const packedTemplates = path.join(packageRoot, 'release-harness-core/templates');
  const preflight = project('preflight');
  write(preflight, '.agents/skills/custom/SKILL.md', '# Preserve me\n');
  const preflightBefore = snapshot(preflight);
  const checkPreflight = () => {
    for (const flags of [['--with-agents'], ['--with-agents', '--dry-run'], ['--with-agents', '--overwrite']]) {
      init(preflight, flags, 3);
      assert.deepEqual(snapshot(preflight), preflightBefore);
    }
  };
  for (const asset of ['AI-ADOPTION.md', 'agents/AGENTS.md', 'agents/.cursorrules', 'agents/copilot-instructions.md', 'skills/project-cartographer/SKILL.md']) {
    const file = path.join(packedTemplates, asset);
    const content = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);
    checkPreflight();
    fs.writeFileSync(file, ' \n');
    checkPreflight();
    fs.writeFileSync(file, '\u0000invalid');
    checkPreflight();
    fs.writeFileSync(file, content);
  }
  const skillFile = path.join(packedTemplates, 'skills/project-cartographer/SKILL.md');
  const skillContent = fs.readFileSync(skillFile, 'utf8');
  for (const content of ['---\nname: [\n---\nbad YAML', '---\nname: wrong-name\ndescription: Wrong name\n---\nbody']) {
    fs.writeFileSync(skillFile, content);
    checkPreflight();
  }
  fs.writeFileSync(skillFile, skillContent);
  const skillsDirectory = path.join(packedTemplates, 'skills');
  fs.renameSync(skillsDirectory, `${skillsDirectory}-saved`);
  checkPreflight();
  fs.mkdirSync(skillsDirectory);
  checkPreflight();
  fs.rmdirSync(skillsDirectory);
  fs.renameSync(`${skillsDirectory}-saved`, skillsDirectory);

  const templatesBefore = snapshot(path.join(core, 'templates'));
  const retired = spawnSync(process.execPath, [path.join(repo, 'scripts/generate-harness-templates.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(retired.status, 1);
  assert.match(retired.stderr, /retired/);
  assert.deepEqual(snapshot(path.join(core, 'templates')), templatesBefore);
  console.log('Init slug, preservation, runtime rendering, packed consumer and retired-generator tests PASSED.');
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
