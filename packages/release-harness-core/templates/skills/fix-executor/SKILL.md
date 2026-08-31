---
name: fix-executor
description: Executes an approved execution-plan.json item-by-item — previews the diff, applies, validates, and rolls back on failure — with a final full-suite release gate. Produces an execution report. Use for "execute fixes", "apply fix plan", "implement fixes", or "run fix plan".
compatibility: Requires execution-plan.json from fix-plan-consolidator. Project-specific build and test tools must be available.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Edit
  - Create
---

## Purpose
This skill applies an approved `execution-plan.json` in a controlled, auditable way. It favors small reversible steps, targeted validation, and explicit rollback whenever a fix introduces instability.

## Pre-flight
1. Load `execution-plan.json`.
2. Verify each referenced file exists and is writable.
3. Check `git status` is clean. If the working tree is dirty, stop and ask the operator to commit or stash changes first.
4. Create a restore point using `git stash push -m "fix-executor-backup"` or record the current `HEAD`.
5. Detect project tooling: package manager, lint command, type checker, test runner, and build command.
6. Refuse to modify files outside the project root.

## Execution Loop
Process items in `execution_order`.

### Step 1: Preview
- Show a diff preview before editing files.
- Display item metadata: severity, effort, affected files, and dependencies.
- Confirm dependencies are already marked complete.
- If a dependency is unresolved, mark the item as `blocked` and continue.

### Step 2: Apply
- Update only the files listed in `affected_files` unless the fix clearly requires tightly related support files.
- Use `suggested_fix` as guidance, not as unvalidated source text.
- Keep changes minimal and localized.

#### Common applications
- **Design fixes:** update CSS variables, theme tokens, layout classes, or component props.
- **Security fixes:** add sanitization, remove unsafe logging, tighten auth and input checks.
- **Coverage fixes:** add or extend tests aligned with the impacted component or flow.
- **Performance fixes:** reduce work in render, optimize imports, lazy-load heavy paths.
- **Config fixes:** update package scripts, TypeScript config, Docker, or environment handling.

### Step 3: Validate
Run `scripts/validate-fix.py --fix-id <id> --affected-files <comma-separated-files> --project-dir <root> --output <report>`.

Validation goals:
- **Lint:** target the affected files if the tool supports file-scoped execution.
- **Type check:** run `tsc --noEmit` when TypeScript is present.
- **Tests:** run related tests with Jest or Vitest when available.
- **Build:** perform a quick build or smoke validation when the project tooling makes that practical.

Expected report shape:

```json
{
  "fix_id": "consolidated-001",
  "lint": { "pass": true, "errors": [] },
  "types": { "pass": true, "errors": [] },
  "tests": { "pass": true, "errors": [], "summary": "1 related suite passed" }
}
```

### Step 4: Decide
- If all validations pass, mark the item `done`.
- If validation fails, attempt **one** safe auto-fix such as lint auto-fix or a straightforward type correction.
- Re-run validation once.
- If the item still fails, roll back the affected files and mark the item `failed`.
- Record the failure reason and validation output in the execution report.

### Step 5: Progress
- Update the plan status after every item.
- Report running totals such as `Applied 5/12 fixes (3 done, 1 skipped, 1 failed)`.
- If three or more consecutive items fail, pause for user confirmation before continuing.

## Final Gate
After processing all items:
1. Run full lint (`npm run lint` or equivalent) when available.
2. Run full type check (`tsc --noEmit`) when available.
3. Run the full test suite (`npm test` or equivalent) when available.
4. If the final gate fails, summarize likely culprit fixes and offer a rollback to the restore point.

## Output
Produce a markdown execution report similar to the following:

```text
## Fix Execution Report

| # | Fix | Status | Validation | Time |
|---|-----|--------|------------|------|
| 1 | SQL injection fix | ✅ Done | lint ✅ types ✅ tests ✅ | 12s |
| 2 | Color contrast | ✅ Done | lint ✅ types ✅ tests ✅ | 8s |
| 3 | Add user test | ❌ Failed | lint ✅ types ❌ tests — | 15s |

Applied: 8/12 | Skipped: 2 | Blocked: 1 | Failed: 1
Final gate: ✅ All passing
```

Also include:
- before/after evidence for each applied fix
- rollback details for failed fixes
- recommendations for blocked or manually intensive items

## Gotchas
- Never touch files outside the project root.
- If `package.json` or a lockfile changes, run the appropriate install command before validating.
- CSS or token changes should usually be followed by another UX review.
- Database migrations are high-risk and may require manual approval before execution.
- If no automated tests exist, rely on lint plus type checks and note the limitation clearly.
- In monorepos, run validation in the correct package directory rather than the repo root.

## Safe Execution Checklist
1. Confirm restore point exists.
2. Verify dependency order.
3. Preview the diff.
4. Apply the smallest valid change.
5. Validate immediately.
6. Roll back on failure.
7. Run the final gate before declaring success.

## Pipeline Contract

Standard pipeline contract applies — see `references/pipeline-contract.md` (vendored into this skill's install). Deviation: unlike the read-only suite skills, this skill also edits source code in the repo itself, as required by the approved plan (see Working directory below). This skill's specifics:

### Working directory

- Source code edits happen in the repo, as required by the plan.
- All execution metadata goes under `./.quality-run/`. Never inside this skill's directory.

### Required input

- `results/<ts>/execution-plan.json` from `fix-plan-consolidator`, with your explicit "approved" message recorded in the run context.

### Outputs this skill produces

- **Artefacts:** none.
- **Results:** `results/<ts>/execution-report.json` (per-item status: `applied` / `skipped` / `blocked` / `failed`), `results/<ts>/execution-report.md`, `results/<ts>/execution-evidence/` (per-item diffs, validation logs, rollback notes).

### Hard rules

- Only run after the operator explicitly approved the `execution-plan.json` produced earlier in the SAME current run.
- Process items one at a time in `execution_order`. Per-item rollback on validation failure. Never leave a half-applied fix in the working tree.
- After all items, run the full lint / type-check / test suite as a release gate. Record pass/fail.
- Never modify files outside the project root.
- **Worktree-only (no remote mutation).** Forbidden commands: `git push` (any form), `git push --force`, `git push --tags`, `gh pr create`, `gh pr merge`, `az repos pr create`, `az repos pr update`, `git remote add`, `git remote set-url`. Final state = local commits or staged / working-tree changes only. If the operator wants the changes published, print the manual command they should run themselves at the end — never run it.

### Gates

- If three or more consecutive items fail, pause and request user confirmation before continuing.
- If the final gate fails, summarize likely culprit fixes and offer rollback to the restore point. Do not declare success.
- If any execution-plan item proposes a remote-mutating command, mark it `blocked` with reason `remote-mutation-forbidden` and continue with the rest.
