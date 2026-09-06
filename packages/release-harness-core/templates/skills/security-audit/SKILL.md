---
name: release-harness-security-audit
description: Evidence-based security review of secrets, authentication, authorization, data protection, APIs and HTTP headers. Produces findings for human review and release-harness-fix-planner. Use for security audits, OWASP checks or pre-release review.
compatibility: Works with any source repo. Optional integrations `npm audit`, `pip-audit`, `gitleaks`, `trufflehog`, `osv-scanner` if installed.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

## Purpose

Run a focused, evidence-based security audit of production code and configuration.
The goal is a fix-plan, not a certification of security or compliance. Patterns
are leads: verify reachability and context before assigning severity.

All report paths below are relative to an agreed private assessment root outside
sealed runs, the source repository and published documentation.

## Required inputs

- Working tree of the repo.
- Optional: `release-harness-code-change-review` output for delta scoping.

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
- CORS check: search for `Access-Control-Allow-Origin: \*` or `cors({origin: true})` in production code paths.
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

- Identify the native vulnerability tool for the lockfile, such as `npm audit`,
  `pip-audit` or `osv-scanner`. Follow the offline-assessment rule below before
  execution; availability alone does not authorize network access. Record
  advisory database freshness and high/critical findings.
- Do not block on `low`/`moderate` unless they're auth-related.

### 7. Production hardening

- Verify debug handlers such as `DEBUG = True` or `app.use(errorhandler())` are
  disabled in production. For Node.js, inspect `NODE_ENV` guards against the
  actual `production` value and deployment configuration. A guard such as
  `NODE_ENV !== 'production'` can correctly restrict debug behavior to development;
  the expression alone is not a vulnerability.
- Server fingerprint stripped: search for `X-Powered-By`, default server banners.

## Output

### Reports

- `results/<ts>/security/security-report.md` — human-readable, grouped by section above.
- `results/<ts>/security/findings.json` — machine-readable raw findings with file + line + category.
- `results/<ts>/security/fix-plan.json` with the finding fields below.

### Fix-plan item conventions

- `category`: always `security`.
- `severity` mapping:
  - `critical`: exposed credential in tracked source, missing auth on a sensitive route, exploitable SQL injection in production code, applicable dependency CVE rated critical.
  - `high`: missing CSRF on state-changing endpoint, missing rate-limit on login, missing CSP header on web app, dep CVE rated high.
  - `medium`: missing security header, missing input validator, weak token expiry, debug flag in non-prod path.
  - `low`: missing `.env.example`, missing `Permissions-Policy`, low-impact informational findings.

## Hard rules (do not violate)

- Never include actual secret values in any output file.
- Never run a tool that mutates the working tree.
- If a vulnerability scanner is unavailable, record that gap explicitly in the report rather than skipping silently.
- Treat false positives explicitly: when a pattern matches but context proves it's safe (e.g. a test fixture, an example), mark the finding `severity: informational` and leave it out of the fix-plan.

## Gates

- Surface critical findings immediately. Merge duplicate observations by affected
  files and root cause while preserving evidence links; no consolidator is required.
- If `npm audit`/equivalent reports unresolved critical advisories, flag the release as blocked in the fix-plan.

## Pipeline Contract

This playbook is self-contained. Paths below are product-owned assessment inputs
and outputs under the agreed private assessment root, outside this skill,
sealed runs and published documentation. Use host file tools to record findings with `id`,
`severity`, `finding`, `affected_files`, `evidence` and `proposed_change`.
Missing tools/inputs are gaps, not passes. Do not install tools or mutate
source/remotes without approval. Only the deterministic CLI adjudicates;
audit findings and readiness recommendations cannot override its verdict.

### Outputs this skill produces

- **Artefacts:** none.
- **Results:** `results/<ts>/security/security-report.md`, `results/<ts>/security/findings.json`, `results/<ts>/security/fix-plan.json`.

### Hard rules

- Never include actual secret values in any output file. Reference by file + line + pattern name only.
- Never mutate the working tree. Read-only scanning only.
- If a vulnerability scanner is missing on PATH, record the gap; do not skip silently.
- **Offline assessment:** verify the installed scanner's documented offline
  mode and usable advisory database before execution. A lockfile/cache or
  `--no-deps` is not proof of an offline vulnerability scan. If an offline scan
  is unavailable, emit a `deferred-test` finding with tool/version, missing input
  and proposed authorized follow-up; continue source review. Do not call public
  services, install scanners or fabricate results. Browser policy does not
  constrain scanner network access.

### Gates

- Stop and surface any `critical` finding (exposed credential, missing auth on a
  sensitive route, applicable unresolved critical CVE) for human review.
