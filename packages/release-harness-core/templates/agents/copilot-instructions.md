# Copilot Instructions for Release-Harness

This repository uses @xibodev/release-harness for deterministic quality-gating and local UAT.

## Release Quality Workflow
1. When asked to check, verify, or release changes, run:
   `npx release-harness check-pr` (Level 1 PR Gate)
   `npx release-harness run-local` (Level 2 Local UAT Gate)
2. All verdicts are calculated deterministically by the harness engine into `verdict.json`.
3. If exit code != 0, read the failure causes and screenshots in the evidence directory, resolve the code defects, and iterate until certified PASS (exit code 0).
