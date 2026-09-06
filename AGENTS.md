# AGENTS.md — Release Harness Multi-Runtime Integration

Cross-tool entry point for **Release-Harness** across Claude Code, GitHub Copilot CLI, Gemini CLI, opencode, Codex, and Cursor.

## Roles & Personas

- **Release Conductor** (`agents/release-conductor.md`): Orchestrates the product-readiness loop from product definition to GREEN mock-integrated local-docker UAT using the deterministic `release-harness` CLI.

## Multi-Runtime Directory Layout

- `.claude/agents/release-conductor.md` — Claude Code variant
- `.copilot/agents/release-conductor.md` — GitHub Copilot CLI variant
- `.github/agents/release-conductor.agent.md` — GitHub Copilot Workspace / Extensions variant
- `.opencode/agents/release-conductor.md` — opencode variant
- `.agents/skills/release-harness-*` — shared namespaced skill bundle after `init --with-agents`

Inspect packaged skills with `npx release-harness skills list` before scaffolding.
Follow the packaged `AI-ADOPTION.md` protocol: derive contracts, review their diff,
and triage deterministic verdict causes. Disk scaffold status is not host registration.

## Principle of Deterministic Core Authority

AI personas and LLM agents do **not** calculate or override gate verdicts. Gate outcomes (`PASS`, `FAIL`, `UNPROVEN`, `HARNESS_ERROR`, `EVIDENCE_INVALID`) and cause classifications are computed solely by the deterministic `@xibodev/release-harness` CLI from sealed, tamper-checked evidence.
