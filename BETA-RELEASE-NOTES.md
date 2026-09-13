# Release-Harness 1.2.0-beta.1

Release-Harness certifies deliberately accepted release propositions with
deterministic evidence. Its frozen contract model is:

`subject + assertions + requires + execution bindings`

## Highlights

- **Three explicit planes:** mutable authoring records, immutable accepted
  contracts, and deterministic adjudication. Acceptance records responsibility
  for a proposition; it does not claim the proposition has already been proven.
- **Conservative trust boundary:** a claim inferred merely from files cannot
  become PRODUCT blame. Launch failures, unresolved bindings, unavailable
  normative references, and harness faults retain their own structural causes.
- **Sealed evidence and verification:** runs seal observations and link the
  accepted contract, bindings, source, evidence manifest, and verdict so chain
  of custody can be checked later.
- **Certifying and exploratory modes:** only an eligible run of an accepted
  contract can PASS. An exploratory draft run can provide feedback but remains
  UNPROVEN.
- **Normative references:** exact cross-subject contract digests participate in
  proposition identity. If an exact identity cannot be established, adoption
  remains explicit and blocked rather than inventing one.
- **Multi-repository adoption without topology configuration:** authors follow
  evidence-backed dependencies and references. Repository adjacency alone does
  not establish a relationship.
- **One semantic model for people and agents:** both produce the same draft and
  authoring record, pass through the same acceptance boundary, and are judged by
  the same deterministic core.
- **HTTP and CLI assertions:** HTTP status and body substrings; CLI exit status,
  stdout, and stderr substrings with separately captured streams.
- **Windows support:** absolute executable paths, paths with spaces, PATH command
  names, and direct `shell: false` execution are covered by installed-package
  tests.
- **Self-adoption:** running `release-harness init` in the Release-Harness
  repository preserves the invariant that exactly one canonical protocol source
  exists.

## Beta limitations

Beta focuses on deterministic HTTP and CLI release assertions and on trustworthy
contract authoring and adjudication. The assertion vocabulary is intentionally
small and will expand from demonstrated certification needs rather than
repository taxonomy.

A PASS covers only the accepted assertions exercised by that run. It does not
prove complete test coverage, absence of security defects, production readiness,
or authorization to deploy. Direct CLI targets execute with the invoking user's
permissions; Release-Harness is not a sandbox.

## Getting started

```text
init → draft → inspect / resolve questions → validate → accept → bind → run → verify
```

See [README.md](README.md) for the short tutorial and an intentionally generic
CLI example. Read [SECURITY.md](SECURITY.md) before executing project-owned
commands or sharing evidence.
