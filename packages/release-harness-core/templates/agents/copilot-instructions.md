# Copilot Instructions for Release-Harness

This repository uses @xibodev/release-harness for deterministic quality-gating and local UAT.

## Release Quality Workflow
1. For initial adoption, run `npx release-harness skills list`, then
   `npx release-harness init --with-agents` and follow `AI-ADOPTION.md`.
   Derive contracts with `release-harness-project-cartographer` and
   `release-harness-scenario-compiler`; present generated diffs for human review.
2. When asked to check, verify, or release changes, run:
   `npx release-harness check-pr` (Level 1 PR Gate)
   `npx release-harness run-local` (Level 2 Local UAT Gate)
3. All verdicts are calculated deterministically by the harness engine into `verdict.json`.
4. Route failures by exit code: fix product defects for exit 1; treat exit 2 with
   `--allow-dirty` as expected non-certifying development; fix harness
   configuration, not product code, for exit 3; treat exit 4 as invalid evidence.
