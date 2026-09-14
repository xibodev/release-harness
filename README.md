# Release-Harness

[![CI](https://github.com/xibodev/release-harness/actions/workflows/validate.yml/badge.svg)](https://github.com/xibodev/release-harness/actions/workflows/validate.yml)
[![npm version](https://img.shields.io/npm/v/@xibodev/release-harness.svg)](https://www.npmjs.com/package/@xibodev/release-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Release-Harness certifies deliberately accepted release propositions with
deterministic evidence. A proposition names a subject, the HTTP or CLI assertions
that must hold, and any exact cross-subject contracts its meaning depends on.
Bindings say where to exercise it. Runs seal what was observed, adjudicate it
without AI, and leave a verifiable chain of custody.

Release-Harness **1.2.0-beta.1 is publicly available as a beta**. Stable
readiness remains intentionally unclaimed.

[Getting started](#getting-started) · [Release notes](BETA-RELEASE-NOTES.md) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## Install the beta

```bash
npm install -D @xibodev/release-harness@1.2.0-beta.1
```

Node.js 20 is the CI-tested baseline. Package metadata permits Node.js 18 and
later, but that range is not a claim that every version has equivalent coverage.

## Getting started

```text
init → draft → inspect / resolve questions → validate → accept → bind → run → verify
```

1. **Initialize without inventing a contract.**

   ```bash
   npx release-harness doctor
   npx release-harness init
   npx release-harness draft new example-tool
   ```

   `init` installs `.release-harness/`, examples, and the adoption protocol. It
   does not inspect your project, name a subject, guess a URL, or author an
   assertion. A new draft may be well-formed and still incomplete.

2. **Inspect evidence and edit the two draft files.**

   `.release-harness/drafts/example-tool.draft.json` says what must hold.
   `.release-harness/drafts/example-tool.record.json` says how you know. Resolve
   blocking questions only when the evidence or an accountable operator can
   answer them. Inspect the supported vocabulary at any time:

   ```bash
   npx release-harness draft kinds
   npx release-harness validate --draft example-tool
   npx release-harness draft status example-tool
   ```

3. **Accept responsibility for the proposition.**

   ```bash
   npx release-harness accept --draft example-tool --by "release owner"
   ```

   Acceptance is not proof and not deployment approval. It freezes the exact
   proposition under a content digest and records who accepted it. Unresolved
   semantic questions prevent acceptance.

4. **Bind symbolic targets to this environment, then run.**

   ```bash
   npx release-harness bind local --target "tool=node example-tool.js"
   npx release-harness run --binding local
   ```

   Bindings are deliberately outside contract identity: the same proposition
   can be checked locally and in CI without changing what was promised. A
   certifying run requires an accepted contract and resolvable prerequisites.
   An unaccepted draft may be run only with `--exploratory`; it can never PASS.

5. **Verify chain of custody.**

   ```bash
   npx release-harness verify
   ```

   `verify` checks the accepted contract, sealed evidence, verdict, and links
   between them. A missing or broken link is never reported as verified.

## Honest CLI example

Suppose a fictional project contains `example-tool.js`:

```js
const name = process.argv[2] ?? 'world';
console.log(`hello, ${name}`);
```

The author records the observable fact in the authoring record:

```json
{
  "id": "prints-greeting",
  "claim": "example-tool.js prints a greeting and exits 0",
  "status": "observed",
  "evidence": { "source": "example-tool.js:1-2" }
}
```

The draft carries one deliberately narrow assertion:

```json
{
  "id": "A1",
  "kind": "cli",
  "target": "tool",
  "description": "the CLI prints a greeting and exits cleanly",
  "expect": { "args": "Ada", "exit_code": 0, "stdout_contains": "hello, Ada" },
  "supported_by": ["prints-greeting"]
}
```

After its semantic questions are resolved, the operator validates and accepts
that proposition, binds `tool` to `node example-tool.js`, runs it, and verifies
the resulting chain. A PASS proves only this accepted assertion held at that
binding. It does not prove the program is otherwise correct or safe to deploy.

## Contract and trust model

```text
authoring draft + evidence record
                ↓ accountable acceptance
subject + assertions + requires
                ↓ execution bindings
sealed observations → deterministic adjudication → verifiable run chain
```

- Drafts are mutable authoring records. Five epistemic statuses distinguish what
  was observed, what a bounded search established absent, what a source asserts
  absent, what was inferred, and what remains unestablished.
- Accepted contracts are immutable, content-addressed propositions. Exact
  normative references participate in contract identity; execution bindings do
  not.
- Failure attribution is structural and conservative. Missing executables,
  unreachable HTTP targets, unresolved references, and harness failures do not
  become PRODUCT accusations because of text printed to stderr.
- HTTP assertions support method, path, status, and deterministic body
  substrings. CLI assertions support direct executable execution with exit-code,
  stdout, and stderr substrings. stdout and stderr remain separate evidence.
- Windows absolute executable paths, POSIX paths, and PATH command names are
  supported without invoking a shell.
- Humans and agents use the same draft, evidence, acceptance, and adjudication
  semantics. Agents may help inspect and author; the deterministic core decides.
- Multi-repository adoption follows evidence-backed dependencies and exact
  normative references. No topology or repository-role configuration is needed.

## Exit codes

| Exit | Meaning |
|---:|---|
| `0` | Command succeeded; for `run`, an eligible certifying run passed |
| `1` | An accepted assertion was violated |
| `2` | Nothing was proven: for example, a valid draft is blocked or a run is exploratory |
| `3` | Usage, contract, or binding problem; nothing ran |
| `4` | Harness, environment, or evidence-integrity failure |

Only a substantiated assertion failure against a reached subject becomes exit 1.

## Beta scope and limitations

Beta focuses on deterministic HTTP and CLI release assertions and trustworthy
contract authoring and adjudication. The assertion vocabulary is intentionally
small and will expand from demonstrated certification needs rather than
repository taxonomy.

A PASS covers the accepted assertions, exact normative references, binding,
and recorded source for that run. It does not prove complete test coverage,
security, production readiness, or authorization to deploy. Release-Harness is
not a sandbox: direct CLI targets execute with the invoking user's permissions.
Protect evidence storage and review [SECURITY.md](SECURITY.md).

## Packages

| Package | Purpose |
|---|---|
| `@xibodev/release-harness` | Public CLI and library facade |
| `@xibodev/release-harness-core` | Contracts, execution, sealing, attribution, and adjudication |
| `@xibodev/release-harness-schemas` | Draft, contract, evidence, run, and verdict schemas |

All three beta packages version together. The private monorepo root is not
published.

## Brand assets

The canonical Release-Harness visual identity kit lives in [`brand/`](brand/README.md).
Its social PNG is generated from the canonical SVG with `npm run generate:brand-png`
and verified by direct rerendering with `npm run generate:brand-png -- --check`.

## Beta feedback

Classify reports by the boundary they challenge:

- **Trust/correctness:** possible false certification, attribution, identity,
  evidence, or acceptance problem. Highest priority.
- **Expressiveness:** a concrete certification proposition cannot be represented
  using current assertion primitives.
- **Adoption:** evidence discovery, protocol, or semantic-question friction.
- **UX:** messages, documentation, or discoverability.
- **Compatibility:** operating system, runtime, package manager, filesystem, or
  process behavior.

A proposed core-model expansion needs a concrete proposition, an explanation of
why `subject + assertions + requires + execution bindings` cannot represent it,
and an explanation of why an assertion primitive cannot solve it.

## License

[MIT](LICENSE), XiboDev.

## Continuous lifecycle in 3.0.0-beta.1

The next prerelease carries accepted intent across later sessions and checkouts:

```bash
npx release-harness init --with-agent
npx release-harness lifecycle status
```

The optional lifecycle capability is Git-backed. Plain `init` retains the
standalone deterministic contract engine and does not make Git mandatory.

After accepting an initial proposition, create and confirm separate baseline
source coverage:

```bash
npx release-harness review start baseline --contract <digest>
# An agent or person authors facts and semantic impact in the review file.
npx release-harness review validate baseline
npx release-harness review confirm baseline --by "release owner"
```

After later source changes:

```bash
npx release-harness review start change-42 --base origin/main --contract <digest>
npx release-harness lifecycle check --contract <digest>
```

The CLI records exact Git source identities and changed paths. It never infers
semantic impact from paths. A review must account for every accepted assertion
and exact `requires` identity. Only an attributable confirmation of
`reuse_contract` or source-affecting `rebind` can authorize continued coverage.
A blocking, reauthor, stale, missing, or unconfirmed review prevents lifecycle-
enabled certification before execution begins.

`init --with-agent` installs one thin capability pointing to the canonical
lifecycle protocol. It does not install a roster of agent personas or give an
agent authority to accept contracts, confirm reviews, or change verdicts.
