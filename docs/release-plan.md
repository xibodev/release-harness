# Release Plan

## Scope and Version

Ship the fixes for #7, #8, #10, #11, #12, and #13, together with sealed-replay
and browser-enforcement corrections. This implementation incorporates and revises
the discovery/onboarding work proposed by draft PR #9. Do not merge that draft
independently on top of this change; review its disposition after the replacement
PR is accepted.

Provisional target: **1.3.0**, subject to explicit compatibility review. Keep this
implementation PR unversioned, then prepare a separate version PR. Schema-format
versions are independent of npm package versions.

The security fixes intentionally reject some formerly accepted inputs and ignore
unsealed replay overrides. Review the Unreleased changelog before approving minor
version semantics. In particular, manifests advertise Node `>=18`, while the
locked Playwright dependency requires Node `>=20`. Either restore and test the
advertised support floor or explicitly approve an engine-floor change and its
semver consequences; consider 2.0.0 if the supported runtime contract is dropped.

## Merge Gates

- Require green `Validate` checks on the final PR commit. Re-run after changes;
  historical local test results are not evidence for a different commit.
- Require Linux execution of the file-symlink regressions skipped when Windows
  denies symlink creation. Review logs for unexpected skips, not only exit codes.
- Exercise the fresh packed consumer, not just the workspace dependency graph.
- Review startup attribution: uncertain crashes remain `UNKNOWN`/exit 3 rather
  than being guessed from logs. Core Compose-startup tests use doubles; complete
  a real product Compose startup-failure/replay check before publication.
- Verify targeted upgrades preserve custom contracts and agent bodies. Avoid
  using blanket `init --overwrite` as a migration procedure.
- Resolve the Node support decision and review the published migration notes.
- Human approval is required to merge. Merging `docs/**` also triggers the Pages
  workflow; it is separate from npm publication.

## Version Preparation

After the implementation merges, create a version-only preparation PR:

1. Set all three public package versions to the approved version.
2. Update exact internal dependencies: facade to core and schemas, core to schemas.
3. Update `HARNESS_VERSION` in `packages/release-harness-core/src/cli.js`.
4. Run `npm install --package-lock-only` and reject unrelated dependency churn.
   The private root package version need not track the public release.
5. Finalize the changelog and the approved Node engine policy.
6. Check all versions, dependency pins, CLI output, and proposed tag agree.

Run on the exact candidate commit:

```sh
npm ci
npx playwright install --with-deps chromium
npm test
git diff --check
```

The complete gate requires Docker/Compose, Chromium, `tar`, and OpenSSL 1.1.1+.
Tests generate temporary TLS keys; no keys belong in the release artifacts.

## Dry Run and Publication

Inspect `.github/workflows/release.yml` again before invoking it. Its manual
dispatch defaults to publishing; always pass `dry_run=true` for rehearsal:

```sh
gh workflow run release.yml --ref <approved-version-branch> -f dry_run=true
```

Require the rehearsal to pass all five suites and packing. The current workflow
does not upload dry-run tarballs as downloadable artifacts, so retain its run URL
and inspect its packing output. Confirm publish authentication is valid for all
three packages without printing credentials; secret presence alone is not proof.

Before publication, recheck registry versions/dist-tags, existing tags, workflow
permissions, and that the exact approved release commit is on main. Do not infer
readiness from the absence of branch protection. The workflow does not enforce
tag/package equality, main ancestry, or publication concurrency; verify those
explicitly and allow only one publishing run.

**A release tag push publishes immediately and requires separate authorization.**
After approval, create the matching `v<version>` tag at the reviewed main commit
and push only that tag. The workflow validates, packs, and publishes with
provenance in this order: schemas, core, facade. Publication uses npm `latest`.
Tag-triggered runs then create a GitHub release with generated notes and tarballs.
Review those notes against the changelog before announcing the release.

Do not use an ordinary manual dispatch as a substitute for the tag flow: without
`dry_run=true` it publishes packages, but a branch dispatch does not create the
GitHub release. No dispatch, release tag, merge, or publication is part of this PR.

## Verification and Recovery

- Confirm workflow completion, all three registry versions, internal dependency
  pins, `latest` dist-tags, provenance, and GitHub release assets.
- Install the released facade in a fresh temporary consumer; check CLI version,
  discovery, contracts, host scaffolding, and a browser certification run.
- Re-run targeted legacy-config migration and sealed replay checks using the
  published package, preserving archived evidence unchanged.
- If publication fails halfway, stop and inspect which immutable versions exist.
  Do not blindly rerun the full publish job or reuse an occupied version.
- If a released defect is found, stop promotion and prepare a corrective version.
  Any deprecation or dist-tag rollback is a separate operator-approved action;
  do not rewrite tags or delete evidence.
