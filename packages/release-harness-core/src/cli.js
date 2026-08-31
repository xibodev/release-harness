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
import { validateTopology, validateOrigins } from './validator.js';

const HARNESS_VERSION = '1.0.1';

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
  --config       Path to harness config (default: .release-harness/harness.config.json)
  --evidence-dir External evidence output directory (default: system cache)
  --allow-dirty  Allow uncommitted changes (marks run as NON-CERTIFYING development mode, exit 2)
  --with-agents  Opt-in to scaffold AI agent instructions and skills during init
  --force        Overwrite existing files during init
  --dry-run      Simulate action without writing files
  --run-id       Target a specific run ID for evaluation or cleanup
  --port-offset  Port block offset for concurrent runs (default: 0)
  --time         Fixed evaluation timestamp for deterministic replay
  --version, -v  Show release-harness version
  --help, -h     Show this help message
`);
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

function resolveEvidenceRoot(flags, productSlug) {
  if (flags['evidence-dir']) {
    return path.resolve(flags['evidence-dir']);
  }
  const baseCache = process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(baseCache, 'release-harness', productSlug || 'default');
}

function copyDirectoryRecursive(src, dest, force = false, dryRun = false) {
  if (!fs.existsSync(src)) return;
  if (!dryRun) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath, force, dryRun);
    } else {
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
  const flags = parseFlags(args);
  const cwd = process.cwd();
  const dryRun = Boolean(flags['dry-run']);
  const force = Boolean(flags['force'] || flags['overwrite']);
  const withAgents = Boolean(flags['with-agents']);

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

  // 2. Multi-runtime agent scaffolding (Opt-in with --with-agents or default when unpopulated)
  if (withAgents || !fs.existsSync(path.join(cwd, 'AGENTS.md'))) {
    try {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const templatesDir = path.resolve(__dirname, '../templates');

      if (fs.existsSync(templatesDir)) {
        const tmplAgentsDir = path.join(templatesDir, 'agents');
        const tmplSkillsDir = path.join(templatesDir, 'skills');

        // AGENTS.md & .cursorrules
        if (fs.existsSync(path.join(tmplAgentsDir, 'AGENTS.md'))) {
          writeFileSafe(path.join(cwd, 'AGENTS.md'), fs.readFileSync(path.join(tmplAgentsDir, 'AGENTS.md'), 'utf8'), 'AGENTS.md');
        }
        if (fs.existsSync(path.join(tmplAgentsDir, '.cursorrules'))) {
          writeFileSafe(path.join(cwd, '.cursorrules'), fs.readFileSync(path.join(tmplAgentsDir, '.cursorrules'), 'utf8'), '.cursorrules');
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
        copyDirectoryRecursive(tmplSkillsDir, claudeSkillsDir, force, dryRun);

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
        copyDirectoryRecursive(tmplSkillsDir, opencodeSkillsDir, force, dryRun);

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
      }
    } catch (err) {
      console.warn(`  ! Agent scaffolding notice: ${err.message}`);
    }
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

    // 4. Execute explicitly configured PR Gate commands (e.g. lint, typecheck, unit tests)
    if (fs.existsSync(configFile)) {
      try {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
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
      } catch (configErr) {
        console.warn(`  ! Note: Could not parse harness.config.json for pr_gate: ${configErr.message}`);
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
  const flags = parseFlags(args);
  const cwd = process.cwd();
  const runStartedAt = new Date().toISOString();
  const runId = flags['run-id'] || `run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const portOffset = parseInt(flags['port-offset'] || '0', 10);
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
    const matResult = materializer.materializeRepo(cwd, 'source');
    sourceInfo = matResult.sourceInfo;
    const workSourceDir = matResult.targetDir;
    console.log(`   Source SHA: ${sourceInfo.commitSha} (${sourceInfo.isClean ? 'clean' : 'dirty'})`);

    const isDevelopmentMode = !sourceInfo.isClean && Boolean(flags['allow-dirty']);
    if (!sourceInfo.isClean && !flags['allow-dirty']) {
      console.error('   ✗ Dirty source rejected for certification gate.');
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
    });

    for (const sc of scenarios) {
      const res = await scenarioRunner.runScenario(sc);
      rawResults.push(res);
      const mark = res.failed ? '✗' : '✓';
      console.log(`   ${mark} [${sc.id}] ${sc.name} → ${res.target_base_url} (${res.duration_ms}ms)`);
    }

    // Collect network violations from scenarios
    const collectedNetworkViolations = rawResults.flatMap((r) => r.network_violations || []);

    // Write execution logs into evidence directory (Redacted prior to sealing)
    const logContent = redactor.redactText(`Run ${runId} completed scenario sweep at ${runStartedAt}\n`);
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
      verdict.exit_code = 2;
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
      sources: [
        {
          commit_sha: sourceInfo.commitSha,
          is_clean: sourceInfo.isClean,
          dirty_files: sourceInfo.dirtyFiles,
          tree_digest: sourceInfo.treeDigest,
        },
      ],
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
