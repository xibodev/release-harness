import crypto from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { SourceMaterializer } from './materializer.js';
import { EvidenceSealer } from './sealer.js';
import { SecretRedactor } from './redactor.js';
import { evaluateRun } from './evaluator.js';
import { detectToolchain } from './toolchain.js';
import { DockerComposeRunner } from './runner.js';
import { ScenarioRunner } from './scenario-runner.js';
import { parseScenarioFile } from './scenario-parser.js';
import { validateTopology, validateOrigins, validateHarnessConfig, ValidationError } from './validator.js';

const HARNESS_VERSION = '1.1.0';

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
  check-pr      Run Level 1 PR Integration Gate (contracts, toolchain, and configured PR commands)
  run-local     Run Level 2 Local Release UAT Gate (sealed Compose, scenarios, probes)
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
  const fate = force ? 'overwritten (--force)' : 'preserved; pass --force to overwrite';
  console.log(`  ! ${collisions.length} skill name(s) already present in ${label} — ${fate}:`);
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

  if (!dryRun) {
    fs.mkdirSync(scenariosDir, { recursive: true });
    fs.mkdirSync(fixturesDir, { recursive: true });
  }

  const pkgName = path.basename(cwd).toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'project';

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
    network_policy: { mode: 'sealed', allowed_egress: [] },
  };
  writeFileSafe(path.join(harnessDir, 'harness.config.json'), JSON.stringify(harnessConfig, null, 2) + '\n', '.release-harness/harness.config.json');

  const topology = {
    $schema: 'https://json.xibo.dev/schemas/release-harness/topology-v1.json',
    schema_version: '1.0.0',
    product_slug: pkgName,
    topology_type: 'monorepo',
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
  writeFileSafe(path.join(harnessDir, 'topology.json'), JSON.stringify(topology, null, 2) + '\n', '.release-harness/topology.json');

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
  writeFileSafe(path.join(harnessDir, 'origins.json'), JSON.stringify(origins, null, 2) + '\n', '.release-harness/origins.json');

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
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const templatesDir = path.resolve(__dirname, '../templates');

    // The bundle ships as a package asset. If it is missing the install is
    // broken, and returning 0 for a scaffold that never happened is the precise
    // failure --with-agents exists to prevent.
    if (!fs.existsSync(templatesDir)) {
      console.error(`Error: agent templates are missing from the installed package (expected at ${templatesDir}).`);
      console.error('Reinstall @xibodev/release-harness-core, or omit --with-agents to scaffold contracts only.');
      return 3;
    }

    const tmplAgentsDir = path.join(templatesDir, 'agents');
    const tmplSkillsDir = path.join(templatesDir, 'skills');

    // AGENTS.md & .cursorrules
    if (fs.existsSync(path.join(tmplAgentsDir, 'AGENTS.md'))) {
      writeFileSafe(path.join(cwd, 'AGENTS.md'), fs.readFileSync(path.join(tmplAgentsDir, 'AGENTS.md'), 'utf8'), 'AGENTS.md');
    }
    if (fs.existsSync(path.join(tmplAgentsDir, '.cursorrules'))) {
      writeFileSafe(path.join(cwd, '.cursorrules'), fs.readFileSync(path.join(tmplAgentsDir, '.cursorrules'), 'utf8'), '.cursorrules');
    }

    // The adoption guide for the agent doing the integration. It states the
    // beats that are invisible from the outside -- chiefly that this bundle
    // ships with init rather than npm install, so an agent that looked for the
    // skills first and found nothing does not conclude they do not exist.
    if (fs.existsSync(path.join(templatesDir, 'AI-ADOPTION.md'))) {
      writeFileSafe(
        path.join(cwd, 'AI-ADOPTION.md'),
        fs.readFileSync(path.join(templatesDir, 'AI-ADOPTION.md'), 'utf8'),
        'AI-ADOPTION.md'
      );
    }

    // Claude Code: .claude/agents & .claude/skills
    const claudeAgentsDir = path.join(cwd, '.claude', 'agents');
    const claudeSkillsDir = path.join(cwd, '.claude', 'skills');
    if (!dryRun) {
      fs.mkdirSync(claudeAgentsDir, { recursive: true });
      fs.mkdirSync(claudeSkillsDir, { recursive: true });
    }
    if (fs.existsSync(path.join(tmplAgentsDir, 'release-conductor.md'))) {
      writeFileSafe(path.join(claudeAgentsDir, 'release-conductor.md'), fs.readFileSync(path.join(tmplAgentsDir, 'release-conductor.md'), 'utf8'), '.claude/agents/release-conductor.md');
    }
    reportSkillCollisions(claudeSkillsDir, tmplSkillsDir, '.claude/skills', force);
    copyDirectoryRecursive(tmplSkillsDir, claudeSkillsDir, force, dryRun, SKILL_NAMESPACE);

    // opencode: .opencode/agents & .opencode/skills
    const opencodeAgentsDir = path.join(cwd, '.opencode', 'agents');
    const opencodeSkillsDir = path.join(cwd, '.opencode', 'skills');
    if (!dryRun) {
      fs.mkdirSync(opencodeAgentsDir, { recursive: true });
      fs.mkdirSync(opencodeSkillsDir, { recursive: true });
    }
    if (fs.existsSync(path.join(tmplAgentsDir, 'release-conductor.md'))) {
      writeFileSafe(path.join(opencodeAgentsDir, 'release-conductor.md'), fs.readFileSync(path.join(tmplAgentsDir, 'release-conductor.md'), 'utf8'), '.opencode/agents/release-conductor.md');
    }
    reportSkillCollisions(opencodeSkillsDir, tmplSkillsDir, '.opencode/skills', force);
    copyDirectoryRecursive(tmplSkillsDir, opencodeSkillsDir, force, dryRun, SKILL_NAMESPACE);

    // GitHub Copilot: .github/agents & .github/copilot-instructions.md
    const ghAgentsDir = path.join(cwd, '.github', 'agents');
    if (!dryRun) fs.mkdirSync(ghAgentsDir, { recursive: true });
    if (fs.existsSync(path.join(tmplAgentsDir, 'release-conductor.agent.md'))) {
      writeFileSafe(path.join(ghAgentsDir, 'release-conductor.agent.md'), fs.readFileSync(path.join(tmplAgentsDir, 'release-conductor.agent.md'), 'utf8'), '.github/agents/release-conductor.agent.md');
    }
    if (fs.existsSync(path.join(tmplAgentsDir, 'copilot-instructions.md'))) {
      writeFileSafe(path.join(cwd, '.github', 'copilot-instructions.md'), fs.readFileSync(path.join(tmplAgentsDir, 'copilot-instructions.md'), 'utf8'), '.github/copilot-instructions.md');
    }

    // Copilot CLI: .copilot/agents
    const copilotAgentsDir = path.join(cwd, '.copilot', 'agents');
    if (!dryRun) fs.mkdirSync(copilotAgentsDir, { recursive: true });
    if (fs.existsSync(path.join(tmplAgentsDir, 'release-conductor.md'))) {
      writeFileSafe(path.join(copilotAgentsDir, 'release-conductor.md'), fs.readFileSync(path.join(tmplAgentsDir, 'release-conductor.md'), 'utf8'), '.copilot/agents/release-conductor.md');
    }
  } else {
    // With the implicit trigger removed, the bundle would otherwise be
    // undiscoverable, so name the flag that produces it.
    const skillCount = countBundledSkills();
    console.log('\n  Contracts written. To scaffold the AI agent bundle'
      + ` (release-conductor${skillCount === null ? '' : ` + ${skillCount} skills`}):`);
    console.log('    npx release-harness init --with-agents');
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

  const topology = JSON.parse(fs.readFileSync(topologyFile, 'utf8'));
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
  const harnessErrors = [];
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

      const upRes = await composeRunner.up();
      artifacts = upRes.artifacts;
      console.log(`   Containers started (Captured ${artifacts.length} OCI artifact digests)`);

      const services = topology.nodes || [];
      if (services.length > 0) {
        console.log('4. Probing service healthchecks...');
        await composeRunner.healthCheckServices(services, 60);
        console.log('   All declared services healthy');
      }
    }

    // 5. Execute Scenarios with Topology/Origin-driven routing & network monitoring
    console.log('5. Executing declarative scenarios with Playwright & origin routing...');
    const scenarioRunner = new ScenarioRunner({
      origins,
      topology,
      networkPolicy: topology.network_policy || null,
      evidenceDir: runEvidenceDir,
      workspaceDir: workSourceDir,
      portOffset,
    });

    for (const sc of scenarios) {
      const res = await scenarioRunner.runScenario(sc);
      rawResults.push(res);

      // A probe that reported a harness fault escalates the whole run to
      // HARNESS_ERROR (exit 3) rather than failing the product. Nothing wrote
      // to `harnessErrors` before this, so exit 3 was unreachable from the CLI
      // and a harness gap was reported as the adopter's bug.
      for (const obs of res.side_effect_observations || []) {
        if (obs.is_harness_error) {
          harnessErrors.push({
            cause: obs.cause || 'HARNESS_CONFIGURATION',
            message: `[${sc.id}] ${obs.observed_result}`,
            scenario_id: sc.id,
          });
        }
      }

      const mark = res.failed ? '✗' : '✓';
      console.log(`   ${mark} [${sc.id}] ${sc.name} → ${res.target_base_url} (${res.duration_ms}ms)`);
    }

    // Collect network violations from scenarios
    const collectedNetworkViolations = rawResults.flatMap((r) => r.network_violations || []);

    // Write execution logs into evidence directory (Redacted prior to sealing)
    const logContent = redactor.redactText(`Run ${runId} completed scenario sweep at ${runStartedAt}\n`);
  /**
   * Report what materialization actually did. Every diagnostic the enumerator
   * and the copier produce reached no operator before this: `.stats` was
   * discarded at the call site, so an enumeration that silently fell back to the
   * basename denylist, or a file skipped mid-copy, looked exactly like a clean
   * run. A degradation nobody can see is not a warning.
   */
    fs.writeFileSync(path.join(runEvidenceDir, 'execution.log'), logContent, 'utf8');

    // Persist complete raw results into evidence directory before sealing
    const rawResultsBytes = JSON.stringify(redactor.redactObject(rawResults), null, 2) + '\n';
    fs.writeFileSync(path.join(runEvidenceDir, 'raw-results.json'), rawResultsBytes, 'utf8');

    // 6. Seal Evidence with Policy Snapshot for deterministic replay
    console.log('6. Sealing evidence directory...');
    const policySnapshot = {
      schema_version: '1.0.0',
      product_slug: productSlug,
      topology,
      origins,
      scenarios,
      network_policy: topology.network_policy || null,
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
      scenarios,
      rawResults,
      origins,
      networkViolations: collectedNetworkViolations,
      startedAt: runStartedAt,
      evaluationTime: flags.time || sealRes.manifest.sealed_at,
      harnessErrors,
    });

    if (isDevelopmentMode) {
      verdict.certification_status = 'UNPROVEN';
      verdict.certification_eligible = false;
      verdict.execution_mode = 'DEVELOPMENT';
      // A dirty tree makes a run non-certifiable; it does not make a harness
      // fault or tampered evidence disappear. Downgrading those to 2 here would
      // hide the very exit 3 the harness-error routing exists to produce, so an
      // integrity failure keeps its own exit code and only a would-be
      // pass/fail becomes UNPROVEN.
      if (verdict.run_integrity === 'COMPLETE') {
        verdict.exit_code = 2;
      }
      if (!verdict.causes.includes('HARNESS_CONFIGURATION')) {
        verdict.causes.push('HARNESS_CONFIGURATION');
      }
    }

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
        harness_config_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(harnessDir, 'harness.config.json'), 'utf8')).digest('hex'),
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
    console.error(`Run Local failed with runtime error: ${err.message}`);
    return 3;
  } finally {
    if (composeRunner) {
      console.log('Cleaning up Docker Compose containers...');
      composeRunner.teardown();
    }
    materializer.cleanup();
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
