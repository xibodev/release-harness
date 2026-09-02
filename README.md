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
- **Fail-Closed Side-Effect Probing**: Verifies out-of-band state changes (MinIO/S3 object creation, bounded read-only PostgreSQL queries, Redis keys, Mailpit messages) with `/tmp` local path bypass detection.
- **Autonomous AI Agent Integration**: Scaffolds 17 cognitive skills and multi-runtime agent personas (`release-conductor`) for Claude Code, GitHub Copilot, opencode, Cursor, and Codex.
- **28 Neutral Acceptance Fixtures**: Hardened against false certification with strict coverage floors, gate-relative skip policies, and deterministic replay.

---

## Installation

Install into your project repository as a development dependency:

```bash
npm install -D @xibodev/release-harness
```

---

## Quick Start

### 1. Check host prerequisites
```bash
npx release-harness doctor
```

### 2. Initialize project contracts & AI agents
```bash
npx release-harness init
```
This scaffolds:
- `.release-harness/` (contract specifications: `topology.json`, `origins.json`, `harness.config.json`, `scenarios/smoke.json`)
- `AGENTS.md` & `.cursorrules` in project root
- Multi-runtime agent instructions (`.claude/`, `.github/`, `.opencode/`, `.copilot/`)
- 17 specialized AI skill playbooks for discovery, pre-release audits, and bug fixing.

*(To scaffold contracts only without agent instructions, run `npx release-harness init --contracts-only`).*

### 3. Run Level 1 PR Integration Gate
```bash
npx release-harness check-pr
```

### 4. Run Level 2 Local Release UAT Gate
```bash
npx release-harness run-local
```

### 5. Clean up temporary workspaces and containers
```bash
npx release-harness clean
```

---

## Using with AI Coding Agents

Tell your AI agent (Claude Code, GitHub Copilot, opencode, Cursor):

```text
Analyze @xibodev/release-harness (https://xibodev.github.io/release-harness/) and integrate it into our project for local deterministic quality gating.
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
| `FAIL` | `1` | One or more scenarios failed due to product defects or unmet required dependencies | Invoke `fix-planner` & `fix-executor` |
| `UNPROVEN` | `2` | Preconditions unmet, active waivers present, or non-certifying dev run (`--allow-dirty`) | Acquire fixtures or commit changes |
| `HARNESS_ERROR` | `3` | Malformed scenario, missing runtime environment, Compose crash, or a probe the harness does not implement | Fix configuration |
| `EVIDENCE_INVALID` | `4` | Evidence file tampering or SHA-256 checksum mismatch detected | Clean workspace with `clean` |

---

## License

MIT © [XiboDev](https://github.com/xibodev)
