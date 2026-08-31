# Release-Harness

[![CI](https://github.com/xibodev/release-harness/actions/workflows/validate.yml/badge.svg)](https://github.com/xibodev/release-harness/actions/workflows/validate.yml)
[![npm version](https://img.shields.io/npm/v/@xibodev/release-harness.svg)](https://www.npmjs.com/package/@xibodev/release-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A portable, deterministic quality-gate adjudication engine and local UAT release harness for modern software products.

Consumable from any external product repository as a normal npm development dependency (similar to `playwright`, `pytest`, or `eslint`).

---

## Features

- **Product-Owned Test Intent**: Product repos declare their own topology, served origins, and declarative scenarios under `.release-harness/`.
- **Deterministic Pure-Function Evaluator**: Verifiable adjudication derived strictly from sealed evidence with independent SHA-256 integrity checks.
- **Detached Source Materialization**: Guaranteed zero repository / `.git` pollution during local test runs.
- **Real Playwright Browser Automation**: Declarative scenarios compiled directly to Playwright with deep network egress monitoring and negative control verification.
- **Independent Side-Effect Probing**: Verifies out-of-band state changes (S3/MinIO objects, database writes, Redis keys) with bypass detection.
- **Multi-Runtime Agent Support**: Ships canonical and generated agent personas (`release-conductor`) for Claude Code, GitHub Copilot CLI, opencode, Cursor, and Codex.

---

## Installation

Install into your product repository as a dev dependency:

```bash
npm install -D @xibodev/release-harness
```

---

## Quick Start

### 1. Check prerequisites
```bash
npx release-harness doctor
```

### 2. Initialize product contract
```bash
npx release-harness init
```
This scaffolds a `.release-harness/` directory in your repository:
```text
.release-harness/
├── harness.config.json    # Execution controls, timeouts, and port allocations
├── topology.json          # Service graph and health probes
├── origins.json           # Declared origins (web apps, APIs, workers)
└── scenarios/
    └── smoke.json         # Declarative Playwright scenarios
```

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

## Architecture

```text
@xibodev/release-harness            (Public Facade CLI)
        ↓
@xibodev/release-harness-core       (Deterministic Evaluator & Runner Engine)
        ↓
@xibodev/release-harness-schemas    (Formal JSON Schemas v1.0.0)
```

### Gate Outcomes

| Status | Exit Code | Description |
|---|---|---|
| `PASS` | `0` | All required & conditional scenarios passed with verified side effects |
| `FAIL` | `1` | One or more scenarios failed due to product defects or unmet required dependencies |
| `UNPROVEN` | `2` | Preconditions unmet or active waivers present (non-certifying dev run) |
| `HARNESS_ERROR` | `3` | Malformed scenario, environment missing, or Compose failure |
| `EVIDENCE_INVALID` | `4` | Sealed evidence checksum mismatch or tampering detected |

---

## License

MIT © [XiboDev](https://github.com/xibodev)
