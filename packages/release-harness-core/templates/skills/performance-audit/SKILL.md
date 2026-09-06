---
name: release-harness-performance-audit
description: Reviews database query patterns, caching, API response objectives, code hotspots, frontend bundle configuration and load-test readiness. Produces evidence-linked findings for human review and release-harness-fix-planner. Measurements require separately authorized local tooling.
compatibility: Works with any source repo. Optional load probes `autocannon`, `k6`, `wrk`; ORM-specific log inspection if the app is running.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

## Purpose

Review performance risks at the product's intended production scale: backend
hotspots, queries, caches and response objectives. Distinguish measured results
from source-level hypotheses. All report paths below are relative to an agreed
private assessment root outside sealed runs, source and published documentation.

## Audit areas

### 1. Database query patterns

- Detect ORM in use: Prisma, TypeORM, Sequelize, Mongoose, EF Core, Hibernate, ActiveRecord, Django ORM, SQLAlchemy.
- N+1 heuristic: for every model relationship used inside a `for`/`forEach`/`map` loop, flag if there's no `include`/`select_related`/`prefetch_related`/`eager` modifier on the originating query.
- Missing indexes: parse migration files; for every column referenced in a `WHERE` / `ORDER BY` of a discovered query, check whether an index is declared.
- Connection pooling: look for pool size config. Flag pools sized below CPU cores or unlimited.
- Query timeouts: look for `statement_timeout`, `lock_timeout`, ORM-level `maxQueryExecutionTime`. Flag if missing in production config.

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

### 5. Frontend bundle

- If a bundler config exists (`webpack`, `vite`, `next.config`, `rollup`), inspect for:
  - missing code splitting on heavy routes,
  - missing `dynamic`/`React.lazy` on heavy components,
  - inclusion of polyfills that target legacy browsers no longer required.
- If the product supplies a Core Web Vitals report, record its tool, target and
  measurement scope and link relevant findings. That report is optional; source
  inspection alone cannot measure Core Web Vitals or certify frontend performance.

### 6. Load test readiness

- Check whether a load-test config/script exists (`k6/`, `loadtest/`, `bench/`, `*.k6.js`, `Jmeter*.jmx`).
- With an installed load tool and an explicitly authorized, verified disposable
  local target, propose a bounded read-only smoke workload and duration. Follow
  the target-isolation rules below before execution. Otherwise record the missing
  prerequisite and recommend a project-owned baseline test.

## Output

- `results/<ts>/performance/performance-report.md`
- `results/<ts>/performance/findings.json`
- `results/<ts>/performance/fix-plan.json`

### Fix-plan conventions

- `category`: always `performance`.
- `severity`:
  - `critical`: synchronous blocking call on auth/payment hot path; unbounded query; cache stampede risk on a key endpoint.
  - `high`: N+1 on a user-visible list endpoint, missing index on a frequently filtered column, no timeout on external call.
  - `medium`: missing TTL on a user-facing cache, oversized dependency import, missing code splitting on a heavy route.
  - `low`: stylistic perf hints, missing baseline load test.

## Hard rules

- Heuristics only — never claim a number unless you measured it. Use language like "likely N+1" until verified.
- Never run load tests against production or live staging; only authorized
  disposable local targets are in scope for this playbook.
- If the running app or DB is unreachable, mark dynamic checks as `skipped:environment` instead of fabricating results.

## Gates

- Stop and surface `critical` findings before consolidation.
- If no load test exists AND a release is being prepared, emit at least one fix-plan item recommending a baseline load test.

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
- **Results:** `results/<ts>/performance/performance-report.md`, `results/<ts>/performance/findings.json`, `results/<ts>/performance/fix-plan.json`.

### Hard rules

- Heuristics only; never report a number you didn't measure.
- Never run load tests against production or live staging. Disposable local only.
- Mark dynamic checks `skipped:environment` if the app/DB isn't reachable.
- Run dynamic probes only against an explicitly authorized disposable local
  target verified from project Compose configuration and runtime state. No
  external toolkit's environment report is required. Browser egress filtering
  does not isolate container or load-tool traffic. If tooling, a safe target or
  network isolation is unavailable, record a `deferred-test` finding with the
  missing prerequisite and continue static analysis; never probe public hosts.

### Gates

- Stop and surface `critical` findings before consolidation.
- If preparing a release and no load-test baseline exists, emit at least one fix-plan item recommending one.
