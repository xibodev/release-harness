# Adopting Release-Harness

This is the standard integration protocol for the AI agent doing the adoption.
It names the beats that are easy to miss; everything else is your judgment
about this particular project.

## What this tool is

Release-Harness executes contracts the project owns and adjudicates the result
deterministically. It holds no opinion about what your project should assert.
The value is the separation: **skills derive project-owned contract artifacts,
the human reviews their diff, and the harness executes and seals them.** An
agent cannot talk a run into being green, because the agent does not adjudicate
— the evaluator reads sealed evidence and nothing else.

## The beats that matter

**The skills arrive with `init --with-agents`, not with `npm install`.** They
ship inside the package's `templates/` directory and only reach the project
when you run:

```bash
npx release-harness init --with-agents
```

A bare `init` writes contracts only. If you go looking for
`release-harness-project-cartographer` before running this, you will not find it
in the workspace — and its absence is not evidence that the bundle does not
exist. Inspect the package in flight without extracting anything:

```bash
npx release-harness skills list
npx release-harness skills info project-cartographer
```

The skills scaffold under `release-harness-` prefixed names
(`release-harness-project-cartographer`) so they cannot shadow a same-named
skill already installed. Invoke them by the namespaced name.

**Use `release-harness-project-cartographer` rather than mapping the repository
by hand.** It derives topology and origins from real ports, health endpoints,
and service definitions. Hand-enumerating routes and Docker files is the
expensive path this skill exists to replace, and it is the path that gets ports
wrong.

**Use `release-harness-scenario-compiler` to draft scenarios**, including their
side-effect probes. A scenario that only drives the UI proves the UI responded,
not that the product did its job. If the product's real deliverable is a file —
a rendered video, a compiled binary, a generated PDF, an exported dataset —
assert it with a custom probe whose script is committed to the repository.

**Treat contracts as generated review artifacts.** Do not ask the human to
hand-write raw schema JSON. Derive the contracts, validate them, and present the
resulting diff for approval.

## Golden Sequence

1. `npx release-harness doctor` — verify host prerequisites first; a missing
   Docker or Playwright wastes everything downstream.
2. `npx release-harness init --with-agents` — contracts plus the skill bundle.
3. `release-harness-project-cartographer` — derive `topology.json` and
   `origins.json`, then present their diff for review.
4. `release-harness-scenario-compiler` — compile scenarios and their side-effect
   probes from user stories and personas, then present their diff for review.
5. `npx release-harness run-local` — establish a green baseline before wiring
   anything into CI.
6. Wire `npx release-harness check-pr` into pull requests and
   `npx release-harness run-local` into release branches.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Certified |
| 1 | Required failure — inspect causes for a product bug or missing fixture |
| 2 | Unproven — development mode, or a dirty tree with `--allow-dirty` |
| 3 | Harness error — misconfiguration, unknown flag, unimplemented probe |
| 4 | Evidence invalid — the sealed evidence does not verify |

**Exit 1 requires cause-based remediation.** Fix product code for
`PRODUCT_BUG`; acquire the required fixture or dependency for
`HARNESS_FIXTURE_MISSING`.

**Exit 3 means the harness could not do its job, not that the product is
broken.** Read the reported cause before changing product code: a malformed
contract, an unsupported `service` or `probe_type`, an unknown CLI flag, or a
probe the harness does not implement all land here. Do not infer a product
defect from the exit number alone; follow the runtime diagnostics.

Exit 4 means the sealed evidence does not match its manifest. Do not re-run
until you know why — treat it as a tampering or corruption signal, not as flake.

## Two things adopters get wrong

**Materialization uses a detached source copy.** Git-ignored files never reach
the workspace. Certification runs also exclude untracked files; `--allow-dirty`
development runs include untracked files that are not ignored. If a build
depends on a missing `.env` or local fixture, inspect `git status`,
`git check-ignore`, and the materialization warnings. Commit non-secret assets,
or inject configuration through the project's Compose/environment setup; never
commit secret local credentials.

**A dirty tree cannot certify.** `run-local` on uncommitted changes needs
`--allow-dirty`, and an otherwise complete run reports exit 2 (NON-CERTIFYING)
by design. Harness and evidence faults still retain exit 3 or 4. Commit before
you expect a certified exit 0.
