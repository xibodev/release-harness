# Release-Harness Contributor Instructions

Read [CONTRIBUTING.md](CONTRIBUTING.md) for package layout, setup, template
ownership, and test prerequisites. Read [SECURITY.md](SECURITY.md) before changing
execution, networking, evidence collection, or verification.

## Deterministic Authority

Gate outcomes and cause classifications belong to the deterministic CLI and
evaluator. Agent playbooks author contracts and help investigate results; they
must not calculate, override, or claim a verdict without corresponding evidence.
Test replay, tampering, and invalid inputs when changing this boundary.

## Public Documentation Policy

Public content must help readers understand, install, use, evaluate, upgrade, or
contribute to Release-Harness. Describe current behavior, architecture, supported
use cases, APIs, security limits, and clearly labeled planned features.

Do not publish internal conversations, prompts from development sessions,
implementation diaries, agent-performance reports, pivots, rejected approaches,
unresolved release decisions, or operator coordination. This applies to tracked
files, README, changelog, website, packaged templates, and release notes. Keep
private working notes outside the tracked public repository, not merely outside
site navigation. Consumer-facing agent usage examples are product documentation,
not transcripts of our own development sessions.

Use neutral changelog entries: user-visible change, affected behavior, and action
needed. Preserve necessary compatibility and security disclosures without
narrating the investigation. Do not promise roadmap dates or shipped capabilities
without implementation and release evidence. Mark unreleased behavior explicitly.

The Pages artifact contains only files explicitly allowed by
`scripts/build-public-site.mjs`. Never upload all of `docs/` or add working notes
to the allowlist. A website exclusion does not make a tracked Git file private.

## Validation

Run `npm test` before delivery and report skipped coverage. For documentation,
also run `npm run test:docs` and `npm run build:site`; check links, copyable examples,
desktop/mobile rendering, and published-versus-unreleased claims. Preserve
unrelated work; never publish credentials, private evidence, or local notes.
