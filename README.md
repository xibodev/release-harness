# Release-Harness

[![CI](https://github.com/xibodev/release-harness/actions/workflows/validate.yml/badge.svg)](https://github.com/xibodev/release-harness/actions/workflows/validate.yml)
[![npm version](https://img.shields.io/npm/v/@xibodev/release-harness.svg)](https://www.npmjs.com/package/@xibodev/release-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Release-Harness runs project-defined quality gates and local Docker UAT, collects
evidence, and computes deterministic verdicts. Your repository owns the service
topology, browser scenarios, and side-effect assertions. No AI agent is required.

[Documentation](https://xibodev.github.io/release-harness/) |
[Upgrading](CHANGELOG.md) | [Contributing](CONTRIBUTING.md) | [Security](SECURITY.md)

## Install

The published npm release is **2.0.0**. See the
[release](https://github.com/xibodev/release-harness/releases/tag/v2.0.0) and
[changelog](CHANGELOG.md#200) for breaking changes and migration from 1.2.0.

```bash
npm install -D @xibodev/release-harness@2.0.0
npx playwright install chromium
```

Version 2.0.0 requires Node.js `>=20`; 1.2.0 metadata declared
`>=18`. Node.js 20 is the CI-tested baseline, not a claim that every newer runtime
is tested. Upgrade local and CI runtimes before adopting 2.0.0. Local
UAT also needs Git, Docker with Compose, a running Docker daemon, and Chromium's
OS dependencies. On Linux, `npx playwright install --with-deps chromium` installs
the browser and system dependencies where you have permission to do so.

## Manual Quick Start

Run these commands from your product repository.

### 1. Initialize

```bash
npx release-harness doctor
npx release-harness init
```

`doctor` reports prerequisite and contract readiness; missing contracts are
expected before initialization. Bare `init` writes contracts only and preserves
existing files. It does not configure or test your application for you.

### 2. Configure

Replace the generated examples under `.release-harness/` with your project's
actual configuration:

- `topology.json`: repositories, services, health probes, and network policy.
- `origins.json`: served application origins and routes.
- `harness.config.json`: port block, timeouts, and optional `pr_gate.commands`.
- `scenarios/*.json`: user journeys, assertions, and independent side-effect probes.

Provide the Docker Compose setup needed to build and serve your application.
Review contracts against the [schemas](packages/release-harness-schemas) and
[usage reference](https://xibodev.github.io/release-harness/docs.html). Generated
smoke assertions are examples, not evidence of product coverage. Use only
nonsecret test fixtures; provide runtime secrets through controlled environment
configuration, never by committing them.

### 3. Run And Inspect

For uncommitted development, choose an evidence directory outside the repository:

```bash
npx release-harness run-local --allow-dirty --evidence-dir ../release-harness-evidence
```

Dirty runs are non-certifying. Inspect failures even when the exit code is `2`.
Once the intended source and contracts are committed and the tree is clean:

```bash
npx release-harness run-local --evidence-dir ../release-harness-evidence
```

Read `runs/<id>/verdict.json`, `run.manifest.json`, and `evidence/` beneath that
root. An early failure can produce a diagnostic without a verdict.

| Outcome | Exit | Meaning |
|---|---|---|
| `PASS` | `0` | Declared gate requirements met; not deployment approval |
| `FAIL` | `1` | Gate failure; some early rejections have no verdict |
| `UNPROVEN` | `2` | Unmet conditions, waivers, or non-certifying development |
| `HARNESS_ERROR` | `3` | Contract, environment, or harness/probe failure |
| `EVIDENCE_INVALID` | `4` | Evidence integrity or validation failure |

Dirty mode preserves exits `3` and `4`. Preserve invalid evidence for
investigation; cleanup is not a repair or a reason to reseal an archive.

## CLI, CI, And Libraries

- `check-pr` validates contracts/toolchain and executes configured PR commands.
  Configure those commands before treating this as your project's CI gate.
- `run-local` runs Compose-backed UAT. CI needs the same Docker/browser
  prerequisites as a local run; retain evidence with restricted artifact access.
- `evaluate --run-id <id> --evidence-dir <root>/runs/<id>/evidence` reevaluates
  stored evidence; this command takes the sealed evidence directory itself.
- `clean --run-id <id> --evidence-dir <root>` targets a run's workspaces and scoped
  containers. Review retained evidence before cleanup.
- `multi_repo` topologies materialize each declared repository and record source
  provenance. All participating repositories and their commands must be trusted.
- The public package reexports core APIs and `Schemas` for programmatic use.
  The [Playwright adapter](packages/release-harness-core/src/playwright-adapter.js)
  executes and normalizes existing suites; it is a library integration, not a
  standalone CLI command or automatic end-to-end evidence sealing workflow.

Use `npx release-harness --help` for the commands available in your installed
version.

## Optional AI Assistance

`npx release-harness init --with-agents` adds the packaged `release-conductor`
persona, namespaced skill playbooks, and `AI-ADOPTION.md`. Ask an agent to derive
contracts from the application and present their diff for review before running
the gate. The deterministic CLI, not the agent, decides the verdict.

Version 2.0.0 includes read-only `skills list` / `skills info`, shared
`.agents/skills` scaffolding, and runtime-specific onboarding. From your product
repository with 2.0.0 installed, run:

```bash
npx release-harness skills list
npx release-harness skills info project-cartographer
```

See the [adoption guide](packages/release-harness-core/templates/AI-ADOPTION.md)
for the workflow. Playbooks require the host's tools; scaffolding does
not install Docker, browsers, scanners, credentials, or register skills with a
running host. Reload the host and check its catalog if skills are not discovered.

## Architecture And Scope

```text
@xibodev/release-harness          Public CLI and library facade
  @xibodev/release-harness-core   Runners, probes, sealing, evaluator, AI templates
  @xibodev/release-harness-schemas Versioned JSON contracts
```

Implemented capabilities include detached Git source materialization, local
Compose lifecycle, declarative Chromium scenarios, S3/Redis/Mailpit and custom
side-effect probes, hash-checked evidence, and deterministic evaluation.
Version 2.0.0 adds sealed startup diagnostics, stricter replay validation, and
destination-filtered browser proxy transport; see the changelog for compatibility.

Planned extensions include ephemeral-environment and canary workflows.
`run-ephemeral` and `verify-canary` are not implemented. No release date or version
is promised for them.

## Limits And Upgrading

- `sql_query` is unsupported. Use a trusted custom probe that actually queries and
  asserts database state; custom probes use exit status, not stdout matching.
- Ignored files are excluded from detached source. Nonignored untracked files
  are included only in dirty development; clean runs require committed inputs.
- Repository commands and Docker access are trusted execution, not a sandbox.
  Browser network policy is not a container firewall. Hash integrity does not
  independently authenticate evidence. See the [security model](SECURITY.md).
- A `PASS` covers the declared scenarios and requirements, not all possible
  behavior, production readiness, or authorization to deploy.
- Read [compatibility notes](CHANGELOG.md) before upgrading. Preserve customized
  contracts and agent files: `init --force` / `--overwrite` resets them, not just
  outdated instructions.

## License

[MIT](LICENSE), XiboDev.
