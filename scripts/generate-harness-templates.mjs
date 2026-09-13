import fs from 'node:fs';
import path from 'node:path';

const aomRoot = 'E:/open-source-projects/agent-operating-model';
const rhCoreRoot = 'E:/open-source-projects/release-harness/packages/release-harness-core';
const tmplDir = path.join(rhCoreRoot, 'templates');
const skillsTmplDir = path.join(tmplDir, 'skills');
const agentsTmplDir = path.join(tmplDir, 'agents');

fs.mkdirSync(skillsTmplDir, { recursive: true });
fs.mkdirSync(agentsTmplDir, { recursive: true });

// Copy agent templates
fs.copyFileSync(path.join(aomRoot, 'agents', 'release-conductor.md'), path.join(agentsTmplDir, 'release-conductor.md'));
fs.copyFileSync(path.join(aomRoot, '.github', 'agents', 'release-conductor.agent.md'), path.join(agentsTmplDir, 'release-conductor.agent.md'));

// Write copilot-instructions.md template
const copilotInstructions = `# Copilot Instructions for Release-Harness

This repository uses @xibodev/release-harness for deterministic quality-gating and local UAT.

## Release Quality Workflow
1. When asked to check, verify, or release changes, run:
   \`npx release-harness check-pr\` (Level 1 PR Gate)
   \`npx release-harness run-local\` (Level 2 Local UAT Gate)
2. All verdicts are calculated deterministically by the harness engine into \`verdict.json\`.
3. If exit code != 0, read the failure causes and screenshots in the evidence directory, resolve the code defects, and iterate until certified PASS (exit code 0).
`;
fs.writeFileSync(path.join(agentsTmplDir, 'copilot-instructions.md'), copilotInstructions, 'utf8');

// Write AGENTS.md template
const agentsMd = `# AGENTS.md — Release Harness Autonomous Integration

Cross-tool entry point for **Release-Harness** across Claude Code, GitHub Copilot CLI, opencode, Codex, and Cursor.

## Roles & Personas
- **Release Conductor** (\`agents/release-conductor.md\`): Orchestrates the development and release loop from project definition to certified GREEN local-docker UAT.

## Multi-Runtime Directory Layout
- \`.claude/agents/release-conductor.md\` — Claude Code
- \`.copilot/agents/release-conductor.md\` — GitHub Copilot CLI
- \`.github/agents/release-conductor.agent.md\` — GitHub Copilot Extensions / Workspace
- \`.opencode/agents/release-conductor.md\` — opencode

## Deterministic Core Boundary
AI personas do NOT calculate or override verdicts. Gate outcomes (\`PASS\`, \`FAIL\`, \`UNPROVEN\`, \`HARNESS_ERROR\`, \`EVIDENCE_INVALID\`) are computed solely by the deterministic \`release-harness\` CLI from sealed evidence.
`;
fs.writeFileSync(path.join(agentsTmplDir, 'AGENTS.md'), agentsMd, 'utf8');

// Write .cursorrules template
const cursorRules = `# Release-Harness Cursor Rules
- When verifying code changes, run \`npx release-harness run-local\` in the terminal.
- Inspect \`verdict.json\` in the evidence directory. Fix code defects until exit code is 0.
- Do not mutate \`.release-harness/topology.json\` or \`origins.json\` unless service ports change.
`;
fs.writeFileSync(path.join(agentsTmplDir, '.cursorrules'), cursorRules, 'utf8');

// Helper to copy and clean a skill
function copySkill(srcPath, skillName) {
  const destDir = path.join(skillsTmplDir, skillName);
  fs.mkdirSync(destDir, { recursive: true });
  let content = fs.readFileSync(srcPath, 'utf8');
  content = content.replace(/product/g, 'project').replace(/PRODUCT/g, 'PROJECT');
  fs.writeFileSync(path.join(destDir, 'SKILL.md'), content, 'utf8');
}

// 1. project-cartographer
const projectCartographerSkill = `---
name: project-cartographer
description: Scans the project repository to discover Docker Compose services, web/API routes, and health probes, populating .release-harness/topology.json and origins.json.
allowed-tools: [Read, Grep, Glob, Write]
---

# Project Cartographer

Discovers the project's service architecture and maps it into formal Release-Harness contracts.

## Steps
1. Inspect \`docker-compose.yml\`, \`package.json\`, \`Dockerfile\`, and application routes.
2. Identify served origins (web apps, APIs, workers).
3. Populate \`.release-harness/topology.json\` matching \`topology-v1.json\` schema.
4. Populate \`.release-harness/origins.json\` matching \`origins-v1.json\` schema.
5. Verify schema validity with \`npx release-harness check-pr\`.
`;
fs.mkdirSync(path.join(skillsTmplDir, 'project-cartographer'), { recursive: true });
fs.writeFileSync(path.join(skillsTmplDir, 'project-cartographer', 'SKILL.md'), projectCartographerSkill, 'utf8');

// 2. scenario-compiler
const scenarioCompilerSkill = `---
name: scenario-compiler
description: Translates user personas, authentication flows, and user stories into declarative Playwright scenarios (.release-harness/scenarios/*.json).
allowed-tools: [Read, Grep, Glob, Write]
---

# Scenario Compiler

Compiles user journeys into deterministic JSON/YAML scenarios for Release-Harness.

## Scenario Schema Verbs
- \`navigate\`: \`{ "action": "navigate", "target": "/path" }\`
- \`fill\`: \`{ "action": "fill", "target": "#selector", "value": "text" }\`
- \`click\`: \`{ "action": "click", "target": "button.submit" }\`
- \`assert\`: \`{ "action": "assert", "target": "text:Expected Text" }\`
- \`screenshot\`: \`{ "action": "screenshot" }\`
- \`negative_control\`: \`{ "expected_http_status": 401, "expected_rejection_reason": "invalid_credentials" }\`

## Steps
1. Review user stories, authentication flows, and form inputs.
2. Author declarative scenarios in \`.release-harness/scenarios/<scenario-id>.json\`.
3. Ensure every browser_app origin has at least one required scenario.
`;
fs.mkdirSync(path.join(skillsTmplDir, 'scenario-compiler'), { recursive: true });
fs.writeFileSync(path.join(skillsTmplDir, 'scenario-compiler', 'SKILL.md'), scenarioCompilerSkill, 'utf8');

// 3. change-safety
const changeSafetySkill = `---
name: change-safety
description: Pre-commit/pre-push gate that inspects diffs for secret leaks, destructive deletions, and verifies clean git tree before release evaluation.
allowed-tools: [Read, Grep, Glob, Bash]
---

# Change Safety Gate

Verifies that the working tree is clean and safe for release adjudication.

## Steps
1. Run \`npx release-harness check-pr\`.
2. Inspect git diff for credentials, API tokens, or hardcoded secrets.
3. Ensure all tests and contract files are committed before certification runs.
`;
fs.mkdirSync(path.join(skillsTmplDir, 'change-safety'), { recursive: true });
fs.writeFileSync(path.join(skillsTmplDir, 'change-safety', 'SKILL.md'), changeSafetySkill, 'utf8');

// Copy remaining pre-release and remediation skills from AOM
copySkill(path.join(aomRoot, 'fix-planner', 'skills', 'fix-planner', 'SKILL.md'), 'fix-planner');
copySkill(path.join(aomRoot, 'fix-executor', 'skills', 'fix-executor', 'SKILL.md'), 'fix-executor');
copySkill(path.join(aomRoot, 'docker-uat-runner', 'skills', 'data-seeding', 'SKILL.md'), 'data-seeding');
copySkill(path.join(aomRoot, 'preprod-release-check', 'skills', 'code-change-review', 'SKILL.md'), 'code-change-review');
copySkill(path.join(aomRoot, 'preprod-release-check', 'skills', 'test-coverage-audit', 'SKILL.md'), 'test-coverage-audit');
copySkill(path.join(aomRoot, 'preprod-release-check', 'skills', 'database-readiness-audit', 'SKILL.md'), 'database-readiness-audit');
copySkill(path.join(aomRoot, 'preprod-release-check', 'skills', 'security-audit', 'SKILL.md'), 'security-audit');
copySkill(path.join(aomRoot, 'preprod-release-check', 'skills', 'fintech-security-review', 'SKILL.md'), 'fintech-security-review');
copySkill(path.join(aomRoot, 'preprod-release-check', 'skills', 'performance-audit', 'SKILL.md'), 'performance-audit');
copySkill(path.join(aomRoot, 'e2e-playwright-test', 'skills', 'deep-screenshot-analysis', 'SKILL.md'), 'deep-screenshot-analysis');
copySkill(path.join(aomRoot, 'preprod-release-check', 'skills', 'monitoring-audit', 'SKILL.md'), 'monitoring-audit');
copySkill(path.join(aomRoot, 'preprod-release-check', 'skills', 'release-readiness', 'SKILL.md'), 'release-decider');
copySkill(path.join(aomRoot, 'preprod-release-check', 'skills', 'deployment-plan-generator', 'SKILL.md'), 'deployment-plan-generator');
copySkill(path.join(aomRoot, 'preprod-release-check', 'skills', 'post-deploy-window-planner', 'SKILL.md'), 'post-deploy-window-planner');
copySkill(path.join(aomRoot, 'session', 'skills', 'session-handoff-agent', 'SKILL.md'), 'session-handoff-agent');

console.log('Templates created successfully in packages/release-harness-core/templates');
