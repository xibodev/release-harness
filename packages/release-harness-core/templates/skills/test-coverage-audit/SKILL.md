---
name: test-coverage-audit
description: Maps code changes to existing test coverage, identifies untested new code paths, and cross-references with E2E test results from e2e-playwright-test if available. Produces a gap analysis showing which user journeys are uncovered by recent changes, with fix-plan entries recommending specific tests to write. Use when asked to "check coverage", "what's untested", "coverage gaps", or "test audit".
compatibility: Works with any Node.js project. Enhanced with Jest/Vitest coverage reports if available.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

## Purpose

Use this skill after `code-change-review` or alongside it. The goal is to measure confidence in changed code, not to report a generic repository-wide coverage percentage.

## Coverage Discovery

1. Detect existing coverage tooling:
   - Jest with `--coverage`
   - Vitest
   - `c8`
   - `nyc` / Istanbul
2. If coverage config or scripts exist, run the project-native coverage command and parse the generated report.
3. If no coverage tool exists, fall back to static analysis:
   - inspect test file naming conventions
   - map changed source files to nearby tests
   - inspect changed exports/functions against test cases
4. Record whether the audit is based on executed coverage, static mapping, or a hybrid approach.

## Required Inputs

Use the changed-file inventory from `code-change-review` when available. If it does not exist yet, derive the changed source files from the same git baseline.

## Change-to-Test Mapping

For every changed source file:

1. Find likely test files:
   - `<file>.test.ts`
   - `<file>.spec.ts`
   - `__tests__/<file>.ts`
   - adjacent integration or API tests that reference the module
2. Identify changed exports, handlers, hooks, reducers, or functions.
3. Inspect test files for direct coverage of those changed symbols or scenarios.
4. If no matching tests exist, flag the file as uncovered.
5. Report each mapping as:
   - `file`
   - `changed_functions`
   - `test_file`
   - `covered_functions`
   - `gap_functions`

When exact symbol matching is difficult, use scenario-level descriptions rather than guessing.

## E2E Cross-Reference

If `headless-report.json` or `headed-uat-report.json` exists:

- map changed routes, pages, or journeys to E2E coverage
- identify changed pages with no journey coverage
- record pass rate, failures, and flaky tests separately
- note that E2E coverage supports integration confidence but does not replace unit coverage

Helpful signals include:

- route names or page objects referenced in Playwright specs
- changed selectors or user journeys that coincide with E2E failures
- added routes or flows with no matching journey at all

## Gap Analysis

Classify gaps by release risk.

| Risk | Definition | Examples |
| --- | --- | --- |
| Critical | Changed auth, payment, permissions, or data mutation path with no meaningful automated coverage | login callback logic, billing mutation, delete endpoint |
| High | New endpoint or service logic without integration tests | API route with validation and persistence logic |
| Medium | UI or state changes missing component, interaction, or journey coverage | complex component refactor, reducer update |
| Low | Config or docs changes, or simple presentational edits with limited blast radius | README update, static copy change |

Escalate risk when multiple weak signals stack up, such as high churn plus no tests plus recent E2E failures.

## Coverage Audit Workflow

### 1. Source Inventory

Create a table of all changed source files and classify each as:

- backend logic
- frontend logic
- configuration
- tests only
- docs only

### 2. Symbol Coverage Check

For important changed files, inspect whether tests mention:

- exported function names
- route paths or handlers
- component names and interactions
- reducer actions and state transitions

### 3. Journey Coverage Check

For route or page changes, verify whether E2E suites cover:

- happy path
- failure or validation path
- auth or permission path when relevant

### 4. Recommendation Synthesis

For every gap, recommend the smallest high-value next test:

- unit test for pure logic
- integration test for API/service behavior
- E2E test for cross-page user flow
- regression test for a reproduced bug

## Output

Produce two artifacts.

### 1. Coverage audit report

Return markdown with:

- audit method used
- changed files in scope
- mapping table of changed files to tests
- uncovered functions or scenarios
- E2E cross-reference summary
- prioritized recommendations

### 2. `fix-plan.json`

Append entries such as:

- `Write unit test for order total rounding branch`
- `Add integration test for POST /sessions refresh flow`
- `Add E2E journey for checkout coupon failure`

Recommended shape:

```json
[
  {
    "id": "tests-orders-rounding-branch",
    "category": "coverage-gap",
    "severity": "high",
    "summary": "Write unit test for rounding edge case in order pricing",
    "test_type": "unit",
    "files": ["src/services/orderPricing.ts"],
    "blocking": false
  }
]
```

Include coverage percentage before/after only when tooling produced trustworthy numbers.

## Review Heuristics

- Changed code deserves more weight than untouched legacy files.
- Deleted tests are gaps unless clearly obsolete.
- Snapshot-only coverage is weaker than behavioral assertions.
- E2E coverage without unit or integration coverage is not enough for complex logic.
- Newly added files with zero tests should nearly always be mentioned.

## Pipeline Contract

Standard pipeline contract applies — working directory, `./.quality-run/` layout (artefacts vs results), worktree-only rules, and gate semantics per `references/pipeline-contract.md` (vendored into this skill's install). This skill's specifics:

### Outputs this skill produces

- **Artefacts:** none.
- **Results:** `results/<ts>/release/coverage.json`, `results/<ts>/release/coverage.md`, appends entries to `results/<ts>/release/fix-plan.json` (coverage-gap items).

### Hard rules

- When `results/<ts>/release/changes.json` exists (from `code-change-review`), reuse it instead of re-deriving the changed-file list.
- When `results/<ts>/e2e/headless/headless-report.json` or `results/<ts>/e2e/headed/headed-uat-report.json` exists in the SAME current run, MUST cross-reference E2E coverage against changed routes and pages.
- Record the audit method (executed coverage / static mapping / hybrid) explicitly in the report.

### Gates

- Do not report a single repository-wide coverage percentage as a substitute for changed-code coverage. If only repo-wide tooling is available, scope the percentage to changed files.
