---
name: release-harness-monitoring-audit
description: Reviews production observability configuration including error tracking, APM, health endpoints, logging, alerting and on-call paths. Produces evidence-linked findings for human review and release-harness-fix-planner. Runtime delivery of telemetry requires separate verification.
compatibility: Works with any source repo. No runtime required; scans config and code.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

## Purpose

Review how the project is wired to observe itself in production and record gaps.
Source configuration is not proof that telemetry or alerts reach their targets.
All report paths below are relative to an agreed private assessment root outside
sealed runs, the source repository and published documentation.

## Audit areas

### 1. Error tracking

Look for one of:

- Sentry: `@sentry/node`, `@sentry/react`, `sentry-sdk`, `Sentry.init`
- Rollbar / Bugsnag / Honeybadger SDK references
- Application Insights: `applicationinsights`, `@microsoft/applicationinsights-web`
- Custom error reporting middleware

Verify:

- DSN/ingestion key is read from env, not hardcoded.
- Init runs early in the app lifecycle.
- Uncaught exception + unhandled rejection handlers are wired.
- Source maps upload step exists in CI if frontend errors are tracked.

### 2. Application performance monitoring (APM)

Look for:

- New Relic (`newrelic`), Datadog APM (`dd-trace`), AppDynamics, Dynatrace, Elastic APM, Honeycomb beelines, OpenTelemetry SDKs.

Verify:

- Auto-instrumentation is enabled.
- Service name + env tags are set.
- Trace sampling rate is sensible (not 100% in prod for high-traffic apps).

### 3. Health endpoints

- Search for `/health`, `/healthz`, `/livez`, `/readyz`, `/_health`, `/status` routes.
- Verify they actually check dependencies (DB ping, cache ping) rather than returning a static 200.
- Verify they're wired to load balancer / orchestrator health checks (look in `docker-compose*.yml`, `kubernetes/`, `helm/`).

### 4. Structured logging

- Detect logger: `winston`, `pino`, `bunyan`, `serilog`, `structlog`, `log4j2`, ASP.NET `ILogger`.
- Confirm logs are JSON-formatted in production paths.
- Confirm log level is configurable via env and defaults to `info` (not `debug`) in prod.
- Confirm correlation IDs / request IDs are attached to every log entry on the request path.
- Confirm sensitive fields are redacted (cross-check with release-harness-security-audit findings).

### 5. Centralized log shipping

- Look for `fluent-bit`, `vector`, `filebeat`, `winston-cloudwatch`, `pino-elasticsearch`, OpenTelemetry log exporters.
- For containerized apps, verify stdout/stderr is the log destination (so the orchestrator can collect).

### 6. Metrics

- Look for Prometheus exporters, `prom-client`, `micrometer`, `App.Metrics`, OpenTelemetry meter providers.
- Verify business metrics (not just system metrics) are emitted on critical flows.

### 7. Alerting

- Look for `alerts/`, `alertmanager*.yml`, `datadog_monitor.tf`, Sentry alert rules, New Relic alert config, GitHub Actions / Azure Pipelines alert hooks.
- Check coverage for the standard alert set:
  - high error rate
  - p95 latency regression
  - service down / synthetic check failure
  - database down / replication lag
  - disk / memory / CPU saturation
  - cert expiry

### 8. On-call & escalation

- Look for `oncall.md`, `runbooks/`, PagerDuty integration references, escalation policy docs.
- Flag absence — releasing without an on-call path is a release-blocking gap.

## Output

- `results/<ts>/monitoring/monitoring-report.md`
- `results/<ts>/monitoring/findings.json`
- `results/<ts>/monitoring/fix-plan.json`

### Fix-plan conventions

- `category`: use `coverage-gap` for missing observability wiring. This is an
  assessment label, not a CLI schema enum or an external-tool requirement.
- `severity`:
  - `critical`: no error tracking wired at all, no health endpoint, no on-call path documented.
  - `high`: APM missing, no structured logging, missing alert for high error rate, missing alert for service down.
  - `medium`: missing correlation IDs, missing business metrics, log level too verbose in prod.
  - `low`: missing source map upload, missing custom dashboards, missing cert-expiry alert.

## Hard rules

- Do not infer wiring from package.json alone — the dependency may be installed but never initialized. Always cross-check with an init call site.
- Do not invent alert rules that don't exist in the repo. Recommend them in the fix-plan instead.
- If the project has docs explicitly opting out of a category (e.g. "we don't use APM, we use logs + metrics"), respect that and lower severity to `low` with a note.

## Gates

- Stop and surface `critical` findings before consolidation.
- If no error tracking AND no health endpoint exist, record an advisory deployment
  blocker for human review with `release-harness-release-decider`.

## Pipeline Contract

This playbook is self-contained. Paths below are product-owned assessment inputs
and outputs under the agreed private assessment root, outside this skill,
sealed runs and published documentation. Use host file tools to record findings with `id`,
`severity`, `finding`, `affected_files`, `evidence` and `proposed_change`.
Missing tools/inputs are gaps, not passes. Do not install tools or mutate
source/remotes without approval. Only the deterministic CLI adjudicates;
audit findings and readiness recommendations cannot override its verdict.

### Outputs this skill produces

- **Artefacts:** none.
- **Results:** `results/<ts>/monitoring/monitoring-report.md`, `results/<ts>/monitoring/findings.json`, `results/<ts>/monitoring/fix-plan.json`.

### Hard rules

- Never infer wiring from `package.json` alone. Always cross-check with an init call site.
- Do not invent alert rules that don't exist in the repo. Recommend them in the fix-plan.
- Respect explicit opt-outs documented in `docs/` (downgrade severity to `low` with a note).

### Gates

- Stop and surface `critical` findings (no error tracking, no health endpoint, no on-call path) before consolidation.
- Include absent error tracking and health checks as advisory blockers in the
  readiness report, separately from the deterministic CLI verdict.
