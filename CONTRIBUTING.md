# Contributing

Contributions should include a clear description of the user-visible change and
tests for changed behavior. For suspected vulnerabilities, follow
[SECURITY.md](SECURITY.md) rather than publishing sensitive reproduction details.

## Repository Layout

| Path | Purpose |
|---|---|
| `packages/release-harness/` | Public npm facade and CLI entry point |
| `packages/release-harness-core/src/` | Contract identity, execution bindings, CLI, evidence sealing, and adjudication |
| `packages/release-harness-core/test/` | Core, CLI, self-adoption, platform, and regression tests |
| `packages/release-harness-schemas/` | Draft, contract, evidence, run, and verdict JSON schemas |
| `protocol/ADOPTION.md` | Canonical host-neutral adoption protocol |
| `tests/package/` | Packed-package installation and independent consumer tests |
| `docs/` | Public website sources and documentation assets |

## Setup And Validation

Use Node.js 20 and npm for the CI-tested baseline. Package metadata currently
declares Node.js `>=18`; do not infer a tested support matrix from that range.

The complete gate is `npm test`. It validates assertion-vocabulary generation,
schemas, core and public CLI behavior, failure attribution, evidence sealing,
self-adoption, Windows process bindings, and an independently packed and
installed consumer lifecycle. Passing a focused subset is not the full gate.
Report commands run, failures, and skipped coverage in your PR.

## Code And Template Changes

Keep changes focused and preserve unrelated work. The canonical adoption
protocol is `protocol/ADOPTION.md`; package preparation generates the installed
copy from it. Do not maintain another authored copy. Assertion kinds are defined
in `assertion-kinds-v1.json`; run `npm run test:vocab` after changing them so
draft and contract validators stay aligned.

Add regression tests for observable behavior, including invalid inputs and
chain verification when changing evidence or verdict logic. Gate outcomes must
remain deterministic; agent advice cannot substitute for evaluator results.

Before opening a PR, review the diff for accidental files, sensitive data,
unsupported claims, and broken links. Explain compatibility implications and the
validation performed. See [README.md](README.md) for the product scope and
[SECURITY.md](SECURITY.md) for its trust boundaries.
