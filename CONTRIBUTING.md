# Contributing

Contributions should include a clear description of the user-visible change and
tests for changed behavior. For suspected vulnerabilities, follow
[SECURITY.md](SECURITY.md) rather than publishing sensitive reproduction details.

## Repository Layout

| Path | Purpose |
|---|---|
| `packages/release-harness/` | Public npm facade and CLI entry point |
| `packages/release-harness-core/src/` | CLI, runners, probes, evaluator, and evidence handling |
| `packages/release-harness-core/templates/` | Packaged adoption guide, agents, and skills |
| `packages/release-harness-core/test/` | Core unit and regression tests |
| `packages/release-harness-schemas/` | JSON schemas, exports, and schema tests |
| `tests/neutral/` | Deterministic acceptance fixtures |
| `tests/smoke/` | Local Docker/browser acceptance tests |
| `tests/package/` | Packed-package installation and independent consumer tests |
| `docs/` | Public website sources and documentation assets |

## Setup And Validation

Use Node.js 20 and npm for the CI-tested baseline. The released 2.0.0 packages
require Node.js `>=20`; 1.2.0 metadata declared `>=18`. Do not infer a
tested support matrix for every newer runtime from the open-ended engine range.

The full gate requires Git, Docker with Compose and a running daemon, Playwright
Chromium with its OS dependencies, `tar` on PATH, and OpenSSL 1.1.1 or newer.
Transport tests generate temporary TLS keys/certificates and remove them after
the test. On Windows, the tests can use OpenSSL from the standard Git installation
or PATH. Use disposable local services and nonsecret fixtures, not production
resources or credentials.

From the repository root:

```bash
npm ci
npx playwright install chromium
npm test
```

On Linux, use `npx playwright install --with-deps chromium` when browser system
dependencies are missing. This can require elevated package-manager access.
The independent consumer test installs packed tarballs and the Chromium version
matching its freshly resolved Playwright dependency, so allow npm/browser download
access and enough temporary disk space.

`npm test` runs release metadata checks, docs, schemas, core regressions, neutral fixtures, smoke acceptance, and
fresh-package installability. For focused feedback, run `npm run test:schemas`,
`test:core`, `test:neutral`, `test:smoke`, or `test:install`; passing a subset is not
the full gate. Report commands run, failures, and skipped coverage in your PR.

Some file-symlink cases skip when Windows denies link creation. Run the full gate
on Linux or a host with working symlink privileges to cover those cases; a skipped
symlink test is not evidence that the boundary was verified.

## Code And Template Changes

Keep changes focused and preserve unrelated work. Add regression tests for
observable behavior, including invalid inputs and replay behavior when changing
evidence or verdict logic. Gate outcomes must remain deterministic; agent advice
cannot substitute for evaluator results.

Edit packaged playbooks under `packages/release-harness-core/templates/`.
The canonical agent body is
`packages/release-harness-core/templates/agents/release-conductor.md`;
`packages/release-harness-core/src/agent-templates.js` renders runtime-specific
frontmatter during `init`. Test generated consumer files, not only repository
agent variants. Do not use `scripts/generate-harness-templates.mjs`: it is retired
and is not the source of truth. Do not import templates from sibling checkouts.

Run the CLI from source with
`node packages/release-harness-core/bin/release-harness.js --help`. Label new
commands and behavior as unreleased until published; the website may be updated
before npm. Record user-visible compatibility changes in [CHANGELOG.md](CHANGELOG.md).

## Public Documentation

Public docs should explain installation, usage, APIs, architecture, implemented
and planned capabilities, limitations, security, and contribution. Keep internal
task histories, user directives, release coordination, and process debates out of
the README, changelog, website, and packaged adoption guides. Do not add a public
release checklist or imply that planned features already ship.

`scripts/build-public-site.mjs` defines the website publication boundary: only
`docs/index.html`, `docs/docs.html`, `docs/style.css`, and `docs/app.js` are allowed
into the site artifact. Do not upload the entire `docs/` directory or broaden the
allowlist to publish working notes. Review links and run `npm run test:docs` and
`npm run build:site` when changing website content or packaging. A file excluded from the website
can still be public through Git; never commit secrets or confidential notes.

Before opening a PR, review the diff for accidental files, sensitive data,
unsupported claims, and broken links. Explain compatibility implications and the
validation performed. See [README.md](README.md) for the product scope and
[SECURITY.md](SECURITY.md) for its trust boundaries.
