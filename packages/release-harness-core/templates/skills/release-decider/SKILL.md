---
name: release-readiness
description: Aggregates code-change-review and test-coverage-audit results into a release readiness assessment. Computes a risk matrix across all change areas, generates a release notes draft (user-facing changelog), produces a pre-prod checklist (migrations, env vars, rollback plan), and delivers a Go/No-Go recommendation with supporting evidence. Use when asked to "release readiness", "go/no-go", "can we release", "pre-prod check", or "generate changelog".
compatibility: Requires code-change-review and test-coverage-audit outputs. Python 3.8+ for risk scoring.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

## Purpose

Use this skill to turn review evidence into a release decision. It should not re-run every deep inspection from scratch; instead, it should aggregate outputs, score risk, and produce a decision package a release manager can use.

## Input Aggregation

Load available artifacts from:

- `code-change-review`: change inventory and risk annotations
- `test-coverage-audit`: gap analysis and coverage percentages
- `e2e-playwright-test` results, if available: pass rates, failing journeys, flaky tests
- `ux-design-review` results, if available: release-facing UX issues

If an expected input is missing, continue with partial data and explicitly note the confidence reduction.

## Risk Scoring

Run `scripts/risk-scorer.py` to build a normalized risk matrix.

The scorer should evaluate at least these areas:

- backend
- frontend
- security
- infra/config

Risk factors include:

- change magnitude
- changed-code test coverage
- breaking changes
- security findings
- dependency or config changes

Interpret the aggregate result as:

- Low: `1-3`
- Medium: `4-6`
- High: `7-8`
- Critical: `9-10`

Include both the numeric score and the reasoning behind it.

## Release Notes Generation

Use `references/changelog-template.md`.

Build a user-facing changelog by:

1. parsing git log for conventional commits such as `feat:`, `fix:`, and `breaking:`
2. grouping entries under:
   - ✨ New Features
   - 🐛 Bug Fixes
   - 💥 Breaking Changes
   - 🔧 Improvements
3. falling back to diff-based summaries when conventional commits are absent
4. adding migration notes for breaking changes

Avoid internal-only wording when a user-facing explanation is possible.

## Pre-Prod Checklist

Use `references/release-checklist.md` as the master checklist.

Minimum checklist topics:

- database migrations ready and tested
- new environment variables documented and set in staging
- feature flags configured
- rollback plan documented
- monitoring and alerting updated
- API documentation updated
- cache invalidation evaluated
- CDN or asset purge evaluated

Auto-check items that can be verified programmatically. Leave uncertain items unchecked and explain the evidence needed.

## Go/No-Go Recommendation

Use these decision rules.

### GO ✅

Recommend **GO** when all are true:

- overall risk is at most Medium
- changed-code test coverage is at least 80% or equivalent strong evidence exists
- no critical security findings remain
- no untested breaking changes remain

### CONDITIONAL GO ⚠️

Recommend **CONDITIONAL GO** when release is plausible but dependent on explicit follow-up actions.

Examples:

- one or two high-risk gaps have a clear mitigation
- docs or env var setup is incomplete but can be fixed before rollout
- E2E failures are isolated and unrelated, but need owner sign-off

List the exact actions required before release.

### NO-GO ❌

Recommend **NO-GO** when any of these hold:

- critical risk score
- major untested changes in sensitive paths
- unresolved security findings
- breaking changes without migration or rollback plan

Support the recommendation with evidence from all loaded inputs.

## Output

Produce four deliverables.

### 1. Release readiness report

A markdown report containing:

- executive summary
- inputs loaded and confidence level
- risk matrix by area
- blocking findings
- recommendation with rationale

### 2. Release notes draft

Markdown changelog suitable for user or stakeholder review.

### 3. Completed pre-prod checklist

Use checked items only when evidence exists.

### 4. Aggregated `fix-plan.json`

Merge actionable items from all source skills and deduplicate similar entries.

Recommended entry shape:

```json
[
  {
    "id": "release-env-vars-staging",
    "category": "release-readiness",
    "severity": "high",
    "summary": "Document and set new env vars in staging before pre-prod deployment",
    "source": ["code-change-review", "release-readiness"],
    "blocking": true
  }
]
```

## Confidence Rules

- Lower confidence when a required input is missing or stale.
- Note when coverage numbers are inferred rather than measured.
- Separate release blockers from post-release follow-ups.
- Prefer evidence over intuition in the final recommendation.

## Pipeline Contract

Standard pipeline contract applies — working directory, `./.quality-run/` layout (artefacts vs results), worktree-only rules, and gate semantics per `references/pipeline-contract.md` (vendored into this skill's install). This skill's specifics:

### Required inputs

- `results/<ts>/release/changes.json` from `code-change-review`.
- `results/<ts>/release/coverage.json` from `test-coverage-audit`.
- When available: `results/<ts>/e2e/headless/headless-report.json`, `results/<ts>/e2e/headed/headed-uat-report.json`, `results/<ts>/ux/fix-plan.json`.

### Outputs this skill produces

- **Artefacts:** none.
- **Results:** `results/<ts>/release/risk-matrix.md`, `results/<ts>/release/release-notes.md`, `results/<ts>/release/preprod-checklist.md`, `results/<ts>/release/go-no-go.md`, appends to `results/<ts>/release/fix-plan.json`.

### Hard rules

- The Go / No-Go MUST cite at least one piece of evidence from each loaded input. Unsourced verdicts are not acceptable.
- If a required input is missing, continue with partial data but explicitly mark the confidence reduction in `go-no-go.md`.
- Release notes must be user-facing wording — no internal-only jargon.
- **Worktree-only (no fetch, no remote).** Require `results/<ts>/release/baseline.json` to exist and `remote_used == false`. If either is missing or `remote_used == true`, halt and refuse to issue a Go/No-Go. Never re-derive the baseline by hitting a remote.
- The pre-prod checklist MUST list the deploy commands the operator will run — it MUST NOT execute `git push`, `gh pr create`, `az repos pr create`, or any other remote-mutating command.

### Gates

- Never issue an unconditional GO when any `critical`-severity item from any source `fix-plan.json` is still open.
- Refuse to issue GO without an explicit rollback plan recorded in `preprod-checklist.md`.
- Refuse to issue GO if `baseline.json` is missing or `remote_used == true`.
