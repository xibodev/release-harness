# Release-Harness

[![CI](https://github.com/xibodev/release-harness/actions/workflows/validate.yml/badge.svg)](https://github.com/xibodev/release-harness/actions/workflows/validate.yml)
[![npm version](https://img.shields.io/npm/v/@xibodev/release-harness.svg)](https://www.npmjs.com/package/@xibodev/release-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Documentation](https://img.shields.io/badge/Docs-xibodev.github.io%2Frelease--harness-indigo)](https://xibodev.github.io/release-harness/)

A portable, deterministic quality-gate adjudication engine and local UAT release harness for modern software projects.

Consumable by human developers and autonomous AI coding agents as a standard npm development dependency (similar to `playwright`, `pytest`, or `eslint`).

📖 **Full Interactive Documentation & Guides:** **[https://xibodev.github.io/release-harness/](https://xibodev.github.io/release-harness/)**

---

## Features

- **Project-Owned Test Intent**: Projects declare their own topology, served origins, and declarative scenarios under `.release-harness/`.
- **Deterministic Pure-Function Evaluator**: Cryptographic adjudication derived strictly from sealed evidence with independent SHA-256 integrity verification.
- **Detached Source Materialization**: Guaranteed zero repository / `.git` pollution during local test runs.
- **Real Playwright Browser Automation**: Declarative scenarios compiled directly to Playwright Chromium with deep network egress interception, direct-IP blocking, and negative control verification.
- **Existing Playwright Suite Adapter**: Native runner that executes existing product-owned Playwright suites (`playwright test --reporter=json`) and normalizes test IDs, traces, and attachments without rewriting code.
- **Fail-Closed Side-Effect Probing**: Verifies out-of-band state changes (MinIO/S3 objects, Redis keys, Mailpit messages) with `/tmp` local path bypass detection, plus project-owned **custom probes** for products whose deliverable is a file.
- **Autonomous AI Agent Integration**: `init --with-agents` scaffolds 18 cognitive skills and multi-runtime agent personas (`release-conductor`) for Claude Code, GitHub Copilot, opencode, Cursor, and Codex.
- **38 Neutral Acceptance Fixtures**: Hardened against false certification with strict coverage floors, gate-relative skip policies, and deterministic replay.

---

## Installation

Install into your project repository as a development dependency:

```bash
npm install -D @xibodev/release-harness
```

---

## Artifact-First Quick Start

### 1. Check host prerequisites
```bash
npx release-harness doctor
```

### 2. Initialize project contracts & AI agents
```bash
npx release-harness init --with-agents
```
This scaffolds:
- `.release-harness/` (contract specifications: `topology.json`, `origins.json`, `harness.config.json`, `scenarios/smoke.json`)
- `AGENTS.md`, `AI-ADOPTION.md` & `.cursorrules` in project root
- Multi-runtime agent instructions (`.claude/`, `.github/`, `.opencode/`, `.copilot/`)
- 18 specialized AI skill playbooks for discovery, pre-release audits, and bug fixing, scaffolded under `release-harness-*` names in `.claude/skills/`, `.agents/skills/`, and `.opencode/skills/`.

*(A bare `npx release-harness init` writes contracts only; `--contracts-only` states that explicitly. The two scaffolding flags are mutually exclusive. **The skill bundle ships with `init --with-agents`, not with `npm install`** — it lives inside the package until init copies it out.)*

Preview the bundle without writing files using `npx release-harness skills list`
or `npx release-harness skills info project-cartographer`. Both bare and prefixed
names work for `info`; invoke the actual skills by their `release-harness-*` names.

Hosts may cache their skill catalogs. If the new skills are absent, exit and
relaunch Claude Code, opencode, or Copilot CLI from this repository. For
Cursor/Codex, use the host's documented reload or restart. Check the host catalog
afterward: `skills list` checks disk, not host registration. `/init` is not a
portable reload command. Preserve a handoff before restarting; if restart is
unavailable, read the scaffolded `SKILL.md` and follow its procedure directly.

### 3. Delegate Contract Derivation

Use these phase prompts rather than asking the human to hand-write schema JSON:

1. **Cartographer:** "Use release-harness-project-cartographer to derive topology.json and origins.json from real ports, services, and health probes. Present the generated artifact diff for review."
2. **Compiler:** "Use release-harness-scenario-compiler to compile our user journeys into scenarios with independent side-effect probes. Present the diff for approval."
3. **Conductor:** "Use release-conductor to run doctor and the local readiness gate with an explicit external evidence root. Report the deterministic verdict and causes."
4. **Remediation:** "Use release-harness-fix-planner to derive an evidence-linked plan from this run. After approval, use release-harness-fix-executor for targeted fixes without weakening contracts or discarding working changes."
5. **Decider:** The deterministic CLI alone returns PASS, FAIL, UNPROVEN, HARNESS_ERROR, or EVIDENCE_INVALID. A persona or human review cannot substitute for that result.

### 4. Establish A Local Baseline

While changes are uncommitted, run a non-certifying development gate:

```bash
npx release-harness run-local --allow-dirty --evidence-dir <external-root>
```

Inspect underlying results even when the exit is 2. Resolve failures and unmet
conditions; after approval and an authorized commit, run clean certification:

```bash
npx release-harness run-local --evidence-dir <external-root>
```

### 5. Integrate CI And Scoped Cleanup

Run `check-pr` on pull requests and `run-local` on release branches. Preserve
evidence, especially for exit 4; cleanup does not repair invalid evidence.

```bash
npx release-harness clean --run-id <id> --evidence-dir <external-root>
```

---

## Using with AI Coding Agents

**[AI-ADOPTION.md](packages/release-harness-core/templates/AI-ADOPTION.md) is the
standard integration protocol.** `init --with-agents` copies it into the project.

The 18 skills are playbooks, not installed executables or infrastructure. They
require the host's file/shell tools; screenshot review additionally needs image
input. Scaffolding does not install browsers, Docker, databases, scanners or
credentials. Dynamic probes need separately verified, authorized local targets;
missing tooling is reported as a deferred check, not a pass. Optional external
toolkit reports are not prerequisites for basic adoption. Audit risk/visual
scores remain advisory and cannot override the deterministic CLI verdict.

Tell your AI agent (Claude Code, GitHub Copilot, opencode, Cursor):

```text
Inspect `npx release-harness skills list`, run doctor and `init --with-agents`, then follow AI-ADOPTION.md. Use `release-harness-project-cartographer` and `release-harness-scenario-compiler` to derive contract artifacts and present their diffs for approval. Preserve unrelated working changes and let the deterministic CLI adjudicate the gate.
```

Or delegate directly using the shipped `release-conductor` persona:

```text
Use release-conductor to run our release quality gate and drive this branch to green.
```

---

## Architecture

```text
@xibodev/release-harness            (Public Facade CLI)
        ↓
@xibodev/release-harness-core       (Deterministic Evaluator, Runner Engine & Adapters)
        ↓
@xibodev/release-harness-schemas    (Formal JSON Schemas v1.x)
```

### Gate Outcomes & Exit Codes

| Status | Exit Code | Description | Action |
|---|---|---|---|
| `PASS` | `0` | All required & conditional scenarios passed with verified side effects | Certified for release |
| `FAIL` | `1` | Failure, or early rejection without a verdict | Inspect causes: fix PRODUCT_BUG, acquire missing fixtures, or follow runtime diagnostics |
| `UNPROVEN` | `2` | Unmet conditions, waivers, or dirty development | Inspect underlying failures before clean certification |
| `HARNESS_ERROR` | `3` | Contract/environment/probe or startup failure | Inspect sealed startup evidence and diagnostics; UNKNOWN is unresolved attribution, not proof of a product bug |
| `EVIDENCE_INVALID` | `4` | Tampering or checksum mismatch | Preserve the run and investigate; do not blindly clean, edit, or reseal evidence |

With `--evidence-dir <root>`, read `<root>/runs/<id>/verdict.json`,
`run.manifest.json` beside it, and sealed files under `<root>/runs/<id>/evidence/`.
An early diagnostic may exist without a verdict; report that honestly.
Startup observations may be retained without raw logs for secret safety; do not
assume arbitrary build/Compose output was captured or is safe to reproduce.
Dirty development preserves harness/evidence faults as exits 3/4.

### Migration Notes

Ignored files never reach the detached workspace; nonignored untracked files
reach dirty development only. Inspect materialization warnings and supply
configuration through the approved runtime environment; never commit secrets.
`topology.json.network_policy` is canonical; legacy config policy is supported,
but conflicting declarations are rejected. Browser egress filtering does not
prove container-wide network isolation.

Sealed Chromium routes HTTP and WebSocket traffic through a destination-filtering
proxy and disables non-proxied WebRTC UDP. HTTPS/WSS tunnels are checked by
destination host, port, and transport, not by decrypted request content, SNI, or
certificate identity. An allowed service acting as a relay is outside this
boundary. Blocked WebRTC UDP attempts do not produce individual verdict violations.

Preserve existing contracts on upgrade. If changing `product_slug`, change
topology and harness config together. Repair host-specific agent frontmatter
in the individual file, preserving customizations. Do not use blanket
`init --overwrite`/`--force`: those flags reset project contracts as well.

### Contributor Validation

Run `npm test` for schemas, core regressions, neutral fixtures, smoke acceptance,
and fresh-package installability. The full gate needs Docker, Playwright Chromium,
`tar`, and OpenSSL 1.1.1 or newer. Transport tests generate temporary TLS keys and
remove them afterward; Windows can use OpenSSL from a standard Git installation
or from PATH. File-symlink tests report skips when the host denies symlink creation;
run the gate on Linux or a suitably privileged host for that coverage.

---

## License

MIT © [XiboDev](https://github.com/xibodev)
