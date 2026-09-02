---
name: release-harness-code-change-review
description: Reviews all code changes since the last release tag or specified baseline. Analyzes backend changes (API modifications, DB migrations, new dependencies), frontend changes (component updates, route changes, bundle impact), and performs a security quick-scan (new deps, hardcoded values, auth flow changes). Produces a structured change inventory with risk annotations and fix-plan entries. Use when asked to "review changes", "what changed since last release", "pre-release code review", or "diff analysis".
compatibility: Requires git repository with tags or release branches.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

## Purpose

Use this skill to build a release-focused diff review rather than a line-by-line code critique. The goal is to explain what changed, what could break, what needs follow-up, and what should block a pre-projection rollout.

## Baseline Detection

1. Find the last release candidate:
   - `git tag --sort=-v:refname | head -5`
   - Prefer the newest semver-like tag (`v1.2.3`, `1.2.3`, `release-2025.08`, etc.).
2. If tags do not exist or are not meaningful, ask the operator for a comparison base:
   - release branch
   - commit SHA
   - deployment date window
3. Show the operator the comparison scope before deep analysis:
   - `Comparing HEAD against <baseline> — N commits, M files changed. Proceed?`
4. Record the chosen baseline in the final report so downstream skills can reuse it.

## Diff Collection

Collect the baseline diff using the exact commands below:

```bash
git diff --stat <baseline>..HEAD
git diff --name-status <baseline>..HEAD
git log --oneline <baseline>..HEAD
```

Categorize every changed file into one primary bucket:

- Backend: `src/api/`, `src/server/`, `src/services/`, `routes/`, `controllers/`, `models/`, `migrations/`
- Frontend: `src/components/`, `src/pages/`, `src/views/`, `src/hooks/`, `src/styles/`, `public/`
- Config: `package.json`, `tsconfig.json`, `.env*`, `docker*`, `nginx*`
- Tests: `tests/`, `__tests__/`, `*.test.*`, `*.spec.*`
- Docs: `docs/`, `README*`, `CHANGELOG*`

Also annotate:

- added vs modified vs deleted files
- shared-package changes in monorepos
- generated artifacts that should be ignored during risk analysis
- lockfile-only changes that may still change supply-chain risk

## Backend Review

### API Changes

Check for:

- newly added endpoints, handlers, controllers, or route registrations
- removed or renamed endpoints
- request/response contract changes
- default value or validation changes that alter behavior without changing route shape

Flag as breaking when you find:

- removed response fields
- renamed routes or params
- stricter validation that can reject formerly valid requests
- semantic changes to status codes or pagination behavior

### DB Migrations

Inspect all new or changed migration files.

Look for:

- table or column renames
- destructive operations such as `DROP`, `TRUNCATE`, or narrowing type changes
- backfill assumptions
- ordering dependencies across pending migrations
- runtime coupling between app code and data migration timing

### Dependencies

Run:

```bash
git diff <baseline>..HEAD -- package.json
```

Capture:

- new direct dependencies
- major version bumps
- removed packages that imply replacement work
- build tooling changes that can alter generated output or deployment packaging

If dependency audit tooling is available, note any known CVEs or unresolved advisories.

### Business Logic

Prioritize functions with:

- high churn
- branching logic
- money, auth, state mutation, or queue processing
- concurrency or retry behavior
- caching or idempotency assumptions

Mark complex edits with a risk note even if no obvious bug is visible.

## Frontend Review

### Component Changes

Capture:

- new, changed, or deleted components
- prop contract changes
- changed loading, error, or empty states
- accessibility regressions introduced by markup restructuring

### Route Changes

Check for:

- newly registered routes
- removed pages
- path or nesting changes
- guards, redirects, and layout wrapper changes
- links from old routes that may now break

### Bundle Impact

Look for:

- newly imported large libraries
- removal of dynamic imports
- changed code splitting or lazy loading behavior
- new asset-heavy pages

### UI State

Inspect store, reducer, context, or hook updates for:

- state shape changes
- cache invalidation regressions
- optimistic update behavior
- hydration or SSR boundary changes if applicable

## Security Quick-Scan

Use targeted searches and dependency checks.

Inspect for:

- hardcoded secrets or tokens
- `eval`, unsafe HTML injection, raw SQL string assembly, or command execution paths
- disabled CSRF or overly permissive CORS settings
- auth flow changes in login, logout, session refresh, or permission checks
- new environment variables that are not documented or defaulted safely

Use `references/security-quick-scan.md` as the checklist and severity rubric.

## Output

Produce two artifacts.

### 1. Change inventory report

Return markdown with sections for:

- baseline summary
- commits in scope
- changed files by category
- backend findings
- frontend findings
- security findings
- release risks and recommended fixes

Each finding should include:

- area
- file or component
- risk level (`low`, `medium`, `high`, `critical`)
- why it matters
- recommended action

### 2. `fix-plan.json`

Create machine-readable entries for:

- breaking changes needing migration guides
- security findings needing fixes
- missing test coverage for changed code
- documentation updates needed

Recommended shape:

```json
[
  {
    "id": "backend-route-contract-change",
    "category": "breaking-change",
    "severity": "high",
    "summary": "Document renamed response field for orders API",
    "owner_hint": "backend",
    "files": ["src/api/orders.ts"],
    "blocking": true
  }
]
```

## Review Heuristics

- Prefer release impact over style commentary.
- Exclude generated output unless it signals a dependency or build change.
- Treat monorepo shared packages as fan-out risk.
- Flag new env vars without defaults as deployment blockers.
- Flag migrations that assume data shape already changed in projection.

## Gotchas

- Monorepo shared changes can silently affect multiple apps.
- Generated files should be excluded from the core review.
- Migration order matters when later migrations reference earlier schema work.
- New env vars without rollout documentation create deployment risk.
- Deleted tests can be as important as deleted code.

## Pipeline Contract

Standard pipeline contract applies — working directory, `./.quality-run/` layout (artefacts vs results), worktree-only rules, and gate semantics per `references/pipeline-contract.md` (vendored into this skill's install). This skill's specifics:

### Outputs this skill produces

- **Artefacts:** none.
- **Results:** `results/<ts>/release/changes.json` (machine-readable change inventory), `results/<ts>/release/changes.md` (human report), `results/<ts>/release/fix-plan.json` (release risks).

### Hard rules

- Baseline = newest meaningful release tag. If no tag exists, ASK the operator for an explicit baseline (tag, branch, SHA, or date window). Do not guess.
- Record the chosen baseline in the report so `release-harness-test-coverage-audit` and `release-readiness` can reuse it.
- Categorize every changed file into exactly one primary bucket (backend / frontend / config / tests / docs).
- **Worktree-only (no fetch, no remote).** Forbidden commands: `git fetch`, `git pull`, `git remote update`, any network-touching git operation. Forbidden references: any ref under `origin/`, `upstream/`, or any other remote namespace. The baseline MUST resolve to a LOCAL ref (sha, local tag, or local branch). If the requested baseline does not exist locally, STOP and ask the operator — do not fetch. Default baseline when none is specified: `git merge-base HEAD $(git config init.defaultBranch || echo main)` against the LOCAL branch only.
- Write `results/<ts>/release/baseline.json` recording `{ "ref": "<sha>", "resolved_via": "local-tag|local-branch|sha|HEAD~N", "remote_used": false }`. If `remote_used` would be `true`, halt.

### Gates

- Stop if the requested baseline is ambiguous or if `git diff` against it fails. Do not silently fall back to `HEAD~1`.
- Stop if the baseline can only be resolved by contacting a remote.
