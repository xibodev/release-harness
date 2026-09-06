---
name: release-harness-fix-planner
description: Derives an evidence-linked execution-plan.json from a release-harness verdict, startup evidence, and runtime diagnostics; presents targeted remediation for human approval.
compatibility: Requires release-harness run artifacts or recorded runtime diagnostics. No helper scripts required.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Write
---

# Release-Harness Fix Planner

Produce a small, reviewable remediation plan; do not change source or evidence.
The deterministic CLI alone adjudicates outcomes. Planning is not certification.
This skill is self-contained and requires no scripts or external pipeline files.

## Inputs And Triage

1. Obtain the evidence root and exact run ID from the CLI output. Read
   `<root>/runs/<id>/verdict.json`, `run.manifest.json` beside it, and sealed
   files under `<root>/runs/<id>/evidence/`. Do not search a guessed
   `evidence/run-*/run-summary.json` path or silently use an older run.
2. If the verdict is absent, report that and use recorded runtime diagnostics;
   never invent a verdict. Startup failures may have sealed structured
   observations before any scenario ran. Raw logs may be omitted for secret
   safety; inspect retained evidence before assigning a fix.
3. Read `run_integrity`, `certification_status`, `exit_code`, `causes`, scenario
   statuses, and the relevant evidence. Triage by cause, not exit code alone:
   - `PRODUCT_BUG`: propose a targeted product fix justified by an observation.
   - `HARNESS_FIXTURE_MISSING`: identify the missing approved input/dependency.
   - `HARNESS_CONFIGURATION` or `HARNESS_ENVIRONMENT`: diagnose the named
     contract, probe, build, toolchain, or runtime fault.
   - `UNKNOWN`: attribution is unresolved (exit 3); propose a bounded diagnostic
     probe, not a speculative product edit.
   - Exit 2: inspect failed scenarios and unmet conditions; dirty development
     is non-certifying even when all underlying scenarios pass.
   - Exit 4: preserve the entire run and investigate tampering/corruption. Do
     not edit, reseal, or blindly clean evidence to make it pass.
4. Inspect source only where needed to connect the observation to a fix. Do
   not weaken expectations, remove required scenarios, or relax policy merely
   to obtain exit 0. Legitimate contract corrections require an explicit diff
   and human review. Never claim browser egress filtering seals containers.

## Plan And Approval

Create `execution-plan.json` in an agreed private writable location outside sealed
runs and published documentation. This is an agent review note, not CLI config
(the calling agent may write it using its available file tool). Keep only
evidence-backed items; sort dependencies before dependents. Each item records:

```json
{
  "run_id": "the-exact-run-id",
  "evidence_root": "the-external-root",
  "approved": false,
  "items": [
    {
      "id": "fix-1",
      "cause": "PRODUCT_BUG",
      "evidence": ["runs/the-exact-run-id/verdict.json"],
      "finding": "Observed failure and source-level explanation",
      "affected_files": ["src/example.js"],
      "proposed_change": "Smallest justified change",
      "validation": ["project-owned focused test command"],
      "depends_on": []
    }
  ]
}
```

Replace example values with actual observations, paths, and project commands.
Diagnostics-only items can have no affected files. List unresolved attribution,
fixture acquisition, credential needs, and approval requirements separately.
Do not store secrets in the plan. Present its diff and wait for explicit human
approval before invoking `release-harness-fix-executor`; do not auto-approve.

Preserve unrelated working changes. No checkout, stash, commit, push, remote
mutation, or blanket `init --overwrite` is part of planning. Follow
`AI-ADOPTION.md` for paired slug changes, policy migration and targeted host
frontmatter repair.
