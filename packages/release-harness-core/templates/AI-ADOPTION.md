# Adopting Release-Harness

This file is for the AI agent doing the integration. It names the beats that are
easy to miss; everything else is your judgment about this particular project.

## What this tool is

Release-Harness executes contracts the project owns and adjudicates the result
deterministically. It holds no opinion about what your project should assert.
The value is the separation: **you author the contracts, the harness executes
and seals them.** An agent cannot talk a run into being green, because the agent
does not adjudicate — the evaluator reads sealed evidence and nothing else.

## The beats that matter

**The skills arrive with `init`, not with `npm install`.** They ship inside the
package's `templates/` directory and only reach the project when you run:

```bash
npx release-harness init --with-agents
```

A bare `init` writes contracts only. If you go looking for
`project-cartographer` before running this, you will not find it — and its
absence is not evidence that the bundle does not exist.

The skills scaffold under `release-harness-` prefixed names
(`release-harness-project-cartographer`) so they cannot shadow a same-named
skill already installed. Invoke them by the namespaced name.

**Use `project-cartographer` rather than reading the repository by hand.** It
derives topology and origins from real ports, health endpoints, and service
definitions. Hand-enumerating routes and Docker files is the expensive path this
skill exists to replace, and it is the path that gets ports wrong.

**Use `scenario-compiler` to draft scenarios**, including their side-effect
probes. A scenario that only drives the UI proves the UI responded, not that the
product did its job. If the product's real deliverable is a file — a rendered
video, a compiled binary, a generated PDF, an exported dataset — assert it with
a custom probe whose script is committed to the repository.

**You author the contracts. The human does not hand-write JSON.** That is the
point of the bundle. Show them the diff, not a blank schema.

## Order

1. `npx release-harness doctor` — verify host prerequisites first; a missing
   Docker or Playwright wastes everything downstream.
2. `npx release-harness init --with-agents` — contracts plus the skill bundle.
3. `project-cartographer` — derive `topology.json` and `origins.json`.
4. `scenario-compiler` — draft scenarios and their side-effect probes.
5. `npx release-harness run-local` — establish a green baseline before wiring
   anything into CI.
6. Wire into the project's existing test and release flow, shaped by that
   project's needs.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Certified |
| 1 | Product failure — a scenario or assertion failed |
| 2 | Unproven — development mode, or a dirty tree with `--allow-dirty` |
| 3 | Harness error — misconfiguration, unknown flag, unimplemented probe |
| 4 | Evidence invalid — the sealed evidence does not verify |

**Exit 3 means the harness could not do its job, not that the product is
broken.** Read the reported cause before changing product code: a malformed
contract, an unsupported `service` or `probe_type`, an unknown CLI flag, or a
probe the harness does not implement all land here. Changing product code in
response to an exit 3 fixes nothing.

Exit 4 means the sealed evidence does not match its manifest. Do not re-run
until you know why — treat it as a tampering or corruption signal, not as flake.

## Two things adopters get wrong

**Materialization mirrors committed source.** The run executes against a
detached copy built from git, so a git-ignored file — a local `.env`, an
uncommitted fixture — does not reach the workspace and the build that depends on
it will fail. Materialization names the excluded file. Commit it, or supply the
value through `.release-harness/harness.config.json`.

**A dirty tree cannot certify.** `run-local` on uncommitted changes needs
`--allow-dirty`, and that run reports exit 2 (NON-CERTIFYING) by design. Commit
before you expect a 0.
