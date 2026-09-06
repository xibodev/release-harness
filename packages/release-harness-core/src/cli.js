import crypto from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { parse as parseYaml } from 'yaml';
import { SourceMaterializer } from './materializer.js';
import { EvidenceSealer } from './sealer.js';
import { SecretRedactor } from './redactor.js';
import { evaluateRun } from './evaluator.js';
import { detectToolchain } from './toolchain.js';
import { DockerComposeRunner } from './runner.js';
import { ScenarioRunner } from './scenario-runner.js';
import { parseScenarioFile } from './scenario-parser.js';
import { validateTopology, validateOrigins, validateHarnessConfig, ValidationError } from './validator.js';

const HARNESS_VERSION = '1.2.0';

export async function runCli(argv = process.argv.slice(2)) {
  const command = argv[0];

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(`@xibodev/release-harness v${HARNESS_VERSION}`);
    return 0;
  }

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return 0;
  }

  if (command === 'doctor') {
    return handleDoctor(argv.slice(1));
  }

  if (command === 'init') {
    return handleInit(argv.slice(1));
  }

  if (command === 'skills') {
    return handleSkills(argv.slice(1));
  }

  if (command === 'evaluate') {
    return handleEvaluate(argv.slice(1));
  }

  if (command === 'check-pr') {
    return handleCheckPr(argv.slice(1));
  }

  if (command === 'run-local') {
    return handleRunLocal(argv.slice(1));
  }

  if (command === 'clean') {
    return handleClean(argv.slice(1));
  }

  if (command === 'run-ephemeral' || command === 'verify-canary') {
    console.error(`Command "${command}" is part of the v1.1/v1.2 roadmap and is not enabled in v1.0.`);
    return 3;
  }

  console.error(`Unknown command "${command}". Run release-harness --help for usage.`);
  return 3;
}

function printHelp() {
  console.log(`
Release-Harness Core CLI (v${HARNESS_VERSION})
Deterministic quality-gate adjudication and test execution engine.

Commands:
  doctor        Check host prerequisites, toolchain, and project contracts
  init          Scaffold project-owned .release-harness/ contracts (use --with-agents for AI agents)
  skills        Inspect packaged skills without writing files (list or info <name>)
  check-pr      Run Level 1 PR Integration Gate (contracts, toolchain, and configured PR commands)
  run-local     Run Level 2 Local Release UAT Gate (scoped Compose, scenarios, probes)
  evaluate      Pure-function deterministic adjudication of existing evidence
  clean         Clean up run workspaces and lingering scoped test containers

Options:
  --evidence-dir    External evidence output directory (default: system cache)
  --allow-dirty     Allow uncommitted changes (marks run as NON-CERTIFYING development mode, exit 2)
  --with-agents     Scaffold AI agent instructions and skills during init
  --contracts-only  Scaffold only .release-harness/ contracts, no agent instructions
  --force           Overwrite existing files during init
  --overwrite       Alias for --force
  --dry-run         Simulate action without writing files
  --run-id          Target a specific run ID for evaluation or cleanup
  --port-offset     Port block offset for concurrent runs (default: 0)
  --time            Fixed evaluation timestamp for deterministic replay
  --version, -v     Show release-harness version
  --help, -h        Show this help message
`);
}

/**
 * The flags each command accepts. A flag absent from its command's list is a
 * configuration error, not a no-op: `--contracts-only` was documented but read
 * nowhere, so it exited 0 while doing the opposite of what it promised.
 */
export const KNOWN_FLAGS = {
  doctor: [],
  init: ['with-agents', 'contracts-only', 'force', 'overwrite', 'dry-run'],
  'check-pr': ['allow-dirty'],
  'run-local': ['evidence-dir', 'allow-dirty', 'run-id', 'port-offset', 'time'],
  evaluate: ['evidence-dir', 'run-id', 'time'],
  clean: ['evidence-dir', 'run-id'],
};

/**
 * Parse `--flag` / `--flag value` arguments.
 *
 * The returned value is the flag map itself, carrying two extra non-enumerable
 * views so both call shapes read correctly from one return value:
 *
 *   const flags = parseFlags(args);                        // map, as before
 *   const { flags, unknown } = parseFlags(args, allowed);  // validated
 *
 * With no `allowedFlags` nothing is validated and `unknown` is always empty, so
 * a one-argument call behaves exactly as it did before validation existed.
 * The views are non-enumerable, so they never appear in `Object.keys`,
 * `JSON.stringify`, or a spread of the flag map.
 *
 * `flags` and `unknown` are consequently reserved names: no command accepts
 * `--flags` or `--unknown`, and both are reported as unknown when validating.
 */
export function parseFlags(args, allowedFlags = null) {
  const flags = {};
  const unknown = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'flags' || key === 'unknown') {
      // Reserved by the return shape above; never let one shadow a view.
      unknown.push(key);
      continue;
    }
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
    if (allowedFlags && !allowedFlags.includes(key)) {
      unknown.push(key);
    }
  }
  Object.defineProperty(flags, 'flags', { value: flags, enumerable: false });
  Object.defineProperty(flags, 'unknown', { value: unknown, enumerable: false });
  return flags;
}

/**
 * Print each unrecognised flag. Callers turn a non-empty list into exit 3 --
 * a harness configuration error, not a product failure.
 */
function reportUnknownFlags(unknown) {
  for (const u of unknown) {
    console.error(`Error: unknown flag --${u}`);
  }
  console.error('Run "release-harness --help" for the flags this command accepts.');
}

function resolveEvidenceRoot(flags, productSlug) {
  if (flags['evidence-dir']) {
    return path.resolve(flags['evidence-dir']);
  }
  const baseCache = process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(baseCache, 'release-harness', productSlug || 'default');
}

/**
 * List the top-level directory names `copyDirectoryRecursive` would create in
 * `dest`, given the same `src` and `namespacePrefix`. Skills are directories, so
 * only directories are namespaced and only directories can collide.
 */
export function namespacedEntryNames(src, namespacePrefix = '') {
  if (!fs.existsSync(src)) return [];
  return fs
    .readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `${namespacePrefix}${e.name}`);
}

/**
 * Names in `names` that already exist in `destDir`. Reported before writing so
 * an adopter sees the ambiguity rather than having it resolved by load order.
 */
export function detectCollisions(destDir, names) {
  if (!fs.existsSync(destDir)) return [];
  const existing = new Set(fs.readdirSync(destDir));
  return names.filter((n) => existing.has(n));
}

/**
 * Prefix applied to every scaffolded skill directory. The bundle's skills carry
 * generic names (security-audit, fix-planner, ...) that a user very plausibly
 * already has globally; without a namespace the copies shadow them, and a
 * same-named skill with a different contract then resolves by load order.
 */
export const SKILL_NAMESPACE = 'release-harness-';

export const SKILL_TARGETS = [
  { label: 'Claude Code', relativeDir: '.claude/skills' },
  { label: 'Agent Skills', relativeDir: '.agents/skills' },
  { label: 'opencode', relativeDir: '.opencode/skills' },
];

const bundledSkillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../templates/skills');

function skillMetadata(content, expectedName) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!frontmatter) throw new Error('missing YAML frontmatter');
  const metadata = parseYaml(frontmatter[1]);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('frontmatter must be a mapping');
  }
  if (metadata.name !== expectedName) {
    throw new Error(`frontmatter name must match ${expectedName}`);
  }
  if (typeof metadata.description !== 'string' || !metadata.description.trim() ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(metadata.description)) {
    throw new Error('description must be nonempty text without control characters');
  }
  return { name: expectedName, description: metadata.description.replace(/\s+/g, ' ').trim() };
}

// An explicit directory keeps malformed-package tests independent of installed assets.
export function readBundledSkills(skillsDir = bundledSkillsDir) {
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skills = [];
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (entry.isSymbolicLink()) throw new Error(`bundled skill entry ${entry.name} must not be a symlink`);
    if (!entry.isDirectory()) continue;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name) || entry.name.startsWith(SKILL_NAMESPACE)) {
      throw new Error(`invalid bundled skill directory ${JSON.stringify(entry.name)}; expected a bare lowercase slug`);
    }
    const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
    try {
      const stat = fs.lstatSync(skillFile);
      if (!stat.isFile()) throw new Error('SKILL.md must be a regular file, not a symlink');
      skills.push(skillMetadata(fs.readFileSync(skillFile, 'utf8'), `${SKILL_NAMESPACE}${entry.name}`));
    } catch (err) {
      throw new Error(`bundled skill ${entry.name}: ${err.message}`);
    }
  }
  if (!skills.length) throw new Error('the installed skill bundle is empty');
  return skills;
}

export function skillScaffoldStatus(target, name, cwd = process.cwd()) {
  if (!SKILL_TARGETS.some((candidate) => candidate.relativeDir === target.relativeDir) ||
      !/^release-harness-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error('invalid skill target or name');
  }
  const skillFile = path.join(cwd, target.relativeDir, name, 'SKILL.md');
  try {
    if (!fs.lstatSync(skillFile).isFile()) return 'invalid scaffold';
    const relative = path.relative(fs.realpathSync(cwd), fs.realpathSync(skillFile));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return 'invalid scaffold';
    skillMetadata(fs.readFileSync(skillFile, 'utf8'), name);
    return 'scaffolded';
  } catch (err) {
    return err.code === 'ENOENT' ? 'not scaffolded' : 'invalid scaffold';
  }
}

function handleSkills(args) {
  const action = args[0] || 'list';
  if (['--help', '-h', 'help'].includes(action) && args.length === 1) {
    console.log(`Usage: release-harness skills [list]\n       release-harness skills info <name>\n\nInfo accepts bare names (project-cartographer) or canonical names (${SKILL_NAMESPACE}project-cartographer).\nDiscovery reads packaged metadata and local scaffold files; it never installs or modifies them.`);
    return 0;
  }
  if (!['list', 'info'].includes(action) || (action === 'list' && args.length > 1) ||
      (action === 'info' && args.length !== 2)) {
    console.error('Error: expected skills [list] or skills info <name>. Run "release-harness skills --help".');
    return 3;
  }
  try {
    const skills = readBundledSkills();
    if (action === 'info') {
      const name = args[1].startsWith(SKILL_NAMESPACE) ? args[1] : `${SKILL_NAMESPACE}${args[1]}`;
      const skill = skills.find((candidate) => candidate.name === name);
      if (!skill) {
        console.error(`Error: unknown bundled skill ${JSON.stringify(args[1])}. Run "release-harness skills list".`);
        return 3;
      }
      console.log(`Skill: ${skill.name}\nCapability: ${skill.description}\nScaffold targets:`);
      for (const target of SKILL_TARGETS) {
        console.log(`  ${target.label.padEnd(13)} ${target.relativeDir}/${skill.name}/SKILL.md (${skillScaffoldStatus(target, skill.name)})`);
      }
    } else {
      console.log(`Release-Harness Cognitive Skills (${skills.length} bundled)\nScaffold targets:`);
      for (const target of SKILL_TARGETS) {
        const statuses = skills.map((skill) => skillScaffoldStatus(target, skill.name));
        console.log(`  ${target.label.padEnd(13)} ${target.relativeDir}/ (${statuses.filter((status) => status === 'scaffolded').length}/${skills.length} scaffolded; ${statuses.filter((status) => status === 'invalid scaffold').length} invalid)`);
      }
      console.log('\nCapabilities:');
      for (const skill of skills) console.log(`  ${skill.name}\n    ${skill.description}`);
    }
    console.log('\nScaffold all skills: npx release-harness init --with-agents');
    console.log('Scaffold status checks files, not the active host registry. Reload your host if skills are not visible.');
    console.log('Invalid scaffold: inspect its SKILL.md metadata/path and repair only that file; do not overwrite project contracts.');
    return 0;
  } catch (err) {
    console.error(`Error: unable to inspect bundled skills: ${err.message}`);
    console.error('Reinstall the package if its templates are missing or malformed; no files were changed.');
    return 3;
  }
}

function printSkillScaffoldingTip() {
  const count = countBundledSkills();
  console.log(`\nTip: Run "npx release-harness init --with-agents" to scaffold ${count ?? 'the bundled'} cognitive skills.`);
  console.log(`Use ${SKILL_NAMESPACE}project-cartographer and ${SKILL_NAMESPACE}scenario-compiler for artifact-first adoption.`);
  console.log('Preview capabilities without writing files: npx release-harness skills list');
}

/**
 * Number of skills in the shipped bundle, or null when the templates cannot be
 * read. Counted rather than hard-coded so the figure quoted to the operator
 * cannot drift away from what is actually installed.
 */
export function countBundledSkills() {
  try {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../templates/skills');
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return null;
  }
}

/**
 * Name and count any bundle skill already present at the destination, before a
 * single file is written. Listing the ambiguity is the point: the adopter who
 * hit this had 14 silent collisions, one of them a release-conductor with a
 * different pipeline contract.
 */
function reportSkillCollisions(destDir, tmplSkillsDir, label, force = false) {
  const collisions = detectCollisions(destDir, namespacedEntryNames(tmplSkillsDir, SKILL_NAMESPACE));
  if (collisions.length === 0) return collisions;
  const fate = force ? 'overwrite requested' : 'preserved; merge or update only the affected skill files';
  console.log(`  ! ${collisions.length} skill name(s) already present in ${label} — ${fate}:`);
  console.log('    Warning: --force/--overwrite resets project contracts as well as agent and skill files; it is not a targeted upgrade.');
  for (const c of collisions) console.log(`      ${c}`);
  return collisions;
}

function copyDirectoryRecursive(src, dest, force = false, dryRun = false, namespacePrefix = '') {
  if (!fs.existsSync(src)) return;
  if (!dryRun) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    if (entry.isDirectory()) {
      // Only the top level is namespaced; contents keep their own names.
      copyDirectoryRecursive(srcPath, path.join(dest, `${namespacePrefix}${entry.name}`), force, dryRun, '');
    } else {
      const destPath = path.join(dest, entry.name);
      if (fs.existsSync(destPath) && !force) {
        console.log(`  • Preserving existing: ${destPath}`);
      } else {
        if (!dryRun) fs.copyFileSync(srcPath, destPath);
        console.log(`  ✓ ${dryRun ? '[dry-run] Would write' : 'Wrote'}: ${destPath}`);
      }
    }
  }
}

async function handleDoctor(args) {
  if (args.length) {
    console.error('Error: doctor accepts no arguments. Use "release-harness skills list" to inspect skills.');
    return 3;
  }
  console.log(`Release-Harness v${HARNESS_VERSION} Diagnostics & Prerequisites\n`);
  const cwd = process.cwd();
  let allGood = true;

  // 1. Toolchain checks
  const toolchain = detectToolchain();
  console.log('Host Toolchain:');
  console.log(`  ✓ Node.js          : ${toolchain.node}`);

  if (toolchain.git) {
    console.log(`  ✓ Git              : ${toolchain.git}`);
  } else {
    console.warn('  ✗ Git              : not found in PATH');
    allGood = false;
  }

  if (toolchain.docker_engine) {
    console.log(`  ✓ Docker Engine    : ${toolchain.docker_engine}`);
  } else {
    console.warn('  ✗ Docker Engine    : Docker daemon not running or not in PATH');
  }

  if (toolchain.docker_compose) {
    console.log(`  ✓ Docker Compose   : ${toolchain.docker_compose}`);
  } else {
    console.warn('  ✗ Docker Compose   : not available');
  }

  if (toolchain.playwright) {
    console.log(`  ✓ Playwright CLI   : ${toolchain.playwright}`);
  } else {
    console.log('  • Playwright CLI   : optional (Playwright Node package used directly)');
  }

  // Check Playwright Chromium browser binary
  let chromiumAvailable = false;
  try {
    const candidateDirs = [
      path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
      path.join(os.homedir(), '.cache', 'ms-playwright'),
      process.env.PLAYWRIGHT_BROWSERS_PATH,
    ].filter(Boolean);

    for (const d of candidateDirs) {
      if (fs.existsSync(d)) {
        const entries = fs.readdirSync(d);
        if (entries.some((e) => e.startsWith('chromium'))) {
          chromiumAvailable = true;
          break;
        }
      }
    }
  } catch {
    // ignore inspection error
  }

  if (chromiumAvailable) {
    console.log('  ✓ Chromium Browser : installed in ms-playwright cache');
  } else {
    console.warn('  ! Chromium Browser : not detected in standard Playwright cache');
    console.warn('    Action: Run "npx playwright install chromium" if browser tests are needed');
  }

  // 2. Project-owned configuration discovery
  console.log('\nProject Contract Discovery:');
  const harnessDir = path.join(cwd, '.release-harness');
  const topologyFile = path.join(harnessDir, 'topology.json');
  const originsFile = path.join(harnessDir, 'origins.json');
  const scenariosDir = path.join(harnessDir, 'scenarios');

  if (fs.existsSync(topologyFile)) {
    try {
      const top = JSON.parse(fs.readFileSync(topologyFile, 'utf8'));
      validateTopology(top);
      console.log(`  ✓ topology.json    : valid (${top.product_slug}, ${top.topology_type})`);
    } catch (e) {
      console.warn(`  ✗ topology.json    : invalid (${e.message})`);
      allGood = false;
    }
  } else {
    console.warn(`  • topology.json    : absent at ${topologyFile}`);
  }

  if (fs.existsSync(originsFile)) {
    try {
      const origs = JSON.parse(fs.readFileSync(originsFile, 'utf8'));
      validateOrigins(origs);
      console.log(`  ✓ origins.json     : valid (${origs.length} origins declared)`);
    } catch (e) {
      console.warn(`  ✗ origins.json     : invalid (${e.message})`);
      allGood = false;
    }
  } else {
    console.warn(`  • origins.json     : absent at ${originsFile}`);
  }

  if (fs.existsSync(scenariosDir)) {
    const scFiles = fs.readdirSync(scenariosDir).filter((f) => f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml'));
    console.log(`  ✓ scenarios/       : ${scFiles.length} scenario file(s) discovered`);
  } else {
    console.warn(`  • scenarios/       : absent at ${scenariosDir}`);
  }

  console.log(`\nStatus: ${allGood ? 'Ready.' : 'Action items found (see above).'}`);
  printSkillScaffoldingTip();
  return allGood ? 0 : 1;
}

async function handleInit(args) {
  const { flags, unknown } = parseFlags(args, KNOWN_FLAGS.init);
  if (unknown.length > 0) {
    reportUnknownFlags(unknown);
    return 3;
  }
  const cwd = process.cwd();
  const dryRun = Boolean(flags['dry-run']);
  const force = Boolean(flags['force'] || flags['overwrite']);
  const withAgents = Boolean(flags['with-agents']);
  const contractsOnly = Boolean(flags['contracts-only']);

  if (withAgents && contractsOnly) {
    console.error('Error: --with-agents and --contracts-only are mutually exclusive.');
    console.error('Pass --with-agents to scaffold the agent bundle, or --contracts-only for contracts alone.');
    return 3;
  }

  const harnessDir = path.join(cwd, '.release-harness');
  const scenariosDir = path.join(harnessDir, 'scenarios');
  const fixturesDir = path.join(harnessDir, 'fixtures');

  console.log(`Scaffolding project-owned Release-Harness contracts${withAgents ? ' and multi-runtime AI agents' : ''}...`);
  if (dryRun) console.log('Notice: Dry-run enabled. No files will be written.\n');

  let pkgName;
  let existingConfig;
  const templatesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../templates');
  let agentTemplates;
  const adoptionAssets = {};
  try {
    // Preserve project identity even in a renamed directory or a partial scaffold.
    for (const name of ['harness.config.json', 'topology.json']) {
      const file = path.join(harnessDir, name);
      if (!fs.existsSync(file)) continue;
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (name === 'harness.config.json') existingConfig = existing;
      if (typeof existing?.product_slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(existing.product_slug)) {
        throw new Error(`${name} has an invalid product_slug; repair the existing contracts together before init`);
      }
      if (pkgName && pkgName !== existing.product_slug) {
        throw new Error('Existing harness.config.json and topology.json have conflicting product_slug values');
      }
      pkgName = existing.product_slug;
    }
    pkgName ??= path.basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!pkgName) throw new Error('Directory name cannot produce a non-empty alphanumeric product_slug');
    if (withAgents) {
      const { renderAgentTemplates } = await import('./agent-templates.js');
      agentTemplates = renderAgentTemplates(fs.readFileSync(path.join(templatesDir, 'agents', 'release-conductor.md'), 'utf8'));
      readBundledSkills(path.join(templatesDir, 'skills'));
      for (const asset of ['AI-ADOPTION.md', 'agents/AGENTS.md', 'agents/.cursorrules', 'agents/copilot-instructions.md']) {
        const file = path.join(templatesDir, asset);
        if (!fs.lstatSync(file).isFile()) throw new Error(`Required adoption asset ${asset} must be a regular file`);
        const content = fs.readFileSync(file, 'utf8');
        if (!content.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) {
          throw new Error(`Required adoption asset ${asset} must contain nonempty text without control characters`);
        }
        adoptionAssets[asset] = content;
      }
    }
  } catch (error) {
    console.error(`Error: Cannot initialize Release-Harness: ${error.message}`);
    return 3;
  }

  // 1. Write .release-harness contracts (Non-destructive by default)
  const writeFileSafe = (targetPath, content, label) => {
    if (fs.existsSync(targetPath) && !force) {
      console.log(`  • Preserving existing: ${label}`);
    } else {
      if (!dryRun) fs.writeFileSync(targetPath, content, 'utf8');
      console.log(`  ✓ ${dryRun ? '[dry-run] Would create' : 'Created'} ${label}`);
    }
  };

  const harnessConfig = {
    schema_version: '1.0.0',
    product_slug: pkgName,
    harness_version: HARNESS_VERSION,
    port_block: { start: 31000, range: 50 },
    timeouts: { health_check_seconds: 60, scenario_timeout_ms: 30000, run_timeout_seconds: 300 },
  };

  const topology = {
    $schema: 'https://json.xibo.dev/schemas/release-harness/topology-v1.json',
    schema_version: '1.0.0',
    product_slug: pkgName,
    topology_type: 'monorepo',
    network_policy: existingConfig?.network_policy ?? { mode: 'sealed', allowed_egress: [] },
    nodes: [
      {
        id: 'web',
        path: '.',
        type: 'browser_app',
        served_origin_id: 'web-app',
        health_probe: { type: 'http', host: '127.0.0.1', port: 3000, path: '/', expected_status: 200 },
      },
    ],
  };

  const origins = [
    {
      origin_id: 'web-app',
      type: 'browser_app',
      auth: 'session-cookie',
      url_source: 'env:APP_URL (default http://127.0.0.1:3000)',
      route_families: ['/'],
      safe_for_live: true,
      evidence: ['package.json'],
    },
  ];

  const smokeScenario = {
    id: 'SMOKE-001',
    name: 'Landing page availability',
    origin_id: 'web-app',
    tier: 'smoke',
    policy: 'required',
    steps: [
      { action: 'navigate', target: '/' },
      { action: 'assert', target: 'text:Welcome' },
    ],
  };
  try {
    const { validateAgainstSchema } = await import('./validator.js');
    const { Schemas } = await import('../../release-harness-schemas/index.js');
    for (const [schema, document, label] of [
      [Schemas.HarnessConfigV1, harnessConfig, 'Generated harness config'],
      [Schemas.TopologyV1, topology, 'Generated topology'],
      [Schemas.OriginsV1, origins, 'Generated origins'],
      [Schemas.ScenarioV1, smokeScenario, 'Generated smoke scenario'],
    ]) validateAgainstSchema(schema, document, label);
  } catch (error) {
    console.error(`Error: Cannot initialize Release-Harness: ${error.message}`);
    return 3;
  }
  if (!dryRun) {
    fs.mkdirSync(scenariosDir, { recursive: true });
    fs.mkdirSync(fixturesDir, { recursive: true });
  }
  writeFileSafe(path.join(harnessDir, 'harness.config.json'), JSON.stringify(harnessConfig, null, 2) + '\n', '.release-harness/harness.config.json');
  writeFileSafe(path.join(harnessDir, 'topology.json'), JSON.stringify(topology, null, 2) + '\n', '.release-harness/topology.json');
  writeFileSafe(path.join(harnessDir, 'origins.json'), JSON.stringify(origins, null, 2) + '\n', '.release-harness/origins.json');
  writeFileSafe(path.join(scenariosDir, 'smoke.json'), JSON.stringify(smokeScenario, null, 2) + '\n', '.release-harness/scenarios/smoke.json');

  const readmeContent = `# Release Harness Configuration

Project-owned test intent for **${pkgName}**:
- \`harness.config.json\`: Execution controls, timeouts, and port blocks.
- \`topology.json\`: Service graph, Docker Compose services, and health probes.
- \`origins.json\`: Served surface definitions (browser apps, APIs, workers).
- \`scenarios/\`: Declarative Playwright scenarios (smoke, core, full).

Run checks with:
\`\`\`bash
npx release-harness doctor
npx release-harness check-pr
npx release-harness run-local
\`\`\`
`;
  writeFileSafe(path.join(harnessDir, 'README.md'), readmeContent, '.release-harness/README.md');

  // 2. Multi-runtime agent scaffolding (explicit opt-in only).
  //
  // This previously also fired whenever the project had no AGENTS.md, which
  // made --with-agents a no-op for a bare init and, worse, left a project that
  // keeps its own AGENTS.md for unrelated reasons with no skills at all.
  // Whether a project has an AGENTS.md says nothing about whether it wants
  // this bundle, so the flag alone decides.
  if (withAgents) {
    const tmplSkillsDir = path.join(templatesDir, 'skills');

    // AGENTS.md & .cursorrules
    writeFileSafe(path.join(cwd, 'AGENTS.md'), adoptionAssets['agents/AGENTS.md'], 'AGENTS.md');
    writeFileSafe(path.join(cwd, '.cursorrules'), adoptionAssets['agents/.cursorrules'], '.cursorrules');

    // The adoption guide for the agent doing the integration. It states the
    // beats that are invisible from the outside -- chiefly that this bundle
    // ships with init rather than npm install, so an agent that looked for the
    // skills first and found nothing does not conclude they do not exist.
    writeFileSafe(path.join(cwd, 'AI-ADOPTION.md'), adoptionAssets['AI-ADOPTION.md'], 'AI-ADOPTION.md');

    // Claude Code: .claude/agents & .claude/skills
    const claudeAgentsDir = path.join(cwd, '.claude', 'agents');
    const claudeSkillsDir = path.join(cwd, '.claude', 'skills');
    if (!dryRun) {
      fs.mkdirSync(claudeAgentsDir, { recursive: true });
      fs.mkdirSync(claudeSkillsDir, { recursive: true });
    }
    writeFileSafe(path.join(claudeAgentsDir, 'release-conductor.md'), agentTemplates.claude, '.claude/agents/release-conductor.md');
    reportSkillCollisions(claudeSkillsDir, tmplSkillsDir, '.claude/skills', force);
    copyDirectoryRecursive(tmplSkillsDir, claudeSkillsDir, force, dryRun, SKILL_NAMESPACE);

    const sharedSkillsDir = path.join(cwd, '.agents', 'skills');
    if (!dryRun) fs.mkdirSync(sharedSkillsDir, { recursive: true });
    reportSkillCollisions(sharedSkillsDir, tmplSkillsDir, '.agents/skills', force);
    copyDirectoryRecursive(tmplSkillsDir, sharedSkillsDir, force, dryRun, SKILL_NAMESPACE);

    // opencode: .opencode/agents & .opencode/skills
    const opencodeAgentsDir = path.join(cwd, '.opencode', 'agents');
    const opencodeSkillsDir = path.join(cwd, '.opencode', 'skills');
    if (!dryRun) {
      fs.mkdirSync(opencodeAgentsDir, { recursive: true });
      fs.mkdirSync(opencodeSkillsDir, { recursive: true });
    }
    writeFileSafe(path.join(opencodeAgentsDir, 'release-conductor.md'), agentTemplates.opencode, '.opencode/agents/release-conductor.md');
    reportSkillCollisions(opencodeSkillsDir, tmplSkillsDir, '.opencode/skills', force);
    copyDirectoryRecursive(tmplSkillsDir, opencodeSkillsDir, force, dryRun, SKILL_NAMESPACE);

    // GitHub Copilot: .github/agents & .github/copilot-instructions.md
    const ghAgentsDir = path.join(cwd, '.github', 'agents');
    if (!dryRun) fs.mkdirSync(ghAgentsDir, { recursive: true });
    writeFileSafe(path.join(ghAgentsDir, 'release-conductor.agent.md'), agentTemplates.github, '.github/agents/release-conductor.agent.md');
    writeFileSafe(path.join(cwd, '.github', 'copilot-instructions.md'), adoptionAssets['agents/copilot-instructions.md'], '.github/copilot-instructions.md');

    // Copilot CLI: .copilot/agents
    const copilotAgentsDir = path.join(cwd, '.copilot', 'agents');
    if (!dryRun) fs.mkdirSync(copilotAgentsDir, { recursive: true });
    writeFileSafe(path.join(copilotAgentsDir, 'release-conductor.md'), agentTemplates.copilot, '.copilot/agents/release-conductor.md');
    if (!dryRun) console.log('\n  Restart or reload your AI host session to discover newly scaffolded agents and skills. Disk presence is not host registration; see AI-ADOPTION.md.');
  } else {
    // With the implicit trigger removed, the bundle would otherwise be
    // undiscoverable, so name the flag that produces it.
    printSkillScaffoldingTip();
  }

  console.log('\nInitialization complete. Run "npx release-harness doctor" to verify.');
  return 0;
}

async function handleCheckPr(args) {
  const flags = parseFlags(args);
  const cwd = process.cwd();
  console.log('=== Level 1: PR Integration Gate ===');

  const harnessDir = path.join(cwd, '.release-harness');
  const topologyFile = path.join(harnessDir, 'topology.json');
  const originsFile = path.join(harnessDir, 'origins.json');
  const configFile = path.join(harnessDir, 'harness.config.json');

  if (!fs.existsSync(topologyFile)) {
    console.error(`Error: Missing topology contract at ${topologyFile}`);
    return 1;
  }

  try {
    const topology = JSON.parse(fs.readFileSync(topologyFile, 'utf8'));
    validateTopology(topology);
    console.log(`✓ Topology valid (${topology.product_slug}, ${topology.topology_type})`);

    if (fs.existsSync(originsFile)) {
      const origins = JSON.parse(fs.readFileSync(originsFile, 'utf8'));
      validateOrigins(origins);
      console.log(`✓ Origins contract valid (${origins.length} origins defined)`);
    }

    const toolchain = detectToolchain();
    console.log('✓ Toolchain detected:');
    console.log(`    Node: ${toolchain.node}`);
    console.log(`    Git: ${toolchain.git || 'absent'}`);
    console.log(`    Docker: ${toolchain.docker_engine || 'absent'}`);

    const materializer = new SourceMaterializer(path.join(os.tmpdir(), 'harness-check-pr'));

    if (topology.topology_type === 'multi_repo') {
      console.log('\n--- Multi-Repo Project Graph Resolution ---');
      const graphRes = materializer.resolveMultiRepoGraph(topology, cwd);
      console.log(`Project Graph Digest: ${graphRes.graph_digest.slice(0, 16)}...`);

      if (!graphRes.ok) {
        for (const err of graphRes.errors) {
          console.error(`    ✗ ${err}`);
        }
        console.error('\nLevel 1 Gate: FAILED (Multi-repo graph validation failed)');
        return 1;
      }

      let isAnyDirty = false;
      for (const node of graphRes.nodes) {
        console.log(`  • [${node.repo_id}] SHA: ${node.commit_sha.slice(0, 12)} (${node.is_clean ? 'clean' : 'dirty'})`);
        if (!node.is_clean) {
          isAnyDirty = true;
        }
      }

      if (isAnyDirty) {
        if (flags['allow-dirty']) {
          console.log('\nLevel 1 Gate: UNPROVEN (NON-CERTIFYING DEVELOPMENT MODE: dirty working tree)');
          return 2;
        } else {
          console.error('\nLevel 1 Gate: FAILED (Dirty working tree rejected in certification mode. Commit changes or pass --allow-dirty for dev mode)');
          return 1;
        }
      }
    } else {
      const sourceInfo = materializer.getSourceInfo(cwd);
      console.log(`✓ Source Git SHA: ${sourceInfo.commitSha} (${sourceInfo.isClean ? 'clean' : 'dirty'})`);

      if (!sourceInfo.isClean) {
        if (flags['allow-dirty']) {
          console.log('\nLevel 1 Gate: UNPROVEN (NON-CERTIFYING DEVELOPMENT MODE: dirty working tree)');
          return 2;
        } else {
          console.error('\nLevel 1 Gate: FAILED (Dirty working tree rejected in certification mode. Commit changes or pass --allow-dirty for dev mode)');
          return 1;
        }
      }
    }

    // 4. Load and validate the harness config, then execute its configured PR Gate
    //    commands (e.g. lint, typecheck, unit tests). An unreadable or contract-
    //    violating config is a harness configuration error (exit 3), not a silent
    //    skip: pr_gate.commands are the checks this gate exists to run, so warning
    //    and continuing would report PASS for a gate that never executed.
    if (fs.existsSync(configFile)) {
      let config;
      try {
        config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        validateHarnessConfig(config);
      } catch (configErr) {
        console.error(`  ✗ Invalid harness.config.json: ${configErr.message}`);
        if (configErr instanceof ValidationError) {
          for (const detail of configErr.errors || []) {
            console.error(`      - ${detail}`);
          }
        }
        console.error('\nLevel 1 Gate: FAILED (Harness configuration error)');
        return 3;
      }
      console.log(`✓ Harness config valid (${config.product_slug})`);

      {
        const prCommands = config.pr_gate?.commands || [];

        if (prCommands.length > 0) {
          console.log(`\n--- Executing ${prCommands.length} Configured PR Gate Command(s) ---`);
          for (const cmdSpec of prCommands) {
            const cmdId = cmdSpec.id || cmdSpec.name || cmdSpec.cmd;
            const cmdStr = cmdSpec.cmd;
            const timeoutSec = cmdSpec.timeout_seconds || 120;
            const expectedExit = cmdSpec.expected_exit_code !== undefined ? cmdSpec.expected_exit_code : 0;

            console.log(`  ▶ [${cmdId}] Running: "${cmdStr}" (Timeout: ${timeoutSec}s)...`);
            const start = Date.now();
            try {
              execSync(cmdStr, {
                cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: timeoutSec * 1000,
                encoding: 'utf8',
              });
              console.log(`    ✓ [${cmdId}] Passed in ${Date.now() - start}ms`);
            } catch (cmdErr) {
              const actualExit = cmdErr.status !== undefined ? cmdErr.status : 1;
              if (actualExit !== expectedExit) {
                console.error(`    ✗ [${cmdId}] Failed with exit code ${actualExit} (Expected: ${expectedExit})`);
                if (cmdErr.stderr) console.error(`    Error Output:\n${cmdErr.stderr.slice(0, 500)}`);
                console.error(`\nLevel 1 Gate: FAILED (Command "${cmdId}" failed)`);
                return 1;
              }
            }
          }
        }
      }
    }

    console.log('\nLevel 1 Gate: PASS');
    return 0;
  } catch (err) {
    console.error(`Level 1 Gate Failed: ${err.message}`);
    return 1;
  }
}

async function handleRunLocal(args) {
  const { resolveNetworkPolicy, validateHealthProbe } = await import('./validator.js');
  /**
   * Report what materialization actually did. Every diagnostic the enumerator
   * and the copier produce reached no operator before this: `.stats` was
   * discarded at the call site, so an enumeration that silently fell back to the
   * basename denylist, or a file skipped mid-copy, looked exactly like a clean
   * run. A degradation nobody can see is not a warning.
   */
  function reportMaterialization(label, res) {
    const s = res.stats;
    console.log(
      `   ${label}: ${s.fileCount} file(s), ${s.byteCount} byte(s), ` +
        `${s.emptyDirCount} empty dir(s) in ${s.elapsedMs}ms (${s.strategy} enumeration)`
    );
    if (s.skippedCount > 0) {
      console.warn(
        `   ! ${s.skippedCount} enumerated path(s) were NOT materialized; ` +
          `the tree digest covers ${s.enumeratedCount} path(s) but the workspace holds ${s.fileCount}.`
      );
    }
    for (const warn of s.warnings) console.warn(`   ! ${warn}`);
  }

  const { flags, unknown } = parseFlags(args, KNOWN_FLAGS['run-local']);
  if (unknown.length > 0) {
    reportUnknownFlags(unknown);
    return 3;
  }
  const cwd = process.cwd();
  const runStartedAt = new Date().toISOString();
  const runId = flags['run-id'] || `run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  // A bare `--port-offset` parses to `true`, and any non-numeric value to NaN.
  // Either would reach the compose environment as the string "NaN" and shift
  // every health-check and probe port to NaN, so refuse it here rather than
  // running against ports that cannot exist.
  const portOffset = parseInt(flags['port-offset'] || '0', 10);
  if (!Number.isFinite(portOffset)) {
    console.error(`Error: --port-offset requires an integer value (got ${JSON.stringify(flags['port-offset'])}).`);
    return 3;
  }
  const harnessDir = path.join(cwd, '.release-harness');
  const topologyFile = path.join(harnessDir, 'topology.json');
  const originsFile = path.join(harnessDir, 'origins.json');
  const scenariosDir = path.join(harnessDir, 'scenarios');

  console.log(`=== Level 2: Local Release UAT Gate [Run: ${runId}] ===`);

  if (!fs.existsSync(topologyFile)) {
    console.error(`Missing topology contract at ${topologyFile}`);
    return 3;
  }

  // Both contracts are validated before anything is materialized, because both
  // steer the run: `topology_type` decides whether the product is certified as a
  // graph or as a single repo, and `harness.config.json` is hashed into the
  // provenance record. Validating only at Level 1 left Level 2 — the gate that
  // actually certifies — trusting fields no schema had checked, so a typo'd
  // `topology_type` silently took the single-repo branch and a contract error
  // surfaced as a product failure (exit 1) rather than a configuration one.
  const configFile = path.join(harnessDir, 'harness.config.json');
  let topology;
  try {
    topology = JSON.parse(fs.readFileSync(topologyFile, 'utf8'));
    validateTopology(topology);
  } catch (topologyErr) {
    console.error(`Invalid topology.json: ${topologyErr.message}`);
    if (topologyErr instanceof ValidationError) {
      for (const detail of topologyErr.errors || []) {
        console.error(`      - ${detail}`);
      }
    }
    console.error('\nLevel 2 Gate: FAILED (Harness configuration error)');
    return 3;
  }

  let harnessConfig = {};
  if (fs.existsSync(configFile)) {
    try {
      harnessConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      validateHarnessConfig(harnessConfig);
    } catch (configErr) {
      console.error(`Invalid harness.config.json: ${configErr.message}`);
      if (configErr instanceof ValidationError) {
        for (const detail of configErr.errors || []) {
          console.error(`      - ${detail}`);
        }
      }
      console.error('\nLevel 2 Gate: FAILED (Harness configuration error)');
      return 3;
    }
  }

  let effectiveNetworkPolicy;
  const services = [...(topology.nodes || []), ...(topology.repositories || []).flatMap((r) => r.services || [])];
  try {
    effectiveNetworkPolicy = resolveNetworkPolicy(topology, harnessConfig);
    for (const service of services) if (service.health_probe) validateHealthProbe(service.health_probe, portOffset);
  } catch (err) {
    console.error(`Harness configuration error: ${err.message}`);
    return 3;
  }
  if (!effectiveNetworkPolicy) console.warn('Warning: no network_policy declared; preserving legacy open network behavior. Declare topology.network_policy to enforce egress restrictions.');
  else if (!topology.network_policy) console.warn('Warning: using legacy harness.config.json network_policy; topology.json is the canonical location.');

  const productSlug = topology.product_slug || 'project';
  const evidenceRoot = resolveEvidenceRoot(flags, productSlug);
  const runDir = path.join(evidenceRoot, 'runs', runId);
  const runEvidenceDir = path.join(runDir, 'evidence');
  const workspaceDir = path.join(evidenceRoot, 'workspaces', runId);

  fs.mkdirSync(runEvidenceDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const sealer = new EvidenceSealer(runEvidenceDir, runId);
  const redactor = new SecretRedactor();
  const materializer = new SourceMaterializer(workspaceDir);

  let composeRunner = null;
  const rawResults = [];
  let sourceInfo = null;
  let artifacts = [];

  try {
    // 1. Materialize detached source
    console.log('1. Materializing detached source workspace...');

    // A certification run must exclude untracked-but-not-ignored files, or
    // leftover build and test output (test-results/, playwright-report/) enters
    // both the workspace copy and the tree digest, making provenance a function
    // of the last test run. An --allow-dirty development run is the opposite
    // case: the workspace must mirror what is actually on disk.
    const includeUntracked = Boolean(flags['allow-dirty']);

    let workSourceDir;
    let sourceInfos = [];

    if (topology.topology_type === 'multi_repo') {
      // Level 1 binds a multi-repo product per repository. Materializing only
      // `cwd` here certified whichever repository the operator happened to be
      // standing in while the manifest claimed the whole graph.
      const graphRes = materializer.materializeGraph(topology, cwd, { includeUntracked });
      if (!graphRes.ok) {
        for (const e of graphRes.errors) console.error(`   ✗ ${e}`);
        console.error('   ✗ Multi-repo product graph could not be resolved; nothing was materialized.');
        return 3;
      }
      sourceInfos = graphRes.workspaces.map((w) => ({ repo_id: w.repo_id, ...w.sourceInfo }));
      workSourceDir = path.join(workspaceDir, 'sources');
      console.log(
        `   Graph digest: ${graphRes.graphDigest.slice(0, 16)}… (${graphRes.workspaces.length} repositories)`
      );
      for (const w of graphRes.workspaces) {
        const info = w.sourceInfo;
        const state = info.statusResolved ? (info.isClean ? 'clean' : 'dirty') : 'status unresolved';
        console.log(`   ${w.repo_id}: ${info.commitSha} (${state})`);
        reportMaterialization(w.repo_id, w);
      }
    } else {
      const matResult = materializer.materializeRepo(cwd, 'source', { includeUntracked });
      sourceInfos = [matResult.sourceInfo];
      workSourceDir = matResult.targetDir;
      const state = matResult.sourceInfo.statusResolved
        ? (matResult.sourceInfo.isClean ? 'clean' : 'dirty')
        : 'status unresolved';
      console.log(`   Source SHA: ${matResult.sourceInfo.commitSha} (${state})`);
      reportMaterialization('Materialized', matResult);
    }

    sourceInfo = sourceInfos[0];

    // The gate applies across EVERY repository: one dirty repo in a graph is a
    // dirty product. `isClean` is false whenever status could not be resolved,
    // so an unresolvable status is refused rather than certified.
    const dirtySources = sourceInfos.filter((s) => !s.isClean);
    const isDevelopmentMode = dirtySources.length > 0 && Boolean(flags['allow-dirty']);
    const runtime = {
      schema_version: '1.0.0', started_at: runStartedAt,
      execution_mode: isDevelopmentMode ? 'DEVELOPMENT' : 'CERTIFICATION',
      startup: { phase: 'not_applicable', blocked: false, health: [] },
    };
    if (dirtySources.length > 0 && !flags['allow-dirty']) {
      for (const s of dirtySources) {
        const which = s.repo_id ? `repository "${s.repo_id}"` : 'source';
        const why = s.statusResolved ? 'working tree is dirty' : 'git status could not be resolved';
        console.error(`   ✗ Dirty source rejected for certification gate: ${which} (${why}).`);
      }
      return 1;
    }

    // 2. Load and validate scenarios (FAIL CLOSED on malformed file)
    const scenarios = [];
    if (fs.existsSync(scenariosDir)) {
      for (const file of fs.readdirSync(scenariosDir)) {
        if (file.endsWith('.json') || file.endsWith('.yaml') || file.endsWith('.yml')) {
          try {
            const sc = parseScenarioFile(path.join(scenariosDir, file));
            scenarios.push(sc);
          } catch (e) {
            console.error(`   ✗ Fatal: Malformed scenario in ${file}: ${e.message}`);
            return 3;
          }
        }
      }
    }
    console.log(`2. Loaded ${scenarios.length} declarative scenario(s)`);

    // 3. Load origins
    let origins = [];
    if (fs.existsSync(originsFile)) {
      origins = JSON.parse(fs.readFileSync(originsFile, 'utf8'));
      validateOrigins(origins);
    }

    // 4. Docker Compose Setup (Fixed Compose selection)
    const testCompose = path.join(workSourceDir, 'docker-compose.test.yml');
    const normalCompose = path.join(workSourceDir, 'docker-compose.yml');
    const composeFile = fs.existsSync(testCompose) ? testCompose : (fs.existsSync(normalCompose) ? normalCompose : null);

    if (composeFile) {
      console.log(`3. Standing up isolated Docker Compose stack (${path.basename(composeFile)})...`);
      composeRunner = new DockerComposeRunner({
        composeFile,
        runId,
        workingDir: workSourceDir,
        portOffset,
      });

      try {
        runtime.startup.phase = 'compose_up';
        const upRes = await composeRunner.up();
        artifacts = upRes.artifacts;
        console.log(`   Containers started (Captured ${artifacts.length} OCI artifact digests)`);
        runtime.startup.phase = 'health';
        runtime.startup.health = await composeRunner.healthCheckServices(services, harnessConfig.timeouts?.health_check_seconds ?? 60);
        runtime.startup.blocked = runtime.startup.health.some((h) => !h.healthy);
        if (!runtime.startup.blocked) runtime.startup.phase = 'ready';
      } catch (err) {
        runtime.startup.blocked = true;
        runtime.startup.error = { kind: err instanceof ValidationError ? 'configuration' : 'runtime', code: ['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT'].includes(err.code) ? err.code : null, exit_code: Number.isInteger(err.exit_code) ? err.exit_code : null, message: 'Startup failed; arbitrary process output omitted from evidence' };
      }
      if (runtime.startup.blocked) {
        try { runtime.startup.diagnostics = composeRunner.collectDiagnostics(); }
        catch { runtime.startup.diagnostics = { containers: [], errors: ['CONTAINER_DIAGNOSTICS_UNAVAILABLE'], logs_omitted: true }; }
        delete runtime.startup.diagnostics.logs;
        delete runtime.startup.diagnostics.logs_truncated;
        runtime.startup.diagnostics.logs_omitted = true;
        console.error('Startup/readiness failed. Capturing evidence before cleanup; scenarios will not execute.');
      }
    }

    // 5. Execute Scenarios with Topology/Origin-driven routing & network monitoring
    console.log(runtime.startup.blocked ? '5. Scenario execution blocked by startup failure.' : '5. Executing declarative scenarios with Playwright & origin routing...');
    const scenarioRunner = new ScenarioRunner({
      origins,
      topology,
      networkPolicy: effectiveNetworkPolicy,
      evidenceDir: runEvidenceDir,
      workspaceDir: workSourceDir,
      portOffset,
    });

    for (const sc of runtime.startup.blocked ? [] : scenarios) {
      const res = await scenarioRunner.runScenario(sc);
      rawResults.push(res);

      const mark = res.failed ? '✗' : '✓';
      console.log(`   ${mark} [${sc.id}] ${sc.name} → ${res.target_base_url} (${res.duration_ms}ms)`);
    }

    // Write execution logs into evidence directory (Redacted prior to sealing)
    const logContent = redactor.redactText(`Run ${runId}: ${runtime.startup.blocked ? 'startup blocked scenario execution' : 'completed scenario sweep'}; started at ${runStartedAt}\n`);
    sealer.writeEvidence('execution.log', logContent);

    // Persist complete raw results into evidence directory before sealing
    const rawResultsBytes = JSON.stringify(redactor.redactObject(rawResults), null, 2) + '\n';
    sealer.writeEvidence('raw-results.json', rawResultsBytes);
    sealer.writeEvidence('runtime-observations.json', JSON.stringify(redactor.redactObject(runtime), null, 2) + '\n');

    // 6. Seal Evidence with Policy Snapshot for deterministic replay
    console.log('6. Sealing evidence directory...');
    const policySnapshot = {
      schema_version: '1.0.0',
      product_slug: productSlug,
      topology,
      origins,
      scenarios,
      network_policy: effectiveNetworkPolicy,
      runtime_observations_version: '1.0.0',
      waivers: [],
    };
    const waiversFile = path.join(harnessDir, 'waivers.json');
    if (fs.existsSync(waiversFile)) {
      try {
        const parsedWaivers = JSON.parse(fs.readFileSync(waiversFile, 'utf8'));
        policySnapshot.waivers = parsedWaivers.waivers || parsedWaivers;
      } catch {}
    }

    const sealRes = sealer.sealEvidence(policySnapshot);
    console.log(`   Evidence sealed (Manifest SHA: ${sealRes.manifestSha256.slice(0, 12)}...)`);

    // 7. Deterministic Adjudication
    console.log('7. Evaluating gate verdict...');
    const verdict = evaluateRun({
      runId,
      evidenceDir: runEvidenceDir,
      evaluationTime: flags.time || sealRes.manifest.sealed_at,
    });

    const verdictPath = path.join(runDir, 'verdict.json');
    const verdictBytes = JSON.stringify(verdict, null, 2) + '\n';
    fs.writeFileSync(verdictPath, verdictBytes, 'utf8');
    const verdictSha = crypto.createHash('sha256').update(verdictBytes).digest('hex');

    // Write run.manifest.json binding single runStartedAt and exact verdict bytes hash
    const runManifest = {
      schema_version: '1.0.0',
      run_id: runId,
      product_slug: productSlug,
      topology_type: topology.topology_type,
      started_at: runStartedAt,
      harness_core_version: HARNESS_VERSION,
      execution_mode: isDevelopmentMode ? 'DEVELOPMENT' : 'CERTIFICATION',
      certification_eligible: !isDevelopmentMode,
      // One entry per DECLARED repository. A multi_repo product previously
      // recorded a single entry, so the manifest asserted a graph while binding
      // one tree. `repo_id` is omitted rather than nulled for a single-repo run:
      // the schema types it as a string, and an absent field says "not part of a
      // graph" more honestly than a null does.
      sources: sourceInfos.map((s) => ({
        ...(s.repo_id ? { repo_id: s.repo_id } : {}),
        commit_sha: s.commitSha,
        is_clean: s.isClean,
        status_resolved: s.statusResolved,
        dirty_files: s.dirtyFiles,
        tree_digest: s.treeDigest,
      })),
      artifacts,
      toolchain: detectToolchain(),
      config_hashes: {
        harness_config_sha256: crypto.createHash('sha256').update(fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '{}').digest('hex'),
        topology_sha256: crypto.createHash('sha256').update(fs.readFileSync(topologyFile, 'utf8')).digest('hex'),
        scenarios_manifest_sha256: crypto.createHash('sha256').update(JSON.stringify(scenarios)).digest('hex'),
      },
      evidence_manifest_sha256: sealRes.manifestSha256,
      verdict_sha256: verdictSha,
    };
    fs.writeFileSync(path.join(runDir, 'run.manifest.json'), JSON.stringify(runManifest, null, 2) + '\n', 'utf8');

    console.log(`\n=== Verdict: ${verdict.certification_status} (Integrity: ${verdict.run_integrity}, Exit: ${verdict.exit_code}) ===`);
    console.log(`Summary: Passed: ${verdict.summary.passed}, Failed: ${verdict.summary.failed}, Unproven: ${verdict.summary.unproven}, Skipped: ${verdict.summary.skipped}`);

    return verdict.exit_code;
  } catch (err) {
    console.error(`Run Local failed with runtime error; no complete sealed verdict is guaranteed: ${redactor.redactText(err.message)}`);
    return 3;
  } finally {
    let cleaned = true;
    if (composeRunner) {
      console.log('Cleaning up Docker Compose containers...');
      cleaned = composeRunner.teardown();
    }
    if (cleaned !== false) {
      try { materializer.cleanup(); }
      catch (err) { console.error(`Workspace cleanup warning: ${redactor.redactText(err.message)}`); }
    } else {
      console.error(`Workspace retained at ${workspaceDir}: Compose cleanup failed; retry scoped cleanup before removing it.`);
    }
  }
}

async function handleEvaluate(args) {
  const flags = parseFlags(args);
  const evidenceDir = flags['evidence-dir'];
  if (!evidenceDir) {
    console.error('Error: --evidence-dir is required for evaluate command');
    return 3;
  }

  try {
    const verdict = evaluateRun({
      runId: flags['run-id'] || 'eval-run',
      evidenceDir: path.resolve(evidenceDir),
      evaluationTime: flags.time || new Date().toISOString(),
    });

    console.log(JSON.stringify(verdict, null, 2));
    return verdict.exit_code;
  } catch (err) {
    console.error(`Evaluation failed: ${err.message}`);
    return 4;
  }
}

async function handleClean(args) {
  const flags = parseFlags(args);
  const targetRunId = flags['run-id'];
  console.log(`Cleaning up release-harness resources${targetRunId ? ` for run: ${targetRunId}` : ''}...`);

  const baseCache = process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const rootBase = flags['evidence-dir'] ? path.resolve(flags['evidence-dir']) : path.join(baseCache, 'release-harness');

  if (targetRunId) {
    // Delete specifically this run's workspace
    const directWs = path.join(rootBase, 'workspaces', targetRunId);
    if (fs.existsSync(directWs)) {
      fs.rmSync(directWs, { recursive: true, force: true });
      console.log(`✓ Deleted workspace for run ${targetRunId}`);
    } else if (fs.existsSync(rootBase)) {
      // Check subdirectories
      for (const p of fs.readdirSync(rootBase)) {
        const subWs = path.join(rootBase, p, 'workspaces', targetRunId);
        if (fs.existsSync(subWs)) {
          fs.rmSync(subWs, { recursive: true, force: true });
          console.log(`✓ Deleted workspace for run ${targetRunId}`);
        }
      }
    }
  } else {
    console.log('Cleaned ephemeral run workspaces');
  }

  // Scoped Docker Container Cleanup by run-id label
  try {
    const labelFilter = targetRunId ? `label=com.xibodev.release-harness.run-id=${targetRunId}` : 'label=com.xibodev.release-harness=true';
    const psOut = execSync(`docker ps -a --filter ${labelFilter} --format {{.ID}}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    if (psOut) {
      const ids = psOut.split('\n').map((s) => s.trim()).filter(Boolean);
      console.log(`Removing ${ids.length} lingering scoped test container(s)...`);
      execSync(`docker rm -f ${ids.join(' ')}`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      console.log('✓ Scoped test containers removed');
    }
  } catch {
    // Docker not available or timed out
  }

  console.log('Clean complete.');
  return 0;
}
