---
name: release-harness-database-readiness-audit
description: Audits database projection-readiness — schema integrity, migration safety, backup posture, replication/failover awareness, and RTO/RPO documentation. Inspired by the Production Ready Checklist's Database section. Produces a fix-plan compatible with the suite's consolidator. Use when asked to "audit database", "check migrations", "validate backups", "is the DB projection-ready", or before a release.
compatibility: Works with any source repo that contains migration files or database client config.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

## Purpose

Database readiness is one of the most common silent release blockers. This skill makes those gaps explicit and produces a fix-plan that the release-harness-release-decider can weight.

## Audit areas

### 1. Schema integrity

- Detect migration framework: Prisma migrate, TypeORM migrations, Knex, Liquibase, Flyway, EF Core migrations, Django migrations, Rails migrations, Alembic.
- For every migration file:
  - Flag `DROP TABLE`, `DROP COLUMN`, type narrowing changes, and `NOT NULL` additions without a default — these are blocking-risk operations.
  - Flag missing down/rollback migrations.
  - Confirm migration order is linear (no diverging branches).
- Verify foreign keys are declared on relationship columns (`REFERENCES`/`@Relation`/etc.).
- Verify `NOT NULL` and `UNIQUE` constraints are present on columns that look like business identifiers (`email`, `slug`, `external_id`).

### 2. Data integrity

- Detect transaction usage on multi-step writes: search for service methods that perform 2+ writes without wrapping them in a transaction.
- Flag cascading deletes (`onDelete: CASCADE`, `ON DELETE CASCADE`) on tables that hold financial or audit data — these usually need a soft-delete or restrict policy.
- Detect raw SQL outside the migration layer that bypasses ORM validators.

### 3. Backup posture

- Look for backup configuration:
  - `pg_dump` / `pg_basebackup` / `mongodump` scripts in `scripts/` or CI.
  - Cloud-provider backup policies (`backup_retention_period` in Terraform, AWS RDS automated backups, Azure SQL LTR policies, GCP Cloud SQL backups).
  - `cron` / scheduled jobs that ship dumps to a bucket.
- Verify:
  - Backups are encrypted (`--encrypt`, KMS reference, bucket has SSE enabled).
  - Retention is defined (≥ 7 days for daily, ≥ 30 days for monthly typically).
  - Restoration is documented (a runbook entry, not just a tool reference).

### 4. RTO / RPO

- Search `docs/`, `runbooks/`, `RUNBOOK*.md` for explicit RTO (recovery time objective) and RPO (recovery point objective) values.
- Flag absence — releasing without documented RTO/RPO is a release-blocking gap.
- If values are present, sanity-check them against the backup frequency (RPO cannot be smaller than the backup interval).

### 5. Replication & failover

- For relational DBs, look for read-replica config (Terraform `aws_db_instance_replica`, Azure SQL geo-replication, GCP read replicas).
- Detect application code that splits read vs write traffic (a `readDb`/`writeDb` pair, or a router).
- For document/distributed DBs (Mongo, Cosmos, Cassandra), check replica set / multi-region config in connection strings or infrastructure files.
- Flag absence of failover documentation when replication exists.

### 6. Operational hygiene

- Detect slow-query log enablement (`log_min_duration_statement` for Postgres, MySQL slow log).
- Detect connection pool monitoring exports.
- Detect disk-space alerts (cross-reference with release-harness-monitoring-audit).
- Verify projection credentials are NOT in source (cross-reference with release-harness-security-audit).

## Output

- `./.quality-run/results/<ts>/database/database-report.md`
- `./.quality-run/results/<ts>/database/findings.json`
- `./.quality-run/results/<ts>/database/fix-plan.json`

### Fix-plan conventions

- `category`: prefer `coverage-gap` for missing backups/replication/RTO docs; `performance` for missing indexes flagged here; `security` for credential leaks (and link to release-harness-security-audit).
- `severity`:
  - `critical`: destructive migration with no rollback path; no backup config detected; cascading deletes on financial data.
  - `high`: missing RTO/RPO docs; backup not encrypted; no transaction wrapping multi-step writes.
  - `medium`: no read-replica for a high-read app; missing slow-query log; missing indexes on frequently filtered columns.
  - `low`: stylistic schema hints, missing column comments.

## Hard rules

- Never propose to run a migration. Read-only analysis of migration files.
- Never attempt to connect to a real database from this skill — config scan only.
- If schema info isn't accessible (binary-only ORM, generated client without source migrations), note the limitation explicitly.

## Gates

- Stop and surface `critical` findings (destructive migration without rollback, missing backups) before consolidation.
- If RTO/RPO are not documented AND a release is being prepared, recommend NO-GO to `release-readiness` until they are documented.

## Pipeline Contract

Standard pipeline contract applies — working directory, `./.quality-run/` layout (artefacts vs results), worktree-only rules, and gate semantics per `references/pipeline-contract.md` (vendored into this skill's install). This skill's specifics:

### Outputs this skill produces

- **Artefacts:** none.
- **Results:** `results/<ts>/database/database-report.md`, `results/<ts>/database/findings.json`, `results/<ts>/database/fix-plan.json`.

### Hard rules

- Read-only analysis of migration files. Never propose to run a migration.
- Never connect to a real database. Config scan only.
- Note the limitation explicitly if schema info isn't accessible (binary-only ORM, no source migrations).

### Gates

- Stop and surface `critical` findings (destructive migration without rollback, no backup config detected) before consolidation.
- If RTO/RPO are undocumented AND a release is being prepared, recommend NO-GO to `release-readiness` until they are.
