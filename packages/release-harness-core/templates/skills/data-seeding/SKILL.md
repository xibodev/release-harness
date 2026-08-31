---
name: data-seeding
description: >-
  Infers the app's data model and seeds the sealed-UAT database at
  believable scale via its own seeding path, binding entities to persona
  instances. Local-docker only — refuses live staging. Use after UAT is
  healthy and BEFORE E2E journeys run.
compatibility: >-
  Detects and uses the system's own seeding entrypoint (Rails seeds, Django
  fixtures/factories, Prisma seed, Sequelize seeders, raw SQL, custom
  npm/pnpm/poetry/uv scripts, MongoDB seed scripts, etc.). Python 3.8+ for
  the inference + generator scripts.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

# Data Seeding for UAT

Empty databases lie. An app with zero users, zero projects, and zero history looks deceptively healthy — pagination, search, filtering, empty states, foreign keys, and N+1 hotspots all stay hidden until there is real volume in the system. This skill makes the UAT environment feel inhabited so the rest of the gate (journeys, crawler, vision) can actually find what users will find.

## When to run

- AFTER `docker-uat` reports all services healthy AND sealed-network probes passed.
- BEFORE `headless-e2e`, `full-site-crawler`, or `headed-e2e`.
- Reads `results/<ts>/uat/env.json`. If `env.json.mode != "local-docker"`, **refuse to run** and write `results/<ts>/seed/seed.json` with `{aborted: true, reason: "data-seeding is local-docker only; staging is read-only"}`.

## Hard rules

- **Mode lock:** runs only when `env.json.mode == "local-docker"` AND `env.json.network_internal == true` AND `env.json.egress_blocked == true`. Sealed network is a precondition.
- **Use the system's own seed path.** Never bypass the app's validation / hashing / event hooks by writing directly to the DB unless the system has no seed entrypoint at all (rare). Bypassed seeds produce corrupt foreign keys, unhashed passwords, missing audit rows, and skipped soft-delete defaults — all of which look like UAT bugs later.
- **No fabricated metric values, PII, or copyrighted content.** Use `Faker` with a fixed seed for determinism. Names, emails, addresses, company names, project names, descriptions — all synthesized, none scraped from real datasets.
- **No external network calls.** Faker locally only. No `unsplash.com` / `picsum.photos` / `loremflickr.com` image fetches — use bundled placeholders or generate solid-color SVGs. The sealed network would block them anyway, but failing seed runs are noise.
- **Idempotent.** Re-running the seed against an already-seeded DB must either no-op or wipe-and-replay cleanly (configurable via `--mode replace|append|noop-if-present`). Never produce duplicate primary keys.
- **Deterministic.** Same `--seed N` value → same generated dataset. Required for reproducing bugs.
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

Sizing depends on the system's *category* and the persona variant count. Read `artefacts/personas.json` to know how many persona instances need to be backed by real seeded users.

Default volume tables (override via wizard Q `seed-scale` recorded in `run-config.json`: `minimal | realistic (default) | dense`):

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

Read `artefacts/personas.json`. Every persona instance MUST be backed by a real seeded user (so login + journey execution use real credentials, not fabricated ones).

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

Passwords go to `results/<ts>/seed/.env.passwords` (gitignored; written as `UAT_PASSWORD_<key>=<value>` lines). Never echo the raw passwords in any other report file.

## Step 6 — Seed execution

1. Generate the seed payload using the system's preferred format (Rails factories, Django fixtures, Prisma seed script, raw SQL — match what the system uses).
2. Write the generated seed files into a transient `tmp/uat-seed/` directory inside the relevant service container. NEVER overwrite the project's own `db/seeds.rb` / `prisma/seed.ts` / etc.
3. Invoke the canonical seed command with `--mode replace` (default) using file redirection per the PowerShell-pitfalls memory:

   ```bash
   # Inside the app container
   bundle exec rails runner tmp/uat-seed/run.rb > /tmp/seed.log 2>&1
   ```

   ```powershell
   # From host
   docker compose -f docker-compose.test.yml exec -T app sh -c "bundle exec rails runner tmp/uat-seed/run.rb" > seed.log 2>&1
   ```

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
- `seed.log` — stdout/stderr of the seed invocation.
- `verification.json` — row counts after seeding.
- `seed.json` — top-level summary: `{ran: true, scale: "realistic", entities_seeded: 12, rows_total: 1247, persona_instances_bound: 8, duration_seconds: 14.2}`.
- `fix-plan.json` — any findings (categories: `missing-seed-entrypoint`, `seed-row-count-mismatch`, `unicode-column-rejected`, `pagination-boundary-undetectable`, `persona-binding-unfulfilled`).

## Failure modes & handling

- **Seed entrypoint crashes** — capture full stderr, halt the run, emit `fix-plan.json` finding. Do NOT attempt direct DB writes as a fallback.
- **Unique-constraint collision on re-run** — `--mode replace` should have wiped first. If it didn't, the system has a bug in its own seed cleanup; report it.
- **Migrations not run** — the seed entrypoint will fail with "relation does not exist". Run migrations first (`rails db:migrate`, `python manage.py migrate`, `npx prisma migrate deploy`).
- **Foreign-key violation** — generator created child before parent. Fix by topologically sorting entities before generation; record the ordering in `entities.json`.
- **Soft-delete column not detected** — produces 0% soft-deleted rows. Surface as low-severity `edge-case-coverage-gap` finding.
- **No persona file present yet** — STOP. Seeding is downstream of `persona-inference`; the orchestrator invoked things out of order.

## Gotchas

- Some apps eagerly send welcome emails on user creation. If mailhog is part of the sealed stack, those emails land in mailhog and are harmless. If the app routes via SendGrid/Mailgun client *without* a sealed mock, the seed run will hang or error — surface as a `sealed-uat-violation` finding and halt.
- Background workers (Sidekiq, Celery, BullMQ) may pick up seeded entities and run jobs that mutate other tables. Run the seed with workers paused (`docker compose pause worker`), then unpause after verification.
- ORMs with read-replicas will report stale counts during verification. Force a read against the primary.
- Multi-tenant apps with row-level security may refuse seed writes if the seed runner lacks tenant context. Use the system's documented "system user" or "seed user" identity.
