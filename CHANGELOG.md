# Changelog

User-visible changes and upgrade considerations.

## 1.2.0-beta.1 — published 2026-09-13

[GitHub prerelease](https://github.com/xibodev/release-harness/releases/tag/v1.2.0-beta.1)

### Added

- Mutable draft and authoring-record workflows with explicit epistemic statuses:
  `observed`, `observed_absent`, `asserted_absent`, `inferred`, and
  `not_established`.
- Immutable accepted contracts named by canonical content digest. Exact
  normative references participate in contract identity; execution bindings do
  not.
- Certifying runs of accepted contracts and explicitly exploratory runs of
  drafts. Exploratory runs remain `UNPROVEN` even when every assertion holds.
- HTTP assertions for method, path, status, and deterministic body substrings.
- CLI assertions for direct command execution, exit status, stdout substrings,
  and stderr substrings. stdout and stderr remain separate sealed evidence.
- Verification of the contract, evidence, verdict, and links in a run's chain of
  custody.
- On-demand assertion vocabulary with field types through `draft kinds`.

### Changed

- The public lifecycle is now:
  `init → draft → validate → accept → bind → run → verify`.
- `init` installs harness-owned bootstrap state and the adoption protocol but
  does not infer a subject, port, URL, repository relationship, or assertion.
- Failure attribution is structural and conservative. Output text does not
  decide whether software receives a PRODUCT finding.
- Multi-repository adoption follows evidence-backed references rather than a
  topology registry or repository-role model.
- Canonical text identity uses UTF-8, LF line endings, and one trailing newline;
  other whitespace remains significant.
- Windows absolute executable paths and paths containing spaces are preserved
  through direct `shell: false` execution.

### Removed

- The prior topology/origins/scenario command surface, including `check-pr`,
  `run-local`, `evaluate`, and `clean`.
- Generated assumptions about project identity, browser applications, ports,
  origins, repository roles, and default smoke scenarios.

### Compatibility

This beta replaces the earlier contract shape and CLI. Existing
`topology.json`, `origins.json`, `harness.config.json`, and `scenarios/` files are
not consumed by the beta commands. Preserve any useful information while
reauthoring deliberate propositions; do not treat an old generated value as
established evidence.

The beta assertion vocabulary is intentionally limited to deterministic HTTP
and CLI propositions. A PASS covers only the accepted assertions and exact
references exercised by that run; it is not deployment approval.

See [BETA-RELEASE-NOTES.md](BETA-RELEASE-NOTES.md) and [README.md](README.md).

## 3.0.0-beta.1 — Unreleased

### Added

- Optional `init --with-agent` continuous lifecycle capability for Git-backed
  continuity across sessions, branches, worktrees, merges, and later releases.
- First-class baseline/change review artifacts with exact multi-source identity,
  complete assertion/reference impact mapping, and attributable confirmation.
- Deterministic `review start|validate|confirm|list` and
  `lifecycle status|check` commands.
- Exact source freshness derived from tracked file mode/blob/path manifests,
  excluding only `.release-harness/**`; no semantic path heuristics.
- Warnings when drafts, authoring records, accepted contracts, or reviews exist
  only in one checkout.
- One provider-neutral lifecycle capability with thin `.agents` and Claude
  adapters. Temporary workers may gather bounded facts but own no release
  semantics.

### Compatibility

- Plain `init` and deterministic contract execution remain available without
  Git lifecycle enforcement.
- Lifecycle-enabled certifying runs require current confirmed source coverage.
- Acceptance semantics are unchanged. Initial source coverage is a separate
  baseline review, not part of contract or acceptance identity.
- Legacy topology-era artifacts are detected and refused as migration evidence;
  they are not converted into claims automatically.
