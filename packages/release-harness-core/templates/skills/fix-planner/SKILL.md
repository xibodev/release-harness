---
name: fix-planner
description: Merges fix-plan.json files from all analysis runs into one deduplicated, prioritized, dependency-sequenced plan and presents it for user approval. Produces execution-plan.json for fix-executor. Use for "consolidate fixes", "merge fix plans", "what needs fixing", "show all issues", or "build fix plan".
compatibility: Requires fix-plan.json files from prior skill runs. Python 3.8+ for scripts.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

## Purpose
This skill turns multiple plugin-specific remediation outputs into one execution-ready plan. It is optimized for multi-signal quality reviews where design, test, runtime, and release findings overlap and need a single ordered backlog.

## Fix Plan Collection
1. Scan for `fix-plan.json` files in recent output directories such as `*_uuid/fix-plan.json` or `*_<uuid>/fix-plan.json`.
2. Also accept explicit file paths supplied by the operator.
3. Load and validate every file against the shared schema before merging.
4. Report inventory clearly, for example: `Found 4 fix plans from: ux-design-review (8 items), e2e-playwright-test (5 items), docker-uat-runner (2 items), preprod-release-check (3 items)`.

## Deduplication
Run `scripts/merge-plans.py`.

### Merge rules
- Group items by normalized `affected_files`.
- Within a file group, compare `title` and `description` for semantic similarity.
- Treat overlapping findings from different plugins as one action item when they describe the same root issue.
- Keep the highest severity when duplicates disagree.
- Combine evidence from every source plugin.
- Preserve all contributing plugin names in `sources`.

### Example
- `Low contrast on CTA button` from ux-design-review
- `Button not visible in headed-e2e screenshot` from e2e-playwright-test
- Result: one consolidated issue with merged evidence and both plugins listed in `sources`

## Cross-Reference Analysis
After deduplication, add links across domains to surface fixes with cascading value.

### Common patterns
- **Design → E2E:** Layout, spacing, color, and visibility fixes can resolve visual or interaction failures.
- **Coverage → Code:** A missing-test finding may already be covered by a broader E2E scenario.
- **Security → Code:** One secure-by-default refactor can close multiple downstream issues.
- **Performance → UX:** Performance bottlenecks can explain flaky timeouts or degraded interactions.

### Output convention
Populate `related_items` with linked item ids, for example:

```json
"related_items": ["ux-003", "e2e-007"]
```

## Prioritization
Apply `references/priority-matrix.md`.

1. **Critical blockers** — security vulnerabilities, data loss, auth failures, release blockers.
2. **High** — broken user journeys, failing E2E coverage, WCAG violations, severe rendering defects.
3. **Medium** — design inconsistencies, moderate performance regressions, coverage gaps.
4. **Low** — minor polish, documentation mismatches, low-risk enhancements.

Within the same severity tier, do **quick wins first** so the team can remove blockers and gain momentum fast.

## Dependency Sequencing
Run `scripts/dependency-sort.py`.

### Sort rules
- Build a graph from each item's `dependencies`.
- Topologically sort the graph into a safe execution order.
- Prefer foundational changes first: database migrations → API changes → frontend updates → test updates.
- Flag circular dependencies for explicit user review.
- Group independent fixes into parallel batches where safe.

## User Presentation
Present the merged result in an approval-oriented format.

```text
## Consolidated Fix Plan (N items)

### 🔴 Critical (X items)
| # | Title | Source | Files | Effort | Dependencies |
|---|-------|--------|-------|--------|--------------|
| 1 | SQL injection in user query | preprod-release | src/api/users.ts | small | — |

### 🟠 High (Y items)
...

### 🟡 Medium (Z items)
...

### 🟢 Low (W items)
...

Total effort estimate: ~X hours

Approve all? Or select specific items to include/exclude?
```

### Presentation guidance
- Keep item titles concise and action-oriented.
- Show every contributing plugin in the source column when items were merged.
- Highlight dependency chains and parallelizable batches.
- Paginate or group large plans above 50 items.

## Output
Produce the following artifacts:
- `consolidated-plan.json` — merged, deduplicated, prioritized plan.
- `execution-plan.json` — approved subset sequenced for application.
- Consolidation report in markdown summarizing merges, conflicts, and ordering.
- Optional archive of original `fix-plan.json` files after approval.

## Shared Fix Plan Schema
```json
{
  "source": "<plugin-name>",
  "generated_at": "ISO-8601",
  "items": [
    {
      "id": "<source>-NNN",
      "severity": "critical|high|medium|low",
      "category": "design|performance|test-failure|security|coverage-gap|rendering",
      "title": "Short description",
      "description": "Detailed explanation with context",
      "affected_files": ["src/components/Button.tsx"],
      "suggested_fix": "Concrete fix description with code examples where possible",
      "effort": "small|medium|large",
      "dependencies": ["other-item-id"],
      "evidence": {
        "screenshot": "path",
        "metric": "value",
        "test": "test-name"
      },
      "related_items": [],
      "sources": ["ux-design-review"]
    }
  ]
}
```

## Gotchas
- Normalize paths before comparing because plugins may emit relative and absolute file paths for the same file.
- Severity scales differ across analyzers; always keep the highest severity when merging.
- Flag contradictory recommendations, such as one tool proposing an addition while another recommends removal.
- Preserve enough evidence to justify why the consolidated item exists.
- For very large plans, split presentation by severity and component area to keep approval manageable.

## Recommended Flow
1. Locate plans.
2. Validate schema.
3. Merge and deduplicate.
4. Add cross-references.
5. Prioritize and dependency-sort.
6. Present the plan for approval.
7. Write `execution-plan.json` for `fix-executor`.

## Pipeline Contract

Standard pipeline contract applies — working directory, `./.quality-run/` layout (artefacts vs results), worktree-only rules, and gate semantics per `references/pipeline-contract.md` (vendored into this skill's install). This skill's specifics:

### Required input

- Every `fix-plan.json` under `./.quality-run/results/<ts>/`. Discover them with a glob; do not require the operator to list them.

### Outputs this skill produces

- **Artefacts:** none.
- **Results:** `results/<ts>/consolidated-plan.json` (merged + deduplicated + prioritized), `results/<ts>/execution-plan.json` (approved subset, sequenced), `results/<ts>/consolidation-report.md`.

### Hard rules

- Include EVERY `fix-plan.json` found in the current run's results folder. Do not silently omit a source.
- Deduplicate by normalized `affected_files` + semantic similarity on title/description. On conflict, preserve the HIGHEST severity. Merge `evidence` and append every contributing plugin to `sources`.
- Do not invent items. Every entry must trace back to at least one input plan.

### Gates

- STOP after writing `consolidated-plan.json` and present the proposed execution plan to the operator. Wait for an explicit "approved" message before writing `execution-plan.json` as approved or invoking `fix-executor`.
- Do not auto-approve. Do not collapse the approval gate into a single message even if the plan is small.
