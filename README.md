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
- 18 specialized AI skill playbooks for discovery, pre-release audits, and bug fixing, scaffolded under `release-harness-*` names so they cannot shadow skills you already have.

*(A bare `npx release-harness init` writes contracts only; `--contracts-only` states that explicitly. The two scaffolding flags are mutually exclusive. **The skill bundle ships with `init --with-agents`, not with `npm install`** — it lives inside the package until init copies it out.)*

Before scaffolding, `npx release-harness skills list` previews the 18 bundled
capabilities and their target directories without writing to the workspace.

### 3. Derive topology and origins

Invoke `release-harness-project-cartographer` to inspect real services, ports,
and health probes and generate `topology.json` and `origins.json`. Review the
generated diff rather than hand-authoring raw schema JSON.

### 4. Compile scenarios

Invoke `release-harness-scenario-compiler` to compile user stories, personas,
and side-effect expectations into `.release-harness/scenarios/`, then review
the generated diff.

### 5. Establish a local GREEN baseline
```bash
npx release-harness run-local
```

### 6. Integrate existing CI/CD

Run `npx release-harness check-pr` on pull requests and
`npx release-harness run-local` on release branches.

To clean up temporary workspaces and containers:
```bash
npx release-harness clean
```

---

## Using with AI Coding Agents

**[`AI-ADOPTION.md`](packages/release-harness-core/templates/AI-ADOPTION.md) is
the standard integration protocol for AI coding agents.** `init --with-agents`
copies it into the adopting repository alongside the skill bundle.

Tell your AI agent (Claude Code, GitHub Copilot, opencode, Cursor):

```text
Analyze @xibodev/release-harness (https://xibodev.github.io/release-harness/) and integrate it into our project for local deterministic quality gating. Run `npx release-harness skills list` to inspect the packaged bundle, then `npx release-harness init --with-agents` and read AI-ADOPTION.md. Use `release-harness-project-cartographer` and `release-harness-scenario-compiler` to derive contract artifacts from source, and present their diffs for review instead of hand-authoring JSON.
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
| `FAIL` | `1` | A required result failed, or certification stopped before writing a verdict | Inspect verdict causes when present; otherwise follow runtime diagnostics |
| `UNPROVEN` | `2` | Preconditions unmet, active waivers present, or non-certifying dev run (`--allow-dirty`) | Inspect underlying results; resolve failures before committing |
| `HARNESS_ERROR` | `3` | Malformed scenario, missing runtime environment, Compose/build crash, or an unimplemented probe | Follow runtime diagnostics; do not infer a product defect from exit 3 alone |
| `EVIDENCE_INVALID` | `4` | Evidence file tampering or SHA-256 checksum mismatch detected | Clean workspace with `clean` |

---

## License

MIT © [XiboDev](https://github.com/xibodev)
