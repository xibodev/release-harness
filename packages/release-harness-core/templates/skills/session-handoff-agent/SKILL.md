---
name: release-harness-session-handoff-agent
description: Records a portable evidence-linked handoff with current scope, working changes, exact run identity, results, blockers and next action. Optional coordination tools supplement the note.
compatibility: Requires host file read/write tools for persistence; optional coordination tools only when registered. No supporting scripts or reference templates required.
allowed-tools:
  - Read
  - Write
  - Bash
---

# Session Handoff

At phase boundaries or before restarting the host, record enough verified context
to resume without mistaking development evidence for certification. No external
template, memory convention or coordination server is required.

## Gather

Read the plan, `git status --porcelain`, `git rev-parse HEAD`, local branch and
staged/unstaged diffs as needed. Do not fetch. Separate agent changes from user
changes so the next session preserves them. If git is unavailable, mark unknown
fields instead of guessing.

Include the exact evidence root/run ID, CLI exit, integrity, execution mode and
source identity. Link `<root>/runs/<id>/verdict.json` and its sibling
`run.manifest.json` when present. Startup evidence contains only retained,
secret-safe observations; raw logs may be absent. State if no verdict exists.
Do not infer or override its outcome.

## Write

Choose a new note outside sealed runs. A suggested product-owned output is
`./.quality-run/session/<timestamp>/handoff.md`; choose an agreed external root
if repository immutability is required. Never overwrite another person's note
or shared pointer without authorization. Use these inline headings:

```markdown
# Session Handoff
## Identity
Timestamp, tool, workspace, branch, HEAD and assessment scope.
## Completed
Changes and evidence; commands actually run with exact results.
## Working Changes
Agent edits, unrelated user edits, and overlap constraints.
## Gate Evidence
Exact root/run ID, source identity, CLI verdict and verification limitations.
## Blockers
Missing tools/fixtures, unresolved attribution, approvals and skipped checks.
## Next Action
One concrete resumption step, then remaining approved work.
```

Never include credentials or raw potentially sensitive logs. Preserve exit-4
evidence without editing/resealing. A dirty run remains non-certifying even if
executed checks passed.

Optionally record the same summary and note path in an available coordination
service using its registered tools. If unavailable, retain the filesystem note
and report the limitation; do not invoke invented MCP names. If writing is
unavailable, return the note in the response and say it was not persisted.
No checkout, stash, commit, push or remote mutation is implied.
