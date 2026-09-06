---
name: release-harness-post-deploy-window-planner
description: Drafts a product-specific observation plan for the first 30 minutes and 24 hours after deployment, including owners, checks and rollback criteria. Use for post-deployment planning or after release-harness-deployment-plan-generator. Does not execute monitoring or deployment actions.
compatibility: Works with any source repo. Reads release-harness-monitoring-audit output when present.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

## Purpose

The hours after a deployment are when most incidents surface. This skill makes the observation window explicit, time-boxed, and owner-assigned.

All report paths below are relative to an agreed private assessment root outside
sealed runs, the source repository and published documentation. When audit inputs
are absent, inspect the project's monitoring configuration and ask the owner to
confirm targets, owners and thresholds. No external workflow agent is required.

## Required inputs

- Optional: `results/<ts>/monitoring/monitoring-report.md` for dashboards/alerts to reference.
- Optional: `results/<ts>/release/deployment-plan.md` for release metadata.

## What it produces

Generate `results/<ts>/release/post-deploy-window.md` with this structure, populated from project signals:

```markdown
# Post-Deployment Observation Window — <release-name>

## Window 1: First 30 minutes (active watch)

**Owner:** <on-call engineer from release-harness-monitoring-audit, else placeholder>
**Cadence:** continuous attention. No context-switching to unrelated work.

### What to watch
- Error rate dashboard: <link or placeholder>
- p95 latency dashboard: <link or placeholder>
- Health endpoint(s): <list from release-harness-monitoring-audit>
- Critical flow checks: <approved product-owned command, target and expected result for each flow>
- Recent log stream filtered to `level >= warn`.

### Tripwires (rollback triggers)
- Error rate > <threshold>% sustained for > 5 minutes.
- p95 latency regresses by > 50% vs the baseline captured before release.
- Any health endpoint returns non-200 for > 2 consecutive checks.
- Any approved critical product flow fails its documented acceptance checks.

### Decision points
- At T+15 min: confirm baseline is stable; report status to channel.
- At T+30 min: if all tripwires are clear, hand off to Window 2.

## Window 2: First 24 hours (passive watch)

**Owner:** on-call rotation. Pager rules unchanged from steady state.
**Cadence:** check at 1h, 4h, 12h, 24h.

### What to watch
- Error trend vs the previous 24h.
- Latency trend vs the previous 24h.
- Background job success rates.
- Queue depths.
- Database performance: slow query log diff, replication lag.
- External integrations: timeouts, error spikes from third-party APIs.

### Validation checkpoints
- [ ] T+1h: baseline drift acceptable; no new error class.
- [ ] T+4h: business metrics (signups, orders, etc.) within ±10% of baseline.
- [ ] T+12h: scheduled jobs ran (cron, nightly batches).
- [ ] T+24h: full diurnal cycle observed; no new alert categories triggered.

## Retrospective triggers

Schedule a release retrospective within 7 days if ANY of the following happen during the windows:

- A rollback was executed (planned or unplanned).
- A `critical` or `high` severity alert fired and was attributed to this release.
- A user-reported issue was attributed to this release.
- A tripwire was crossed but didn't lead to rollback (this is worth understanding).

If none of the above happens, no retrospective is required, but capture a one-paragraph "what changed, how it landed" note for institutional memory.

## Lessons learned capture

If a retrospective is scheduled, fill in:

```text
# Release Retrospective — <release-name>

## What changed
<one paragraph>

## What went well
- ...

## What went poorly
- ...

## Root causes (if applicable)
- ...

## Action items
| ID | Action | Owner | Due |
|---|---|---|---|

## Lessons to bake into the checklist
- ...
```
```

## Hard rules

- Choose dashboards from available audit evidence or verified project configuration;
  if neither supplies them, mark the gap. Never recommend "monitor everything".
- Tripwire thresholds default to: 1% error rate, 50% p95 regression. Override only when the project has documented SLOs (search `docs/` for `SLO`, `error_budget`, `latency_objective`).
- Owners must be real people or rotations. If release-harness-monitoring-audit shows no on-call wiring, mark `<unassigned>` and emit a fix-plan item.
- Never silently lengthen Window 1 beyond 30 minutes — that's the active-watch contract.

## Gates

- If release-harness-monitoring-audit reports `critical` (no error tracking, no health endpoint, no on-call path), refuse to mark the deployment plan as "ready to execute" and add a release-blocking fix-plan item.

## Output

- `results/<ts>/release/post-deploy-window.md`
- Optional: appends to `results/<ts>/release/fix-plan.json` when ownership or instrumentation gaps are surfaced.

## Pipeline Contract

This playbook is self-contained. Paths below are product-owned assessment inputs
and outputs under the agreed private assessment root, outside this skill,
sealed runs and published documentation. Use host file tools to record evidence-linked proposals.
Missing tools/inputs are gaps, not passes. Monitoring/deployment commands are
draft plans requiring separate authorization. Only the deterministic CLI
adjudicates; readiness recommendations cannot override its verdict.

### Outputs this skill produces

- **Artefacts:** none.
- **Results:** `results/<ts>/release/post-deploy-window.md`, appends to `results/<ts>/release/fix-plan.json` for gaps.

### Hard rules

- List only checks grounded in audit evidence or verified project configuration;
  absent audit reports do not require another agent, but missing facts remain gaps.
- Tripwire defaults: 1% error rate, 50% p95 regression. Override only when documented SLOs exist.
- Owners must be real people or rotations. If `release-harness-monitoring-audit` shows no on-call wiring, mark `<unassigned>` and add a fix-plan item.
- Window 1 is 30 minutes. Do not silently extend it.

### Gates

- If `release-harness-monitoring-audit` reports `critical` (no error tracking, no health endpoint, no on-call path), refuse to mark the deployment plan as "ready to execute" and add a release-blocking fix-plan item.
