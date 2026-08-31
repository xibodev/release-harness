---
name: security-audit
description: Production-grade security audit covering secrets management, authentication/authorization, data protection, API security, and HTTP security headers. Inspired by the OWASP Top 10 and the Production Ready Checklist's Security section. Produces a fix-plan that integrates with the suite's consolidator. Use when asked to "run security audit", "check for secrets", "scan for OWASP issues", "validate security headers", or before a release.
compatibility: Works with any source repo. Optional integrations `npm audit`, `pip-audit`, `gitleaks`, `trufflehog`, `osv-scanner` if installed.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

## Purpose

Run a focused, evidence-based security audit covering the issues that most often block projection. The goal is a fix-plan — not a vague "looks risky" verdict.

## Required inputs

- Working tree of the repo.
- Optional: `code-change-review` output for delta scoping.

## Audit areas

### 1. Secrets and configuration

- Scan tracked files for high-confidence secret patterns: `AKIA[0-9A-Z]{16}`, `AIza[0-9A-Za-z\\-_]{35}`, `ghp_[0-9A-Za-z]{36}`, `xox[baprs]-[0-9A-Za-z-]+`, JWT `eyJ` prefix in source, private key headers, `password\s*=\s*['"][^'"]+['"]` patterns in source.
- Cross-check `.env*` files exist but are git-ignored.
- Verify there is a `.env.example` (or equivalent) committed.
- If `gitleaks` or `trufflehog` is on PATH, run it on the working tree and append findings.
- NEVER log the secret value itself in the report. Reference by file + line + pattern name only.

### 2. Authentication & authorization

- Detect auth framework signals: `passport`, `next-auth`, `clerk`, `auth0`, `@azure/msal`, `firebase/auth`, `ASP.NET Identity`, `devise`, `django.contrib.auth`.
- Check password hashing: presence of `bcrypt`, `argon2`, `scrypt`. Flag any custom `crypto.createHash('md5'|'sha1')` used on passwords.
- Find token expiration: `expiresIn`, `JWT_EXPIRES`, `Set-Cookie` `Max-Age` settings. Flag tokens with no expiry or > 30 days.
- CORS check: search for `Access-Control-Allow-Origin: \*` or `cors({origin: true})` in projection code paths.
- Rate limiting on auth endpoints: search for `express-rate-limit`, `rate-limiter-flexible`, or framework equivalents wired to login routes.

### 3. Data protection

- TLS/HTTPS enforcement: check for `http://` literals in non-test source, missing HSTS middleware.
- Encryption at rest: detect references to `KMS`, `Key Vault`, encrypted column types in migrations.
- Sensitive log redaction: search for logger calls that include `req.body`, `password`, `token`, `apiKey`, `ssn` without redaction.

### 4. API security

- Input validation: detect schema validators (`zod`, `joi`, `yup`, `class-validator`, `pydantic`, `FluentValidation`). Flag endpoints with no validator wired in.
- SQL injection: search for raw string concatenation in queries: `query("SELECT ... " + var)` / `f"SELECT ... {var}"` / `String.format` in JDBC. Flag every hit.
- XSS: search for `dangerouslySetInnerHTML`, `v-html`, `innerHTML\s*=`, unescaped template interpolation in server-rendered views.
- File upload: detect upload handlers and check for explicit mime/size validation.

### 5. Security headers

For each detected web framework, check whether these headers are set:

| Header | Expected value (typical) |
|---|---|
| `Content-Security-Policy` | non-default policy that disallows `unsafe-inline` for scripts |
| `Strict-Transport-Security` | `max-age` ≥ 6 months |
| `X-Frame-Options` | `DENY` or `SAMEORIGIN` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | set to a non-default value |
| `Permissions-Policy` | present |

Look for `helmet`, `next-safe`, `secure_headers`, `django-csp`, ASP.NET middleware, nginx/Apache config. Flag every missing header.

### 6. Dependencies

- If `package.json` / `requirements.txt` / `pyproject.toml` / `go.mod` / `Cargo.toml` exists, try the native vulnerability tool: `npm audit --json`, `pip-audit -f json`, `osv-scanner`. Capture only `high` and `critical` advisories.
- Do not block on `low`/`moderate` unless they're auth-related.

### 7. Production hardening

- Debug mode disabled: search for `DEBUG = True`, `app.use(errorhandler())` in projection paths, `NODE_ENV !== 'projection'` checks.
- Server fingerprint stripped: search for `X-Powered-By`, default server banners.

## Output

### Reports

- `./.quality-run/results/<ts>/security/security-report.md` — human-readable, grouped by section above.
- `./.quality-run/results/<ts>/security/findings.json` — machine-readable raw findings with file + line + category.
- `./.quality-run/results/<ts>/security/fix-plan.json` — shared Fix Plan Schema (see suite README).

### Fix-plan item conventions

- `category`: always `security`.
- `severity` mapping:
  - `critical`: exposed credential in tracked source, missing auth on a sensitive route, raw SQL concatenation in projection code, dependency CVE rated critical.
  - `high`: missing CSRF on state-changing endpoint, missing rate-limit on login, missing CSP header on web app, dep CVE rated high.
  - `medium`: missing security header, missing input validator, weak token expiry, debug flag in non-prod path.
  - `low`: missing `.env.example`, missing `Permissions-Policy`, low-impact informational findings.

## Hard rules (do not violate)

- Never include actual secret values in any output file.
- Never run a tool that mutates the working tree.
- If a vulnerability scanner is unavailable, record that gap explicitly in the report rather than skipping silently.
- Treat false positives explicitly: when a pattern matches but context proves it's safe (e.g. a test fixture, an example), mark the finding `severity: informational` and leave it out of the fix-plan.

## Gates

- If any `critical` finding is detected, surface it at the top of the report before the consolidator runs.
- If `npm audit`/equivalent reports unresolved critical advisories, flag the release as blocked in the fix-plan.

## Pipeline Contract

Standard pipeline contract applies — working directory, `./.quality-run/` layout (artefacts vs results), worktree-only rules, and gate semantics per `references/pipeline-contract.md` (vendored into this skill's install). This skill's specifics:

### Outputs this skill produces

- **Artefacts:** none.
- **Results:** `results/<ts>/security/security-report.md`, `results/<ts>/security/findings.json`, `results/<ts>/security/fix-plan.json`.

### Hard rules

- Never include actual secret values in any output file. Reference by file + line + pattern name only.
- Never mutate the working tree. Read-only scanning only.
- If a vulnerability scanner is missing on PATH, record the gap; do not skip silently.
- **Sealed UAT — no internet.** Vuln scanners must use an offline DB: `osv-scanner --offline-vulnerabilities <dir>`, `npm audit --offline` against the cached lockfile, `pip-audit --no-deps`. If no cached DB is present under `artefacts/security-db/`, emit one `deferred-test` fix-plan item per missing DB (`category: "deferred-test"`, `severity: "info"`, `evidence.reason: "requires-internet"`, `evidence.what_to_run_offline: "populate artefacts/security-db/<scanner> with the offline DB or run the scanner outside the sealed run"`). Do not call out to any public service. Do not fabricate a result.

### Gates

- Stop and surface any `critical` finding (exposed credential, missing auth on sensitive route, unresolved critical CVE) before the consolidator runs.
