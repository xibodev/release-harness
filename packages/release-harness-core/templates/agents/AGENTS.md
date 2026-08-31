# AGENTS.md — Release Harness Autonomous Integration

Cross-tool entry point for **Release-Harness** across Claude Code, GitHub Copilot CLI, opencode, Codex, and Cursor.

## Roles & Personas
- **Release Conductor** (`agents/release-conductor.md`): Orchestrates the development and release loop from project definition to certified GREEN local-docker UAT.

## Multi-Runtime Directory Layout
- `.claude/agents/release-conductor.md` — Claude Code
- `.copilot/agents/release-conductor.md` — GitHub Copilot CLI
- `.github/agents/release-conductor.agent.md` — GitHub Copilot Extensions / Workspace
- `.opencode/agents/release-conductor.md` — opencode

## Deterministic Core Boundary
AI personas do NOT calculate or override verdicts. Gate outcomes (`PASS`, `FAIL`, `UNPROVEN`, `HARNESS_ERROR`, `EVIDENCE_INVALID`) are computed solely by the deterministic `release-harness` CLI from sealed evidence.
