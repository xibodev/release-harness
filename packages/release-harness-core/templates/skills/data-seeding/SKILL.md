---
name: release-harness-data-seeding
description: >-
  Infers the app's data model and seeds the sealed-UAT database at
  believable scale via its own seeding path, binding entities to persona
  instances. Local-docker only — refuses live staging. Use after UAT is
  healthy and BEFORE E2E journeys run.
compatibility: >-
  Detects and uses the system's own seeding entrypoint (Rails seeds, Django
  fixtures/factories, Prisma seed, Sequelize seeders, raw SQL, custom
  npm/pnpm/poetry/uv scripts, MongoDB seed scripts, etc.). Requires the
  project's seed runtime and an authorized disposable local database.
  No inference or generator scripts ship with this playbook.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

# Data Seeding for UAT

An empty database can hide pagination, search, filtering, foreign-key and N+1 defects. Seed realistic synthetic data so product journeys and optional screenshot review can exercise those cases.

All assessment paths below are relative to an agreed private assessment root
outside sealed runs, the source repository and published documentation.

## When to run

- After the operator identifies an authorized disposable local Docker stack and
  its health and container-network isolation have been independently verified.
  Before product journeys run. `run-local` manages and tears down its own stack;
  configure project-owned startup seeding for that lifecycle, or use a separately
  authorized persistent local test stack. Do not assume a stack is still running.
- Record target identity, Compose project/service, disposable database, approved
  seed command and safety checks in the assessment's `results/<ts>/seed/detection.json`.
  Existing environment reports can supply evidence, but no external toolkit's
  `env.json` or persona-inference command is required.

## Hard rules

- **Mode lock:** refuse if local disposable target identity, write authorization
  or container egress isolation cannot be verified. Browser policy alone does
  not prove container isolation.
- **Use the system's own seed path.** Never bypass validation, hashing or event
  hooks with direct DB writes. If no seed entrypoint exists, propose one for
  review and stop before mutation.
- **Synthetic fixtures only.** Use the project's existing deterministic fixture
  generator; Faker is an optional separately installed integration, not a
  prerequisite. Do not import real PII or present synthetic values as business metrics.
- **No external network calls.** Use bundled placeholders or locally generated
  SVGs instead of remote images. Verify container isolation; browser policy
  alone cannot prevent a seed process from reaching external services.
- **Idempotent.** Use the project's documented repeat-safe behavior; do not
  assume it supports `--mode` or authorize data deletion by default.
- **Deterministic.** Use the project's supported fixed-seed mechanism and record
  the value. Do not assume its entrypoint accepts `--seed N`.
- **No real credentials, no real tokens, no real API keys.** Every secret-shaped field gets a clearly fake value (`uat-token-<uuid>`, `sk_test_uat_<hash>`).

## Step 1 — System detection

Identify the stack so the right seed entrypoint is used. Walk the repo for these signals (parallel search):

| Stack | Signal files | Canonical seed entrypoint |
|---|---|---|
| Rails | `Gemfile`, `db/seeds.rb` | `bundle exec rails db:seed` |
| Django | `manage.py`, `*/fixtures/*.json`, `*/factories.py` | `python manage.py loaddata` or factory-boy script |
| Prisma (Node) | `prisma/schema.prisma`, `prisma/seed.ts` | `npx prisma db seed` |
| Sequelize | `sequelize.config.js`, `seeders/` | `npx sequelize-cli db:seed:all` |
| TypeORM | `ormconfig.*`, `src/seeds/` | project-specific npm script |
| Knex | `knexfile.*`, `seeds/` | `npx knex seed:run` |
| Drizzle | `drizzle.config.*`, `drizzle/seed.ts` | project-specific npm/pnpm script |
| SQLAlchemy / Alembic | `alembic.ini`, `seed/*.py` | project-specific python script |
| Mongoose (Mongo) | `*.model.js` + `seed.js` | project-specific npm script |
| Raw SQL | `db/seed.sql`, `init/*.sql` | `psql -f` / `mysql <` inside the DB container |
| .NET EF | `*.csproj` with `Microsoft.EntityFrameworkCore`, `Data/Seed*.cs` | `dotnet run --project ... -- seed` or DbContext OnModelCreating seeders |
| Laravel | `database/seeders/*.php`, `artisan` | `php artisan db:seed` |
| Phoenix (Elixir) | `mix.exs`, `priv/repo/seeds.exs` | `mix run priv/repo/seeds.exs` |
| Custom | `package.json` scripts matching `/seed|fixture|bootstrap/` | invoke the npm/pnpm/yarn script |

Record the detected stack(s) and entrypoint command in `results/<ts>/seed/detection.json`. If multiple stacks are present (monorepo / microservices), seed each one.

If **no** seed entrypoint exists, STOP and write `results/<ts>/seed/fix-plan.json` with one `missing-seed-entrypoint` finding. Do not invent a seed path — that risks corrupting the schema.

## Step 2 — Entity inference

Discover the natural entities of the system from the ORM/schema files (NOT from the journeys — those reference entities, but the schema is the source of truth):

- Rails: parse `db/schema.rb` or `db/structure.sql`.
- Django: import models programmatically via `python manage.py inspectdb` or parse `*/models.py`.
- Prisma: parse `prisma/schema.prisma`.
- TypeORM / Sequelize / Mongoose: parse model class files.
- Raw SQL / EF / Laravel: parse migration files in creation order.

For each entity record:

```json
{
  "name": "User",
  "table": "users",
  "fields": [{"name": "email", "type": "string", "unique": true, "nullable": false}, ...],
  "relations": [{"to": "Order", "type": "has_many", "via": "user_id"}],
  "soft_delete": true,
  "timestamps": true,
  "polymorphic": false,
  "tenancy_scope": "tenant_id"
}
```

Persist `results/<ts>/seed/entities.json`.

## Step 3 — Volume plan

Sizing depends on the system's category and tested roles. Derive the required
users from product stories and scenario fixtures; an existing persona file is
optional input, not a prerequisite.

Choose `minimal`, `realistic` or `dense` with the operator based on scenario needs
and local resource limits. The tables below are examples, not CLI settings.
Record approved quantities in the assessment's `seed/volume-plan.json`.

### Generic SaaS (multi-tenant)

| Entity | minimal | realistic | dense |
|---|---|---|---|
| Tenant / Org | 2 | 5 | 15 |
| User | 10 | 50 | 200 |
| Role / Membership | 1 per user | 1 per user | 1–3 per user |
| Audit log entries | 0 | 200 | 2000 |

### E-commerce

| Entity | minimal | realistic | dense |
|---|---|---|---|
| Customer | 10 | 50 | 500 |
| Product | 20 | 100 | 1000 |
| Category | 3 | 8 | 30 |
| Order | 5 | 80 | 800 |
| OrderItem | ~2 per order | ~3 per order | ~4 per order |
| Review | 0 | 60 | 600 |
| Cart (active) | 2 | 10 | 50 |

### Content / CMS / Blog

| Entity | minimal | realistic | dense |
|---|---|---|---|
| Author | 2 | 8 | 30 |
| Post (published) | 5 | 40 | 400 |
| Post (draft) | 1 | 10 | 60 |
| Tag | 5 | 20 | 80 |
| Comment | 0 | 80 | 800 |
| Media asset | 5 | 30 | 200 |

### Social / Community

| Entity | minimal | realistic | dense |
|---|---|---|---|
| User | 10 | 60 | 300 |
| Follow edge | 20 | 250 | 2500 |
| Post | 20 | 200 | 2000 |
| Reaction | 50 | 800 | 8000 |
| Notification (unread) | 1 per user | 5 per user | 15 per user |

### Project management / Tickets

| Entity | minimal | realistic | dense |
|---|---|---|---|
| Project | 2 | 6 | 25 |
| User | 10 | 40 | 150 |
| Ticket / Issue | 10 | 120 | 1200 |
| Comment | 20 | 400 | 4000 |
| Label | 5 | 15 | 50 |
| Sprint / Milestone | 2 | 8 | 40 |

### Other categories

If none of the above categories match, derive a volume plan from the entity graph:
- Top-level / aggregate-root entities → `realistic` ≈ 50.
- Child / dependent entities → 2–5× parent count.
- Pure join tables → enough rows to make every parent have ≥1 child for most parents.

Record the chosen volumes in `results/<ts>/seed/volume-plan.json`:

```json
{
  "scale": "realistic",
  "category": "ecommerce",
  "volumes": {"Customer": 50, "Product": 100, "Order": 80, "OrderItem": 240, ...},
  "rationale": "Detected ecommerce category from Product/Order/Cart entities..."
}
```

## Step 4 — Edge-case coverage

A realistic dataset includes the rows that break naive code. Every seed run MUST include, where the schema supports it:

- **Empty-state rows** — at least 1 user with zero orders, 1 category with zero projects, 1 author with zero posts. So empty-state UI is exercised.
- **Boundary lengths** — 1 row with a 1-char name, 1 row at the column's max length.
- **Unicode + RTL** — at least 1 row with Arabic/Hebrew text (RTL), 1 with CJK characters, 1 with emoji in the displayable field.
- **Long-tail numeric** — at least 1 project priced at 0.01 and 1 at 999,999.99 (or the column's bounds).
- **Soft-deleted rows** — if `soft_delete: true`, at least 5% of rows should be soft-deleted. Surfaces filter-leak bugs.
- **Stale timestamps** — at least 1 row created >1 year ago, 1 created today. So "recent" UI sorting can be verified.
- **Inactive / disabled** — 1 disabled user, 1 archived project, 1 unpublished post. So permission gates are exercised.
- **Pagination boundary** — total row count must straddle a page boundary (e.g. if default page size is 20, seed 21+ rows). Halt the run with a finding if the inferred page size cannot be detected.

Record which edge cases were applied per entity in `results/<ts>/seed/edge-cases.json`.

## Step 5 — Persona-instance binding

Read project-owned personas/user stories and scenario fixture requirements.
An existing `artefacts/personas.json` is optional input. Derive a small persona
binding plan from those sources for review; ask only for non-derivable roles or
permissions. Every tested persona must bind to a real local seeded user.

For each persona instance:

1. Pick a seeded user matching the persona's role / permissions / tenancy.
2. Set deterministic credentials: email = `<persona-id>+<instance-idx>@uat.local`, password = `uat-<persona-id>-<instance-idx>` (hashed by the system's own seed path).
3. Pre-populate the operator with state appropriate to the persona variant:
   - `experience_state: returning_user` → backfill 3–10 prior interactions (orders, posts, tickets — whatever the entity graph supports).
   - `experience_state: power_user` → backfill 20+ interactions.
   - `experience_state: first_time_user` → no prior interactions.
4. Record the binding in `results/<ts>/seed/persona-bindings.json`:

```json
{
  "persona_id": "shopper-returning-desktop",
  "instance_idx": 0,
  "user_id": 42,
  "email": "shopper-returning-desktop+0@uat.local",
  "password_env_var": "UAT_PASSWORD_shopper_returning_desktop_0",
  "preconditions": {"orders_placed": 7, "reviews_left": 2, "cart_items": 1}
}
```

Synthetic local passwords go to the private assessment's `results/<ts>/seed/.env.passwords`
(written as `UAT_PASSWORD_<key>=<value>` lines). Restrict access; gitignore alone
does not protect a file from publication. Never echo passwords in other reports.

## Step 6 — Seed execution

1. Generate the seed payload using the system's preferred format (Rails factories, Django fixtures, Prisma seed script, raw SQL — match what the system uses).
2. Write the generated seed files into a transient `tmp/uat-seed/` directory inside the relevant service container. NEVER overwrite the project's own `db/seeds.rb` / `prisma/seed.ts` / etc.
3. Invoke only the approved project seed command with its documented arguments.
   The following are product-owned examples, not bundled scripts or commands
   to run blindly. Resolve actual service names, paths and runtime first:

   ```bash
   # Inside the app container
   bundle exec rails runner tmp/uat-seed/run.rb > /tmp/seed.log 2>&1
   ```

   ```powershell
   # From host: PRIVATE_ASSESSMENT_ROOT must be an approved directory outside the checkout.
   $seedLog = Join-Path $env:PRIVATE_ASSESSMENT_ROOT 'seed.log'
   docker compose -f docker-compose.test.yml exec -T app sh -c "bundle exec rails runner tmp/uat-seed/run.rb" > $seedLog 2>&1
   ```

   Restrict raw log access. Retain only reviewed, secret-safe diagnostics in the
   assessment report; do not add raw seed logs to the product repository.

4. Verify by counting rows for each top-level entity:

   ```bash
   docker compose -f docker-compose.test.yml exec -T db psql -U postgres -d app -c "SELECT 'users' AS t, count(*) FROM users UNION ALL SELECT 'orders', count(*) FROM orders;"
   ```

   Counts must match the volume plan ±5%. If off by more, halt and report — a constraint violation likely silently dropped rows.

## Step 7 — Output

Write to `results/<ts>/seed/`:

- `detection.json` — detected stack(s) + seed entrypoint(s).
- `entities.json` — discovered entity graph.
- `volume-plan.json` — chosen scale + per-entity counts + rationale.
- `edge-cases.json` — edge-case coverage per entity.
- `persona-bindings.json` — persona instance → seeded user mapping.
- `.env.passwords` — UAT_PASSWORD_* env vars (gitignored).
- `seed.log` — secret-safe diagnostics of the seed invocation only.
- `verification.json` — row counts after seeding.
- `seed.json` — top-level summary: `{ran: true, scale: "realistic", entities_seeded: 12, rows_total: 1247, persona_instances_bound: 8, duration_seconds: 14.2}`.
- `fix-plan.json` — any findings (categories: `missing-seed-entrypoint`, `seed-row-count-mismatch`, `unicode-column-rejected`, `pagination-boundary-undetectable`, `persona-binding-unfulfilled`).

## Failure modes & handling

- **Seed entrypoint crashes**: retain only secret-safe diagnostics, halt and
  report a finding. Do not fall back to direct DB writes or assume full stderr
  is safe to retain.
- **Unique-constraint collision on re-run**: compare documented idempotency
  behavior with the observation; do not assume a destructive replace mode.
- **Migrations not run**: report the missing prerequisite and propose the
  project's migration command for separate authorization against the verified
  disposable target. Do not infer permission from a seeding request.
- **Foreign-key violation** — generator created child before parent. Fix by topologically sorting entities before generation; record the ordering in `entities.json`.
- **Soft-delete column not detected** — produces 0% soft-deleted rows. Surface as low-severity `edge-case-coverage-gap` finding.
- **No persona file**: derive bindings from project stories/scenarios for
  approval; if insufficient, request the missing requirements rather than
  invoking an unshipped persona-inference tool.

## Gotchas

- Some apps eagerly send welcome emails on user creation. If mailhog is part of the sealed stack, those emails land in mailhog and are harmless. If the app routes via SendGrid/Mailgun client *without* a sealed mock, the seed run will hang or error — surface as a `sealed-uat-violation` finding and halt.
- Background workers may consume seeded entities. Include any scoped pause and
  restoration in the approved plan; do not pause arbitrary running services.
- ORMs with read-replicas will report stale counts during verification. Force a read against the primary.
- Multi-tenant apps with row-level security may refuse seed writes if the seed runner lacks tenant context. Use the system's documented "system user" or "seed user" identity.

All paths above are product-owned inputs, proposed fixture examples or assessment
outputs, not supporting files shipped by this skill. Write reports outside
sealed runs. Tool/target gaps must be reported; no package installation or
database/worker mutation is implied without authorization. Seed verification
does not certify a release: only the deterministic CLI adjudicates its verdict.
