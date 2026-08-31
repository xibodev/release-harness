# tiny-monorepo — the smoke fixture

A synthetic FastAPI + Next.js monorepo with deliberate detectable
defects spread across backend, frontend, docs, secrets, and tests.
The bundle's smoke harness invokes every skill against this fixture
and asserts each skill detects what it should.

## Do not "fix" the defects

Every defect listed below is intentional. The harness depends on
them being present. If you see a "bug" in this fixture, it is a
test asset, not a real bug.

## The defects

| Defect | Lives in | Should be detected by |
|---|---|---|
| SQL injection via f-string in login | `backend/tinyapp/routers/auth.py:18` | `security-audit` |
| Fake-prod-looking AWS key in env example | `.env.example:5` | `security-audit` |
| Destructive admin action (`delete_all_users`) with no structured-log event | `backend/tinyapp/observability.py:14` | `monitoring-audit` |
| Migration creates `items.owner_id` without an index, but `items.list` filters on it | `backend/alembic/versions/0001_init.py:24` + `backend/tinyapp/routers/items.py:12` | `database-readiness-audit` + `performance-audit` |
| Classic N+1 in `items.list` (per-item user lookup in the loop) | `backend/tinyapp/routers/items.py:14-20` | `performance-audit` |
| Icon-only button with no `aria-label` | `frontend/src/components/Button.tsx:8` | `ux-design-review` |
| Stale claim in product brief (mentions "OAuth login" but no OAuth code in fixture) | `docs/product/PRODUCT_BRIEF.md:9` | `documentation-drift-auditor` |
| `SECRET_FROM_ENV_EXAMPLE` used in env but missing from secret registry | `.env.example:7` + `docs/operations/SECRET_REGISTRY.md` | `documentation-drift-auditor` |
| 1 deliberately failing backend test | `backend/tests/test_main_fail.py:5` | `unit-integration-test` |
| 1 deliberately failing frontend test | `frontend/src/__tests__/items.test.tsx:5` | `unit-integration-test` |

## Shape

```
tiny-monorepo/
├── atlas.json
├── docker-compose.yml
├── docker-compose.test.yml
├── .env.example
├── .github/workflows/ci.yml
├── backend/
│   ├── pyproject.toml
│   ├── Dockerfile
│   ├── alembic.ini
│   ├── alembic/versions/0001_init.py
│   ├── tinyapp/
│   │   ├── __init__.py
│   │   ├── main.py
│   │   ├── db.py
│   │   ├── observability.py
│   │   └── routers/
│   │       ├── __init__.py
│   │       ├── auth.py
│   │       └── items.py
│   └── tests/
│       ├── test_main_ok.py
│       └── test_main_fail.py
├── frontend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── next.config.mjs
│   └── src/
│       ├── app/
│       │   ├── layout.tsx
│       │   └── page.tsx
│       ├── components/
│       │   └── Button.tsx
│       └── __tests__/
│           ├── page.test.tsx
│           └── items.test.tsx
└── docs/
    ├── product/PRODUCT_BRIEF.md
    └── operations/SECRET_REGISTRY.md
```

~25 files of synthetic but coherent product code. Small enough to
load mentally; large enough that every skill kind has something to
analyse.

## How to extend

When a new skill needs a smoke test:

1. Add a new deliberate defect to this fixture (one file or a small
   set), describing it in the table above.
2. Add the skill's entry to `../expected-artefacts.json`.
3. Write `../assertions/<skill>.assert.ps1`.
4. Wire the skill into `../run-all.ps1`.

When the fixture grows past ~50 files, consider splitting into
multiple fixtures (`tiny-monorepo`, `tiny-multirepo`,
`tiny-rebrand`) to avoid one fixture having to carry every defect.
