---
name: release-harness-adoption
description: Use when adopting release-harness into a project - authoring a release contract, creating or resolving a draft, recording what is actually known about a codebase, or taking a proposition through to acceptance. Covers bounded inspection, honest evidence statuses, and the accept path.
---

# Adopting release-harness

The protocol is host-neutral and lives in one file. Read it and follow it:

**`protocol/ADOPTION.md`** in this repository, or `.release-harness/protocol/ADOPTION.md`
in a project that has run `release-harness init`.

It is deliberately not duplicated here. A copy would drift from the original,
and then two agents on two hosts would be following different rules while
believing they were following the same one.

## What it covers

- establishing where you are, and what has already been authored
- bounded inspection of high-signal sources, and why a recursive scan is worse
  than useless
- the three ways something can be absent, and which of them support a claim
- asking only questions that files cannot answer
- proposing assertions that would actually catch a regression
- surfacing contradictions rather than resolving them by rule
- validating and accepting through the same public commands a person uses

## The one thing to carry into every step

Never write a claim you cannot point at evidence for. A contract containing a
guess is indistinguishable, on disk, from one the operator knew to be true.
