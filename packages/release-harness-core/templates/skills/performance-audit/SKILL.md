---
name: performance-audit
description: Server-side performance audit covering database query patterns (N+1, missing indexes), caching strategy, API response time SLAs, code hotspots, and load-test readiness. Complements ux-design-review (which handles client-side Core Web Vitals). Inspired by the Production Ready Checklist's Performance section. Produces a fix-plan compatible with the suite's consolidator. Use when asked to "performance audit", "find N+1 queries", "check caching", "validate response SLAs", or before a release.
compatibility: Works with any source repo. Optional load probes `autocannon`, `k6`, `wrk`; ORM-specific log inspection if the app is running.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

## Purpose

Find the performance issues that actually matter at projection scale — backend hotspots, query patterns, missing caches, and missing SLAs — and produce a fix-plan, not vague advice.

## Audit areas

### 1. Database query patterns

- Detect ORM in use: Prisma, TypeORM, Sequelize, Mongoose, EF Core, Hibernate, ActiveRecord, Django ORM, SQLAlchemy.
- N+1 heuristic: for every model relationship used inside a `for`/`forEach`/`map` loop, flag if there's no `include`/`select_related`/`prefetch_related`/`eager` modifier on the originating query.
- Missing indexes: parse migration files; for every column referenced in a `WHERE` / `ORDER BY` of a discovered query, check whether an index is declared.
- Connection pooling: look for pool size config. Flag pools sized below CPU cores or unlimited.
- Query timeouts: look for `statement_timeout`, `lock_timeout`, ORM-level `maxQueryExecutionTime`. Flag if missing in projection config.

### 2. Caching strategy

- Detect cache layer: `redis`, `memcached`, `node-cache`, `lru-cache`, `Microsoft.Extensions.Caching`, Rails cache, Django cache.
- Cache invalidation: search for explicit `del`/`evict`/`invalidate` calls near write paths. Flag write paths with no invalidation pair.
- TTL discipline: flag `set` calls with no TTL on user-facing caches.
- HTTP caching headers on static assets: check for `Cache-Control` middleware/config.
- CDN integration: look for asset URL prefixes that suggest a CDN, or absence thereof.

### 3. API response time

- Detect API framework and route declarations.
- Flag endpoints that:
  - call `await` against a DB inside a loop;
  - serialize entire ORM models without a projection;
  - perform synchronous file I/O on request paths;
  - block on external HTTP calls without a timeout.
- Cross-reference: if the project has any SLA/SLO documented (search `SLA`, `SLO`, `p95`, `p99` in `docs/`), use those thresholds; otherwise recommend defaults (p95 ≤ 500 ms for read endpoints, ≤ 1 s for writes).

### 4. Code hotspots

- Detect synchronous CPU-intensive patterns: deeply nested loops, recursion without memoization, regex with catastrophic backtracking risk, JSON parsing of very large blobs on the request path.
- String concatenation in hot loops in older languages (Java/.NET): flag `String +=` inside loops; recommend `StringBuilder`.
- Identify large dependencies that are imported but barely used (`lodash` whole-package import when 2 helpers are needed, full `moment` when `date-fns` slice would do).

### 5. Frontend bundle (cross-check with ux-design-review)

- If a bundler config exists (`webpack`, `vite`, `next.config`, `rollup`), inspect for:
  - missing code splitting on heavy routes,
  - missing `dynamic`/`React.lazy` on heavy components,
  - inclusion of polyfills that target legacy browsers no longer required.
- Do not duplicate ux-design-review's CWV findings; reference them.

### 6. Load test readiness

- Check whether a load-test config/script exists (`k6/`, `loadtest/`, `bench/`, `*.k6.js`, `Jmeter*.jmx`).
- If `autocannon`/`k6`/`wrk` is installed AND a local app is running on a known port, optionally run a 30-second smoke probe against the busiest read endpoint. Otherwise emit a fix-plan item recommending the addition of a baseline load test.

## Output

- `./.quality-run/results/<ts>/performance/performance-report.md`
- `./.quality-run/results/<ts>/performance/findings.json`
- `./.quality-run/results/<ts>/performance/fix-plan.json`

### Fix-plan conventions

- `category`: always `performance`.
- `severity`:
  - `critical`: synchronous blocking call on auth/payment hot path; unbounded query; cache stampede risk on a key endpoint.
  - `high`: N+1 on a user-visible list endpoint, missing index on a frequently filtered column, no timeout on external call.
  - `medium`: missing TTL on a user-facing cache, oversized dependency import, missing code splitting on a heavy route.
  - `low`: stylistic perf hints, missing baseline load test.

## Hard rules

- Heuristics only — never claim a number unless you measured it. Use language like "likely N+1" until verified.
- Do not actually run load tests that would touch projection hosts. Localhost / staging only.
- If the running app or DB is unreachable, mark dynamic checks as `skipped:environment` instead of fabricating results.

## Gates

- Stop and surface `critical` findings before consolidation.
- If no load test exists AND a release is being prepared, emit at least one fix-plan item recommending a baseline load test.

## Pipeline Contract

Standard pipeline contract applies — working directory, `./.quality-run/` layout (artefacts vs results), worktree-only rules, and gate semantics per `references/pipeline-contract.md` (vendored into this skill's install). This skill's specifics:

### Outputs this skill produces

- **Artefacts:** none.
- **Results:** `results/<ts>/performance/performance-report.md`, `results/<ts>/performance/findings.json`, `results/<ts>/performance/fix-plan.json`.

### Hard rules

- Heuristics only; never report a number you didn't measure.
- Never run load tests against projection hosts. Local/staging only.
- Mark dynamic checks `skipped:environment` if the app/DB isn't reachable.
- **Sealed UAT — no internet.** Live probes are allowed ONLY against the in-network containerized app (`http://app:<port>`, or the host:port published by `docker-uat`'s `env.json`). Probes against any public URL or external host MUST NOT run — emit one `deferred-test` fix-plan item per such target (`category: "deferred-test"`, `severity: "info"`, `evidence.reason: "requires-internet"`, `evidence.what_to_run_offline: "re-run the perf probe outside the sealed run, or add a wiremock mapping if the dependency belongs to the catalog"`). Static analysis (N+1, slow query patterns) continues unchanged.

### Gates

- Stop and surface `critical` findings before consolidation.
- If preparing a release and no load-test baseline exists, emit at least one fix-plan item recommending one.
