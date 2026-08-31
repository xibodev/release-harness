---
name: session-handoff-agent
description: >-
  Captures a session handoff at every pause — brain checkpoint
  when reachable, ALWAYS a markdown note in
  docs/operations/SESSION_HANDOFF.md, so resume survives stale brain
  installs. Use for "checkpoint the session", "write a handoff note", or
  "before I run out of context".
compatibility: Filesystem read+write access; optional brain MCP tools when available.
allowed-tools:
  - Read
  - Write
  - Bash
  - mcp__brains__checkpoint
  - mcp__brains__capture_snapshot
  - mcp__brains__latest_checkpoint
  - mcp__brains__list_checkpoints
  - mcp__brains__store_memory
  - mcp__brains__retrieve_memory
---

<!--
last_verified: 2026-06-09T14:25-06:00
-->

# Session Handoff Agent

The bundle's continuity layer. Eliminates the "previous session ran
out of context, now I have to re-derive everything" pattern by
dropping a structured checkpoint at every meaningful pause.

## Purpose

A long task that spans context boundaries fails silently when the
operator can't recover what was half-done. The handoff agent makes
that recovery deterministic: every meaningful pause produces both a
brain checkpoint (queryable across sessions) and a markdown handoff
(readable when brain is offline). Either alone is sufficient to
resume; together they are belt-and-braces.

## Gotcha: brain MCP staleness

Optional brain MCP installs can go stale across
machines (for example, tool binaries update but agent registrations
don't refresh). **Do NOT treat brain as a hard dependency.** Probe
brain on every invocation; on any failure (tool not registered, tool
returns error, tool times out >2s), silently switch to the
filesystem-only path. Record the brain-unavailable status in the
handoff under `brain_status` so the operator can see when brain has
silently degraded.

This caveat is NOT a persisting rule about the operator's setup; it
is a defensive coding pattern that applies whenever this skill runs
anywhere.

## When to invoke

Mandatory pauses (the orchestrator MUST call this skill):
- After each phase boundary in a multi-phase task.
- Before any operation that takes >5 minutes wall-clock.
- When the operator says any LIGHTHOUSE-style resume keyword.
- When the operator says any variation of "checkpoint",
  "handoff", "save progress", "before I lose context".
- When the operator signals end-of-session ("ok bye", "ttyl",
  "going to sleep", "/clear" intent, "compact" intent).

Optional pauses (good hygiene; called by the operator on demand):
- After a single tricky commit that the operator wants documented.
- When switching between sub-tasks within a phase.

## What goes into a handoff

A handoff MUST capture these 12 fields. Anything missing → emit
`incomplete-handoff` warning; never block on it.

| Field | Source | Why it matters |
|---|---|---|
| `timestamp` | full ISO with timezone offset | Next session computes "how stale is this?" |
| `tool` | "claude-code" / "copilot-cli" / "codex" / "cursor" | Resume might use a different tool |
| `workspace_path` | `pwd` | Disambiguates multi-project setups |
| `branch` | `git rev-parse --abbrev-ref HEAD` | Where work happened |
| `head_sha` | `git rev-parse HEAD` (short) | Exact starting point for resume |
| `summary` | one-paragraph what-was-done | Human-readable resume hook |
| `next_action` | one sentence | The literal next thing to do |
| `blockers` | list (may be empty) | Why the operator paused |
| `unpushed_commits` | `git log @{u}..` short list | Catches "forgot to push" |
| `unstaged_changes` | `git status --porcelain` summary | Catches "forgot to commit" |
| `phase_status` | reference to plan.md or equivalent | Where in the phase tree we are |
| `brain_status` | "ok" / "unreachable: <reason>" | Operator visibility into brain health |

## Steps

1. **Probe brain MCP.** Try `mcp__brains__latest_checkpoint` with a
   2-second timeout. Set `brain_status` accordingly.
2. **Gather the 12 fields** via `git`, filesystem reads, and the
   operator-provided summary/next-action.
3. **Compose `handoff.json`** (structured) and `handoff.md`
   (operator-readable, follows the template at
   `references/handoff-template.md`).
4. **Write both files** to
   `./.quality-run/session/<timestamp>/`.
5. **If brain reachable:** call `mcp__brains__checkpoint` with the
   summary + next_action + blockers, then
   `mcp__brains__capture_snapshot` with kind="session-handoff" +
   the structured form.
6. **If brain unreachable:** append the handoff content to
   `docs/operations/SESSION_HANDOFF.md` (create with freshness header
   if missing). Each appended handoff is a `## <timestamp>` H2
   section so the file grows chronologically.
7. **Always emit `SUMMARY.md`** with operator-visible status: which
   path was taken (brain or filesystem), what was captured, any
   `incomplete-handoff` warnings.
8. **Update LIGHTHOUSE pointer.** When the workspace has a
   `memory/session_lighthouse.md` (per your project's convention),
   refresh it to point at this new handoff. The pointer is a
   FULL REPLACE per your project's refresh-discipline rule;
   stale layers are never appended.

## Outputs

```
./.quality-run/session/<timestamp>/
  handoff.md
  handoff.json
  brain-checkpoint.json     # only if brain was reachable
  SUMMARY.md
```

And one of:
- A brain `checkpoint` record + `capture_snapshot` snapshot (when
  brain reachable).
- An appended `## <timestamp>` section in
  `docs/operations/SESSION_HANDOFF.md` (when brain unreachable).

When `memory/session_lighthouse.md` exists, it is refreshed (full
replace) to point at the new handoff.

## Hard rules

- **Never block on brain.** 2-second timeout; degrade gracefully.
- **Never silently skip the brain check.** Always record
  `brain_status` so the operator sees when brain has gone stale.
- **Always emit BOTH the brain record AND the markdown** when brain
  is reachable. Belt-and-braces protects against future brain
  outages where the operator can no longer query past records.
- **Never overwrite an existing handoff.** Each handoff is a new
  timestamped directory.
- **Carry the freshness header** on `docs/operations/SESSION_HANDOFF.md`
  and update it on every append.
- **No AI authorship trailer** in any commit this skill triggers.
- **Resume path is contractually one tool call.** A future session
  must be able to run `mcp__brains__latest_checkpoint` OR read the
  LATEST `## <timestamp>` section of `docs/operations/SESSION_HANDOFF.md`
  and have everything it needs. This skill's quality is measured by
  whether that single read is sufficient.

## Gates

- Refuses to compose a handoff with empty `summary` AND empty
  `next_action`. At least one must be operator-provided. Refusal
  text: `aborted: handoff requires summary or next_action`.
- Refuses to write to `docs/operations/SESSION_HANDOFF.md` if the
  freshness header parser cannot find the existing header AND the
  file is non-empty — this protects against accidentally overwriting
  a doc that another tool owns.
- Emits warning (not abort) if `unpushed_commits` is non-empty and
  the operator did not explicitly mention them — catches "going to
  bed with un-pushed work" silent loss.

## Pipeline Contract

Standard pipeline contract applies — see `references/pipeline-contract.md` (vendored into this skill's install). Deviation: this skill uses the dedicated working directory below instead of the standard `artefacts/` + `results/<ts>/` split. This skill's specifics:

### Working directory

`./.quality-run/session/<timestamp>/`

### Required inputs

- Operator-provided `summary` AND/OR `next_action` (at least one).
- Optional `blockers` list.
- Optional `phase_status` path (defaults to `plan.md` in the
  session-state folder).
- Git access for the auto-gathered fields.
- Optional brain MCP tools.

### Outputs this skill produces

**Artefacts (reusable):**
- `handoff.md`
- `handoff.json`
- `brain-checkpoint.json` (only when brain reachable)
- `SUMMARY.md`

**Side effects (always):**
- One of: brain `checkpoint` + `capture_snapshot` record, OR
  appended section in `docs/operations/SESSION_HANDOFF.md`.
- When `memory/session_lighthouse.md` exists: full-replace refresh
  pointing at the new handoff.

### Hard rules (contract enforcement)

- MUST probe brain with a 2-second timeout and degrade gracefully.
- MUST record `brain_status` in every handoff for operator visibility.
- MUST emit BOTH the brain record AND the markdown handoff when
  brain is reachable.
- MUST write each handoff to a NEW timestamped directory; never
  overwrite.
- MUST carry the freshness header on
  `docs/operations/SESSION_HANDOFF.md`.
- MUST update LIGHTHOUSE pointer (full replace) when the file
  exists.
- MUST NOT make a `git push` or any remote mutation.

### Gates

- Refuses without summary AND next_action both empty.
- Refuses to write to a `SESSION_HANDOFF.md` whose freshness header
  is missing AND file non-empty.
- Warns (does not abort) on un-pushed commits the operator didn't
  acknowledge.
