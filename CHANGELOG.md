# Changelog

All notable changes to Release-Harness are documented here.

## 1.2.0

### Behavior changes

Read these before upgrading. Each one corrects behavior that was previously
wrong, so **a run that was green on 1.1.0 may legitimately fail on 1.2.0.**

- **Source materialization mirrors committed source.** The detached workspace is
  built from git rather than from a filesystem walk with a basename denylist.
  Nested product directories named `docs`, `uploads`, `research`, or `brand` are
  no longer dropped, and git-ignored package-manager stores such as
  `.pnpm-store` are no longer copied.

  **Git-ignored files no longer reach the workspace.** A build that depends on
  an untracked file — a local `.env`, an uncommitted fixture — will now fail.
  Materialization names the excluded file so the cause is visible. Commit the
  file, or provide the value through your compose file's environment, so the
  build does not depend on an uncommitted file.

- **`sql_query` probes fail closed.** The Postgres probe never executed SQL and
  never evaluated `expected_rows_count` or `forbidden_values`, yet reported
  success whenever the port answered. It now reports that the probe is
  unimplemented, so a scenario declaring it exits 3 where it previously
  certified green. Assert database state with a custom probe running your own
  query tool.

- **Harness faults report exit 3.** A misconfigured or unimplemented probe now
  yields `HARNESS_ERROR` with exit code 3, where it previously reported exit 1
  as a product failure. Check any CI step whose handling assumed exit 1.

- **A dirty run's exit code no longer masks integrity failures.** With
  `--allow-dirty`, a would-be pass or fail still reports 2 (non-certifying
  development mode), but a harness error keeps exit 3 and invalid evidence keeps
  exit 4. Those two were previously downgraded to 2 and disappeared.

- **Scaffolded skills are namespaced.** `init --with-agents` writes skills under
  `release-harness-*` names, in both the directory name and the frontmatter, so
  they cannot shadow same-named skills you already have. Unnamespaced copies
  written by 1.1.0 are left in place; remove them manually if you no longer want
  them.

- **Contracts are validated against their schemas at load time.** An unsupported
  `service` or `probe_type`, a malformed `pr_gate`, or a missing required field
  is rejected with a message naming the field and the allowed values, instead of
  surfacing deep in the engine. An invalid `harness.config.json` now fails
  `check-pr` with exit 3 rather than being skipped while the gate reported PASS.

- **`harness_version` accepts any released version.** The published schema
  pinned it to `enum: ["1.0.0"]` and therefore rejected the configuration `init`
  itself writes. It now accepts any semver, including prereleases, and still
  rejects non-versions such as `1.1`, `v1.1.0`, and `latest`.

### Added

- **Custom side-effect probes.** Declare a command in your committed
  `.release-harness/` contract and the harness executes it against the
  materialized workspace, compares the exit code to `expect_exit_code`, and
  seals stdout and stderr as evidence under `evidence/probes/`. Products whose
  deliverable is a file — a rendered video, a compiled binary, a generated PDF,
  an exported dataset — can now assert on their actual output. The command runs
  with no shell in between, so a contract value cannot smuggle in shell syntax.
  The exit code is the whole verdict: stdout and stderr are captured for a human
  to read, never matched against.

- **Multi-repo Level 2 certification.** `run-local` materializes and certifies
  every repository a `multi_repo` topology declares, recording one `sources[]`
  entry per repository. Previously it bound whichever repository the operator
  was standing in while the manifest claimed the whole graph.

- **Materialization diagnostics.** File count, byte count, and elapsed time are
  reported per materialized repository, and warnings raised during enumeration —
  including a named excluded `.env` — now reach the operator instead of being
  discarded.

- **`AI-ADOPTION.md`**, scaffolded by `init --with-agents`, documenting the
  adoption order and exit codes for the AI agent doing the integration.

- **`--contracts-only`**, which was documented but read nowhere. A bare `init`
  writes contracts only; `--contracts-only` states that explicitly and the two
  scaffolding flags are now mutually exclusive.

- **Evidence sealing enforced at write time.** A write attempted after
  `sealEvidence()` is refused at the write, with a message naming the seal,
  rather than passing silently and surfacing later as a manifest hash mismatch.

### Fixed

- Tree digests cover every materialized file at any depth. The walk stopped at
  four levels, so a change deeper in the tree left the recorded provenance
  unchanged.
- Source cleanliness fails closed when git status cannot be resolved, instead of
  defaulting to clean. Untracked files are no longer invisible to the check.
- Symlinks are materialized rather than silently skipped. On a host that cannot
  create them — Windows without developer mode — the resolved content is copied
  so the build still sees a real file. A symlink that can be neither recreated
  nor copied is reported as a named skip rather than counted as materialized.
- `--port-offset` applies to side-effect probes, so a concurrent run verifies
  its own containers rather than the unshifted ones.
- Unknown CLI flags are rejected with exit 3 instead of being silently ignored.
  The unused `--config` flag is removed from the help.
- `init --with-agents` no longer depends on the absence of an unrelated
  `AGENTS.md`, and reports pre-existing same-name skills before writing.
- `scenario-compiler` documents how to author side-effect probes, so the probes
  the engine implements are ones the bundled skills can actually emit.

Closes #3. Closes #4. Closes #5.
