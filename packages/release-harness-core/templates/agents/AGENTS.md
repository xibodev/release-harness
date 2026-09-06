# AGENTS.md — Release Harness Autonomous Integration

Cross-tool entry point for **Release-Harness** across Claude Code, GitHub Copilot CLI, opencode, Codex, and Cursor.

## Roles & Personas
- **Release Conductor** (`agents/release-conductor.md`): Orchestrates the development and release loop from project definition to certified GREEN local-docker UAT.

## Multi-Runtime Directory Layout
- `.claude/agents/release-conductor.md` — Claude Code
- `.copilot/agents/release-conductor.md` — GitHub Copilot CLI
- `.github/agents/release-conductor.agent.md` — GitHub Copilot Extensions / Workspace
- `.opencode/agents/release-conductor.md` — opencode
- `.agents/skills/release-harness-*` — shared namespaced skills for compatible hosts

## Artifact-First Adoption
Follow `AI-ADOPTION.md`. Inspect `npx release-harness skills list`; use
`release-harness-project-cartographer` and `release-harness-scenario-compiler`
to derive contracts and present the diff for approval. Reload the host if its
catalog is stale. Preserve dirty changes and inspect underlying failures on
exit 2. Exit 3 UNKNOWN is unresolved attribution; preserve and investigate
exit-4 evidence rather than blindly cleaning it.

## Deterministic Core Boundary
AI personas do NOT calculate or override verdicts. Gate outcomes (`PASS`, `FAIL`, `UNPROVEN`, `HARNESS_ERROR`, `EVIDENCE_INVALID`) are computed solely by the deterministic `release-harness` CLI from sealed evidence.
