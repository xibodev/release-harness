---
name: release-harness-release-decider
description: Summarizes the deterministic release-harness verdict and review evidence into an advisory readiness report, release notes and rollback checklist. Never computes or overrides gate verdicts.
compatibility: Requires an identified release-harness run; source-review outputs are optional. Uses host file tools, not a bundled risk-scoring script.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

# Release Readiness Review

The deterministic CLI is the sole verdict authority. This skill summarizes its
result and documents operational blockers; it cannot certify a run, waive a
failed scenario, or turn a risk score into PASS. No supporting scripts, templates
or external workflow framework are required.

## Establish The Evidence

1. Obtain the exact evidence root and run ID from the conductor. Read
   `<root>/runs/<id>/verdict.json`, its sibling `run.manifest.json`, and sealed
   files under `<root>/runs/<id>/evidence/`. Record source SHA, execution mode,
   integrity, exit code, scenario summary and causes. Do not substitute an older
   passing run.
2. Ask the conductor to use the CLI's documented replay procedure when integrity
   needs verification. Reading JSON alone does not verify its seal. Do not edit
   evidence or claim a replay ran unless its output is available.
3. Inspect retained structured observations for startup failures. Raw startup
   logs may be omitted for secret safety. If no verdict exists, report its
   absence and available diagnostics without inventing attribution.
4. Load available source review, coverage, security, database and monitoring
   reports from this assessment. Record their paths, source/run identities and
   limitations. Missing or stale inputs are gaps, not success. Other toolkits'
   reports are optional, not packaged prerequisites.

## Readiness Rules

- Exit 0 with complete verified evidence and eligible clean-source execution
  is the CLI's certification, not this skill's calculation. Report it verbatim.
- Nonzero exit, invalid evidence, dirty development or missing verification
  blocks a certified-release recommendation. Never offer CONDITIONAL GO to
  bypass these conditions.
- Exit 1: distinguish observed `PRODUCT_BUG` from missing approved fixtures.
- Exit 2: retain underlying failures and unmet conditions; a dirty development
  pass is not certification.
- Exit 3: diagnose identified harness faults. `UNKNOWN` remains unresolved,
  not authorization for speculative product edits.
- Exit 4: preserve the entire run and investigate, not blind cleanup/resealing.
- Even after CLI PASS, security, rollback, migration or owner approvals may
  block deployment. State these as advisory operational blockers separately;
  never rewrite the CLI verdict.

## Risk Register And Checklist

Build a qualitative table: area, observation, impact, likelihood, owner and
action. Every row links to evidence. No numeric scoring algorithm or universal
coverage threshold ships with this skill. Report only measured percentages,
including scope and command, and distinguish hypotheses from observations.

Draft release notes from an approved local diff/log under Features, Fixes,
Breaking Changes, Migration Steps and Known Limitations. Confirm the local
baseline if ambiguous; do not fetch or invent commits.

For each applicable deployment checklist item record an owner and evidence:
migration/backup checks, environment variable names (never values), feature
flags, artifact identity, rollout, rollback command/trigger, monitoring/on-call
and post-deploy checks. Missing information is `requires-owner-input`, not a
checked box. Deployment commands are proposals requiring separate authorization.

## Outputs

Use host file tools to write outside sealed runs, for example under an agreed
assessment root's `results/<ts>/release/`:

- `go-no-go.md`: exact CLI verdict/provenance, verification, advisory blockers,
  evidence links, gaps and approvals.
- `risk-matrix.md`: qualitative register, not a gate score.
- `release-notes.md` and `preprod-checklist.md`: drafts for human review.
- `fix-plan.json`: findings with `id`, `cause`, `evidence`, `finding`,
  `affected_files`, and `proposed_change` for `release-harness-fix-planner`.

These are product-owned assessment outputs, not shipped support files. If the
host cannot write files, return the content for the conductor to persist and
report that limitation. No source mutation, commit, push, PR or deploy is implied.
