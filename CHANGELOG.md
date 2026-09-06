# Changelog

User-visible changes and upgrade considerations. The published npm release is
`2.0.0`, released on 2026-09-06. See the
[GitHub release](https://github.com/xibodev/release-harness/releases/tag/v2.0.0).

## 2.0.0

### Breaking Changes And Migration

- **Node.js 20+ is required** by all three packages. Version 1.2.0 declared
  Node.js `>=18`; upgrade local Node installations, CI runners, and container
  images before adopting 2.0.0. The optional facade Playwright peer now requires
  `>=1.50.0`, matching the core dependency minimum. Install Chromium for the
  Playwright version resolved in your lockfile. An open-ended peer range is not
  a guarantee that every future Playwright release has been tested.
- **Sealed replay ignores caller-only overrides.** Evaluation uses
  manifest-covered facts, preserving recorded network and harness failures.
  Callers must not rely on supplying replacement policy or outcome facts to
  change a sealed verdict. Rerun with corrected contracts to produce new evidence;
  do not edit or reseal historical archives. Missing required facts or linked
  evidence can invalidate old bundles.
- **Health probes are strict.** Use implemented HTTP or TCP probes; replace
  unsupported declarations instead of relying on silent success. Harness/probe
  errors return exit `3`, not a successful check or automatic product failure.
  Built-in `sql_query` remains unsupported; use an asserting custom probe.
- **Conflicting network policies are rejected.** Move policy to
  `topology.json.network_policy`; remove a conflicting legacy declaration from
  `harness.config.json` and correct malformed fields. Legacy config-only policy
  remains supported. Declare policy explicitly: absence still means open mode
  with a warning, not sealed isolation.

Browser transport limits and contract-preservation guidance are listed under
Compatibility below and in [SECURITY.md](SECURITY.md).

### Added

- Read-only `skills list` and `skills info` commands, shared `.agents/skills`
  scaffolding, and revised adoption playbooks with host discovery guidance.
- Sealed startup observations and explicit accounting for scenarios blocked
  before execution. Ambiguous startup failures retain `UNKNOWN` attribution.

### Changed

- Generated product slugs satisfy both contract schemas. Partial scaffolds
  preserve valid existing identities and reject conflicting identities.
- Generated agents use runtime-specific frontmatter. Disk scaffolding and host
  registration are documented as separate steps.
- Network policy uses `topology.json` as the canonical location. Legacy config
  declarations remain supported; conflicts and malformed fields are rejected.
- Sealed browser traffic uses a destination-filtering proxy, including redirect
  and WebSocket destinations. Interrupted upstream responses no longer leave
  downstream requests hanging.
- Replay uses manifest-covered facts rather than caller-only overrides, retains
  network/harness failures, and rejects linked evidence.
- Startup failures produce sealed diagnostics and a verdict when evidence
  finalization succeeds. Arbitrary startup logs are omitted for secret safety.

### Compatibility

- Stricter evidence validation can change verdicts. Historical bundles without
  required sealed facts may need a new run; preserve archives rather than editing
  or resealing them to obtain a different result.
- HTTP and TCP are supported health probes. Unimplemented health probe types
  fail explicitly. Ambiguous startup failures remain `HARNESS_ERROR` (exit `3`),
  not automatically product failures.
- Missing network policy retains legacy open behavior with a warning. HTTPS/WSS
  filtering checks tunnel destinations, not encrypted content, SNI, or certificate
  identity. Allowed relays and container-wide isolation are outside this boundary.
  Non-proxied WebRTC UDP is suppressed without individual violation records.
- Preserve existing contracts and repair slugs/frontmatter selectively. Normal
  `init` preserves existing files; `--force` / `--overwrite` resets customized
  contracts as well as agent files.

## 1.2.0

### Added

- Custom side-effect probes run a project-owned executable with argument arrays
  and compare its exit status with `expect_exit_code`. Stdout/stderr are retained
  as evidence, not matched as assertions. Execution uses `shell: false`, which
  does not isolate an untrusted executable.
- Multi-repository local UAT materializes every declared repository and records
  a `sources[]` entry for each, with materialization counts and warnings.
- `init --with-agents` includes `AI-ADOPTION.md` and namespaced
  `release-harness-*` skills. Bare `init` writes contracts only;
  `--contracts-only` makes this explicit and is mutually exclusive with
  `--with-agents`.

### Changed And Fixed

- Detached source follows Git's tracked/ignored-file rules, retains nested
  product directories, and reports excluded inputs. Tree digests cover all
  materialized file depths; unresolved Git status does not count as clean.
- Source symlinks are materialized where supported, with resolved-content
  fallback where possible and named diagnostics for skipped entries.
- Contracts are schema-validated at load time, including `check-pr` config.
  `harness_version` accepts semantic versions, including prereleases.
- Writes after evidence sealing are refused. Probe port offsets apply to the
  run's own service ports. Unknown CLI flags are rejected; unused `--config`
  help was removed.
- Agent scaffolding works independently of a pre-existing `AGENTS.md` and reports
  same-name skill collisions.

### Compatibility

- **`sql_query` is unsupported** and returns `HARNESS_ERROR` (exit `3`). Use a
  custom probe that executes a database query and asserts its result.
- Misconfigured or unimplemented probes return exit `3`, not a product-failure
  exit `1`. Update CI exit-code handling accordingly.
- `--allow-dirty` returns `2` for otherwise passing/failing development runs,
  but preserves harness errors as `3` and invalid evidence as `4`.
- Git-ignored files do not reach the detached workspace. Commit only nonsecret
  source and test fixtures; supply secrets through controlled runtime environment
  configuration. Do not commit a local `.env` to fix a missing build input.
- Unnamespaced skills from older scaffolds are left in place. Remove only copies
  you no longer use; preserve customizations when adopting the namespaced bundle.
