---
name: release-harness-fix-executor
description: Applies an explicitly approved evidence-linked execution-plan.json with targeted validation, preserves unrelated dirty changes, and reruns the deterministic release-harness gate.
compatibility: Requires an approved execution-plan.json and the project's own test tools. No helper scripts required.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Edit
  - Create
---

# Release-Harness Fix Executor

Apply only an explicitly approved plan from `release-harness-fix-planner`.
This skill is self-contained: use the project's actual test commands, not
missing validation scripts or a separate workflow framework.

## Protect The Working Tree

1. Read the plan and confirm its run ID, evidence links, scope, and explicit
   human approval. An `approved` field alone is not human authorization.
2. Inspect `git status`, staged and unstaged diffs, and affected files. Dirty
   development is allowed; record the starting state and preserve user changes.
   Do not stash, reset, checkout, auto-commit, or discard unrelated edits.
3. If an approved edit overlaps a user's change ambiguously, stop that item
   and ask how to reconcile it. Other independent approved items may continue.
4. Keep execution notes in an agreed private location outside sealed runs and
   published documentation. Never edit/reseal evidence or
   rewrite a verdict. Do not expose credentials in reports.

## Execute And Validate

Process dependencies first. For each item, preview the intended diff, make the
smallest approved edit, and run its project-owned focused validation. Record
the command, exit status, evidence, and result. Do not broaden scope or weaken
contracts merely to make a test pass. If validation fails, investigate within
the approved scope; otherwise mark the item blocked. Revert only your own
exact edit if it can be undone without touching anyone else's work; never use
a file-wide rollback against a shared dirty file.

Run the applicable project suite after targeted checks. Check safety first:
tests can mutate Docker, databases, or remote systems. Request authorization
for effects outside the approved plan. Report skipped tests and limitations.

For the harness development loop:

```bash
npx release-harness run-local --allow-dirty --evidence-dir <external-root>
```

Read `<external-root>/runs/<id>/verdict.json`, its sibling `run.manifest.json`,
and sealed files under `<external-root>/runs/<id>/evidence/`. Use the new ID
printed by the CLI. If no verdict exists, report diagnostics and that absence.
Inspect retained startup observations when scenarios never started; raw logs
may be omitted for secret safety. Route causes:

- `PRODUCT_BUG`: fix only an observed product defect within the approved plan.
- `HARNESS_FIXTURE_MISSING`: obtain the approved fixture or dependency.
- `HARNESS_CONFIGURATION` / `HARNESS_ENVIRONMENT`: repair the identified fault.
- `UNKNOWN` on exit 3: attribution is unresolved; gather diagnostics, not a
  speculative product change.
- Exit 2: inspect underlying failed scenarios, unmet conditions and waivers;
  a dirty run is NON-CERTIFYING, not certified success.
- Exit 4: preserve the entire run and investigate. No blind cleanup, evidence
  edits, resealing, or bypasses. Harness/evidence faults remain exits 3/4 even
  during dirty development.

Only after underlying results pass and the human authorizes committing the
approved changes, request/run clean certification without `--allow-dirty`.
Committing unrelated user changes is never implied. The deterministic CLI is
the sole verdict authority; an execution report cannot certify a release.

## Report

Write an execution report in that private assessment location with per-item status
(`applied`, `blocked`, `failed`), changed files, commands and exact results,
new run ID, deterministic verdict, and remaining conditions. If a commit or
clean run is not authorized, report successful development validation as
non-certifying and stop. No push, PR creation, merge or deployment is implied.
