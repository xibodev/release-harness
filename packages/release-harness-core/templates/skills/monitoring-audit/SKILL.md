---
name: release-harness-monitoring-audit
description: Validates that the application is observable in projection — error tracking, performance APM, health endpoints, structured logging, alerting, and on-call paths. Inspired by the Production Ready Checklist's Monitoring & Logging section. Produces a fix-plan compatible with the suite's consolidator. Use when asked to "audit monitoring", "check observability", "validate alerting", "is this app observable", or before a release.
compatibility: Works with any source repo. No runtime required; scans config and code.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

## Purpose

You cannot release what you cannot see. This skill verifies the project is wired to observe itself in projection — and produces a fix-plan for every gap.

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
- Confirm logs are JSON-formatted in projection paths.
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

- `./.quality-run/results/<ts>/monitoring/monitoring-report.md`
- `./.quality-run/results/<ts>/monitoring/findings.json`
- `./.quality-run/results/<ts>/monitoring/fix-plan.json`

### Fix-plan conventions

- `category`: prefer `coverage-gap` for missing observability wiring (since the consolidator's enum is `design|performance|test-failure|security|coverage-gap|rendering`).
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
- If no error tracking AND no health endpoint exist, recommend NO-GO to release-readiness regardless of other findings.

## Pipeline Contract

Standard pipeline contract applies — working directory, `./.quality-run/` layout (artefacts vs results), worktree-only rules, and gate semantics per `references/pipeline-contract.md` (vendored into this skill's install). This skill's specifics:

### Outputs this skill produces

- **Artefacts:** none.
- **Results:** `results/<ts>/monitoring/monitoring-report.md`, `results/<ts>/monitoring/findings.json`, `results/<ts>/monitoring/fix-plan.json`.

### Hard rules

- Never infer wiring from `package.json` alone. Always cross-check with an init call site.
- Do not invent alert rules that don't exist in the repo. Recommend them in the fix-plan.
- Respect explicit opt-outs documented in `docs/` (downgrade severity to `low` with a note).

### Gates

- Stop and surface `critical` findings (no error tracking, no health endpoint, no on-call path) before consolidation.
- If no error tracking AND no health endpoint exist, recommend NO-GO to `release-readiness` regardless of other findings.
