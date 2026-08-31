---
name: deployment-plan-generator
description: Generates a release-ready Deployment Plan, Rollback Procedure, and Post-Deployment Verification document, populated with project-specific signals (services, migrations, env vars, feature flags, owners). Inspired by the Production Ready Checklist's Deployment + Templates sections. Output is human-editable Markdown that a release manager can use as-is. Use when asked to "generate deployment plan", "draft rollback procedure", "write post-deploy verification", or as part of release-readiness.
compatibility: Works with any source repo. Reads code-change-review, database-readiness-audit, and monitoring-audit outputs if present.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

## Purpose

Most releases fail in execution, not in code. This skill produces the operational documents that make release execution boring — which is the goal.

## Required inputs

- `./.quality-run/results/<ts>/release/changes.json` from `code-change-review` (preferred). If absent, derive a minimal change list from the git baseline.
- Optional: `./.quality-run/results/<ts>/database/database-report.md` for migration hooks.
- Optional: `./.quality-run/results/<ts>/monitoring/monitoring-report.md` for verification steps.

## What it produces

### 1. Deployment Plan

Generate `./.quality-run/results/<ts>/release/deployment-plan.md` using the structure below, populated with the project's actual values:

```markdown
# Deployment Plan — <release-name or date>

## Deployment Information
- **Deployment Window:** <suggest a low-traffic window if telemetry hints exist, otherwise leave placeholder>
- **Expected Duration:** <estimate from change scope: small / medium / large>
- **Risk Level:** <derived from release-readiness risk matrix if present, else medium>
- **Strategy:** <blue-green | canary | rolling | recreate — chosen from infra signals>

## What's Being Deployed
<bulleted list of features/fixes parsed from conventional commits>

## Pre-Deployment Checklist
- [ ] All tests passing in CI
- [ ] Code reviewed and approved
- [ ] Database migrations tested in staging
- [ ] Feature flags configured
- [ ] Rollback plan ready (see rollback-procedure.md)
- [ ] Stakeholders notified
- [ ] On-call engineer briefed
- [ ] Deployment window communicated

## Deployment Steps
<numbered list, parameterised by the project. Examples to include where applicable:>
1. Take a fresh DB backup and confirm it lands in the configured backup store.
2. Run database migrations (`<command>`) and verify exit code.
3. Deploy app via `<pipeline>` to `<environment>`.
4. Toggle feature flags `<flag-list>` if applicable.
5. Validate health endpoints (`<endpoint-list>`) return 200.
6. Run smoke check journey from journey-mapping (if present).

## Verification
- See post-deploy-verification.md.

## Communication
- **Channel:** <slack/teams channel from repo docs, else placeholder>
- **Status Cadence:** every 15 minutes for the first hour, then hourly.
- **Escalation Contact:** <on-call entry from monitoring-audit if present>
```

### 2. Rollback Procedure

Generate `./.quality-run/results/<ts>/release/rollback-procedure.md`:

```markdown
# Rollback Procedure — <release-name>

## When to Rollback
- Error rate exceeds <threshold-from-monitoring-audit-or-default-1%> for > 5 minutes.
- p95 latency regresses by > 50% vs baseline.
- A critical user journey from journey-mapping fails health checks.
- Manual trigger by on-call engineer.

## Pre-Rollback
- [ ] Alert the on-call channel.
- [ ] Notify stakeholders.
- [ ] Capture the failing state (logs, screenshots, dashboards) before reverting.
- [ ] Confirm approval (one-person rule unless documented otherwise).

## Rollback Steps
<derived per deployment strategy:>
- **Blue-green:** flip traffic back to the previous environment via `<load balancer / DNS / pipeline command>`.
- **Canary:** abort the canary rollout via `<pipeline command>`; traffic shifts back automatically.
- **Rolling:** redeploy the previous image tag `<previous-tag>` via `<pipeline command>`.
- **Database:** if the release included a destructive migration flagged in database-readiness-audit, follow the documented down-migration; otherwise leave the schema forward-compatible.

## Post-Rollback Verification
- [ ] Application starts cleanly on previous version.
- [ ] Health endpoint(s) return 200.
- [ ] Error rate returns to baseline.
- [ ] Database state is consistent (run integrity checks if available).

## Post-Rollback Communication
- [ ] Update status page.
- [ ] Notify stakeholders that rollback completed.
- [ ] Schedule incident review within 24 hours.
```

### 3. Post-Deployment Verification

Generate `./.quality-run/results/<ts>/release/post-deploy-verification.md`:

```markdown
# Post-Deployment Verification — <release-name>

## Date: <iso-date>
## Deployed By: <git author of release tag, else placeholder>
## Version: <release tag>

## Infrastructure Checks
- [ ] All target instances running.
- [ ] Load balancer health checks passing.
- [ ] Database connectivity verified.
- [ ] Cache service responding.
- [ ] Background workers / queue consumers running.

## Application Checks
- [ ] Landing page loads (HTTP 200, no console errors).
- [ ] Authentication flow completes for a test user.
- [ ] Each critical journey from journeys.json executes end-to-end.
- [ ] APIs respond with expected schema (spot-check 3 endpoints).
- [ ] Logs show no unusual error patterns in the first 10 minutes.

## Performance Checks
- [ ] p50/p95 latency within SLA.
- [ ] Error rate within baseline.
- [ ] DB query times within baseline.
- [ ] Cache hit rates within baseline.

## Data Checks
- [ ] Migrations applied successfully.
- [ ] Sample read returns expected shape.
- [ ] Backups continuing on schedule.
- [ ] Replication lag within tolerance.

## Issues Found
<table to fill in during verification>
| ID | Description | Severity | Owner | Action |
|---|---|---|---|---|

## Approval
- [ ] Verified by: __________
- [ ] Timestamp: __________
```

## Hard rules

- Always emit all three documents, even when sections must be marked `TODO` because the source repo did not provide signals. An empty checkbox is more useful than a missing document.
- Never silently invent SLA thresholds. If no SLA is documented, mark the threshold as a default with a note.
- Cross-reference outputs from `monitoring-audit`, `database-readiness-audit`, `code-change-review`, and `journey-mapping` when present. Do not duplicate findings — link them.
- Never include real secrets, env values, or credentials in the generated documents. Use placeholders.

## Gates

- Stop and report if `code-change-review` results are absent AND no git baseline can be inferred. Do not produce a deployment plan from nothing.
- If the project has no rollback strategy detectable from infra files (no blue-green, no canary, no previous-image deploy command), still emit rollback-procedure.md but flag it as `requires-owner-input` and add a fix-plan item.

## Output (machine-readable companion)

- `./.quality-run/results/<ts>/release/deployment-plan.md`
- `./.quality-run/results/<ts>/release/rollback-procedure.md`
- `./.quality-run/results/<ts>/release/post-deploy-verification.md`
- Optional: `./.quality-run/results/<ts>/release/fix-plan.json` (appends items for gaps surfaced during generation).

## Pipeline Contract

Standard pipeline contract applies — working directory, `./.quality-run/` layout (artefacts vs results), worktree-only rules, and gate semantics per `references/pipeline-contract.md` (vendored into this skill's install). This skill's specifics:

### Outputs this skill produces

- **Artefacts:** none.
- **Results:** `results/<ts>/release/deployment-plan.md`, `results/<ts>/release/rollback-procedure.md`, `results/<ts>/release/post-deploy-verification.md`, appends to `results/<ts>/release/fix-plan.json` when gaps are found.

### Hard rules

- Always emit all three documents — `TODO` placeholders are better than missing files.
- Never invent SLA thresholds; mark defaults explicitly.
- Never include real secrets / env values / credentials in generated documents. Use placeholders.
- Cross-reference (not duplicate) findings from `monitoring-audit`, `database-readiness-audit`, `code-change-review`, and `journey-mapping`.

### Gates

- Stop if `code-change-review` results AND a git baseline are both unavailable.
- If no rollback strategy is detectable, emit `rollback-procedure.md` marked `requires-owner-input` and add a fix-plan item.
