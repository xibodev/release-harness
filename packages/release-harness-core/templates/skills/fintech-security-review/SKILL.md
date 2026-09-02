---
name: release-harness-fintech-security-review
description: Deep security review for high-risk apps (fintech, payments, PII, healthcare), from threat modeling to compliance — beyond release-harness-security-audit's OWASP quick scan. Emits a fix-plan. Use for "fintech security audit", "review for PCI-DSS", "audit payment flow", or "PII handling review".
compatibility: Works with any source repo. Optional integrations `osv-scanner`, `gitleaks`, `trufflehog`, `semgrep`, `bandit`, `eslint-plugin-security` if installed.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

## Purpose

Run an architecture-aware, threat-model-driven security review that produces actionable, prioritized fix-plan items — not a vague "looks risky" verdict. This skill complements `release-harness-security-audit` (which is the fast OWASP top-10 + secrets + dependency pass); use them together for high-risk apps.

**Use this skill when:** the project handles money, PII, payments, health data, identity, or any regulated information; or before a major release of such a system; or when a new third-party integration is added that touches sensitive flows.

**Use `release-harness-security-audit` instead when:** you just want the OWASP quick gate before every release.

## Required inputs

- Working tree of the repo.
- Optional but recommended: `artefacts/threat-model.md` (the agent `security-sentinel` interactively produces this — see its handoff). If absent, this skill will still run but will mark architecture-level findings as `evidence.confidence: low` and recommend the agent regenerate.
- Optional: previous `results/<ts>/security/security-report.md` for delta scoping.

## Relationship to `release-harness-security-audit`

| Concern | `release-harness-security-audit` (fast) | `release-harness-fintech-security-review` (deep) |
|---|---|---|
| Hardcoded secrets, leaked credentials | Yes (grep patterns) | Confirms + extends to key rotation, vault adoption |
| OWASP Top-10 spot checks | Yes | Extends to root-cause architectural pattern |
| HTTP security headers | Yes | Adds CSP nonce strategy, SRI for third-party JS |
| Dependency CVEs | Yes (offline DB) | Adds supply-chain provenance (SLSA, signed releases) |
| Threat model + trust boundaries | No | Yes |
| Authorization correctness (BOLA, IDOR) | Limited | Full per-route ownership-check audit |
| Cryptography correctness | No | Yes (algorithm choice, IV reuse, key isolation) |
| Audit log tamper-resistance | No | Yes |
| Reconciliation + idempotency on money flows | No | Yes |
| Compliance overlay (PCI-DSS, GDPR, SOC 2) | No | Yes |
| DevSecOps maturity (SAST/DAST/SCA in CI) | No | Yes |

The two skills MUST be run together for fintech-grade reviews. `security-sentinel` (the agent) does this automatically and the consolidator deduplicates overlap.

## Audit dimensions (the 13)

### 1. Threat model and architecture

Before reading implementation, the reviewer must understand the asset map and trust boundaries. If `artefacts/threat-model.md` exists, ingest it; otherwise produce a stub from code signals and mark `evidence.confidence: low`.

**What to evaluate**

- Asset inventory — money flows, balances, PII, KYC documents, payment instruments, auth tokens.
- Trust boundaries — client → API gateway → internal services → DB → external APIs.
- Attack surfaces — public APIs, mobile/web clients, admin panels, webhook receivers, service-to-service auth.
- Are security-relevant decisions centralized (one auth module, one money-movement module) or scattered?

**Signals to grep**

- Directories: `*/admin/*`, `*/internal/*`, `*/webhooks/*`, `*/payments/*`, `*/kyc/*`, `*/wallet/*`.
- Auth choke points: middleware files, decorators (`@require_auth`, `@authenticated`, `requireAuth(`).
- Money primitives: `Decimal`, `BigDecimal`, `BigInt`, `Money`, columns named `amount`, `balance`, `cents`, `minor_units`.

**Fix-plan items**

- `severity: critical` if money-movement logic is duplicated across modules with no single source of truth.
- `severity: high` if no central auth middleware (per-route ad-hoc checks).
- `severity: medium` if admin and customer surfaces share the same auth pipeline without segmentation.

### 2. Authentication and identity

**What to evaluate**

- MFA available and enforceable for users AND admins.
- No custom auth protocols — must use OAuth2 / OIDC / SAML or a vetted library.
- Password hashing uses `bcrypt`/`argon2`/`scrypt`. Reject `md5`, `sha1`, raw `sha256(password)`, `crypto.createHash('md5')` on credentials.
- Session lifetime, rotation on privilege change, invalidation on logout.
- Token-based: short-lived access token (≤ 15 min) + refresh token with rotation + revocation list.

**Signals to grep**

- `bcrypt|argon2|scrypt` (hashing OK) vs `md5|sha1|sha256.*password|sha512.*password` (smell).
- `jwt.sign(...{expiresIn})` — flag missing `expiresIn` or values > `30d`.
- `Set-Cookie` without `HttpOnly`, `Secure`, `SameSite`.
- `passport-local` without lockout/rate-limit middleware on login route.
- Admin routes (`/admin`, `/internal`) without MFA gate.

**Fix-plan items**

- `severity: critical` for weak hash on stored passwords, JWT with no expiry, admin route without MFA.
- `severity: high` for refresh-token without rotation, missing lockout on login.
- `severity: medium` for missing `SameSite=Strict` on session cookies.

### 3. Authorization (most commonly broken — OWASP #1)

**What to evaluate**

- Every route enforces authorization SERVER-SIDE. Client-side hiding does not count.
- Ownership checks: a user can only access THEIR records. Look for `WHERE user_id = :current_user` patterns.
- Role-based or attribute-based: centralized policy, not `if (user.role === 'admin')` sprinkled everywhere.
- Object-level authorization on every `GET /<resource>/:id` (BOLA / IDOR).

**Signals to grep**

- Routes that fetch by id without an ownership predicate: `findOne({ id })`, `Model.objects.get(id=...)`, `SELECT * FROM x WHERE id =`.
- Scattered role checks: `isAdmin|is_admin|hasRole|user.role ==` outside a centralized policy module.
- Admin endpoints that take a `user_id` parameter (impersonation vector).
- GraphQL resolvers without field-level auth (`@auth` directive missing).

**Fix-plan items**

- `severity: critical` for any endpoint fetching by id without ownership check on PII / money / KYC routes.
- `severity: high` for scattered role checks (refactor to central policy).
- `severity: high` for admin "switch to user" without dual approval or audit logging.

### 4. Data protection and privacy

**4.1 Encryption**

- TLS 1.2+ everywhere; reject TLS 1.0/1.1; HSTS with `max-age ≥ 15552000`.
- AES-256-GCM at rest for sensitive blobs; column-level encryption for PII (national ID, card data, bank account).
- Tokenization for card data (PCI-DSS scope reduction).

**4.2 Data minimization**

- Verify the system actually NEEDS the data it stores. Flag oversized PII columns (full DOB when age suffices, full address when zip suffices, full card PAN when last 4 suffices).

**4.3 Leakage**

- No sensitive data in URLs, query strings, error responses, or logs.
- Response caching disabled for sensitive endpoints (`Cache-Control: no-store`).

**Signals to grep**

- `http://` literals in projection source (non-test, non-localhost).
- Plaintext PII columns in migrations: `national_id VARCHAR`, `card_number VARCHAR`, `ssn VARCHAR`, `bank_account VARCHAR` without `bytea` / encryption wrapper.
- Logger calls with `req.body`, `password`, `token`, `apiKey`, `ssn`, `pan`, `cvv`, `iban`, `account_number` (use regex `logger\.(info|warn|debug)\(.*\b(req\.body|password|token|api_?key|ssn|pan|cvv|iban|account_number)\b`).
- `GET /reset?token=` (token in URL — should be POST body).

**Fix-plan items**

- `severity: critical` for plaintext storage of PAN, CVV, full PII; HTTP literal on payment route.
- `severity: high` for sensitive data in logs, missing HSTS, missing column encryption.
- `severity: medium` for overcollection of PII without business justification.

### 5. Cryptography correctness

**What to evaluate**

- No homemade crypto. Use vetted libraries.
- Key isolation — keys in a vault (Key Vault, KMS, HSM), not in env vars on app servers.
- Key rotation cadence and procedure.
- Secure RNG for tokens: `crypto.randomBytes`, `secrets.token_urlsafe`, `SecureRandom`. Reject `Math.random()` / `random.random()` for security tokens.
- Symmetric encryption with authenticated mode (GCM, ChaCha20-Poly1305); reject ECB and unauthenticated CBC.
- IV / nonce never reused with the same key.
- HMAC for signed cookies / webhook verification with constant-time comparison.

**Signals to grep**

- `Math.random|random\.random|rand\(\)` in token / id / password-reset generation.
- `createCipheriv\(.*'aes-..-ecb'`, `Cipher\.getInstance\("AES/ECB"`.
- Hardcoded `iv = Buffer.from('0000` (static IV).
- String equality (`==` / `===`) on HMAC verification (should be `crypto.timingSafeEqual` / `hmac.compare_digest`).
- Symmetric key in `.env` / config: `ENCRYPTION_KEY=`, `SECRET_KEY_BASE=` (should be vault reference).

**Fix-plan items**

- `severity: critical` for ECB mode on sensitive data, static IV, `Math.random()` for password reset tokens, non-constant-time HMAC compare.
- `severity: high` for keys in env vars instead of vault, no documented rotation procedure.
- `severity: medium` for missing automated rotation tooling.

### 6. Secrets management

**What to evaluate**

- No secrets in source. No secrets in repo history (run `gitleaks --log-opts="--all"` if available).
- Vault (Azure Key Vault, AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager) is the source of truth.
- Automated rotation enabled where the platform supports it.
- Secret scanning in CI (gitleaks, trufflehog, GitHub secret scanning).

**Signals to grep**

- Tracked `.env` files (must be gitignored).
- High-confidence patterns: `AKIA[0-9A-Z]{16}`, `AIza[0-9A-Za-z\-_]{35}`, `ghp_[0-9A-Za-z]{36}`, `xox[baprs]-[0-9A-Za-z-]+`, JWT `eyJ` prefix in source, `-----BEGIN .* PRIVATE KEY-----`.
- `password\s*=\s*['"][^'"]{6,}['"]`, `api_?key\s*=\s*['"][A-Za-z0-9]{20,}['"]`.

**Fix-plan items**

- `severity: critical` for any live credential in tracked source or git history.
- `severity: high` for missing vault adoption (secrets in env vars on app servers).
- `severity: medium` for no automated rotation, no CI secret scanning.

### 7. Input validation and injection protection

**What to evaluate**

- Server-side validation on every external input via a schema validator (`zod`, `joi`, `yup`, `class-validator`, `pydantic`, `FluentValidation`).
- Parameterized queries everywhere — no string concatenation, no f-strings in SQL.
- HTML output is escape-by-default (React, Vue, Jinja autoescape on). `dangerouslySetInnerHTML` / `v-html` / `|safe` flagged.
- File uploads: explicit mime allow-list, size limit, virus scan for documents.
- Path traversal: any `fs.readFile(userInput)` or `os.path.join(BASE, userInput)` without `path.resolve` and prefix check.
- Server-side request forgery (SSRF): any `fetch(userInput)` / `requests.get(userInput)` without an allowlist (block private IP ranges).
- XXE: XML parsers configured with external entities disabled.
- Deserialization: no `pickle.loads` / `yaml.load` / `unserialize` on untrusted input.

**Signals to grep**

- `"SELECT.*\+\s*\w+`, `f"SELECT.*\{`, `String\.format.*SELECT`.
- `dangerouslySetInnerHTML`, `v-html`, `innerHTML\s*=`, `|safe` in Jinja.
- `fs\.readFile\(req\.`, `open\(request\.`, `path\.join\([^,]+,\s*req\.`.
- `fetch\(req\.`, `requests\.(get|post)\(request\.`.
- `pickle\.loads|yaml\.load\(.*\)` (yaml.load without SafeLoader).

**Fix-plan items**

- `severity: critical` for SQL string concatenation on user input, deserialization of untrusted input, unrestricted SSRF.
- `severity: high` for missing validator on payment / KYC endpoints, path traversal on file APIs.
- `severity: medium` for missing validator on non-sensitive endpoints, missing CSP for inline scripts.

### 8. API and integration security

**What to evaluate**

- OAuth2 / signed requests / mTLS for service-to-service.
- Rate limiting and abuse detection on EVERY external endpoint, especially auth and money-movement.
- Idempotency on financial operations: `Idempotency-Key` header honored, replay detection.
- Webhook receivers verify signatures with constant-time HMAC.
- No blind trust in upstream services — validate every response field used in business logic.
- API versioning + deprecation path.
- API documentation that does not leak internal schema (OpenAPI exposed only with auth).

**Signals to grep**

- Money-movement routes (`POST /transfer`, `POST /payments`, `POST /payout`) — check for rate-limiter middleware AND idempotency handler.
- Webhook routes: search for signature verification (`x-hub-signature`, `Stripe-Signature`, `X-Slack-Signature`) and confirm constant-time compare.
- `cors({origin: true})`, `Access-Control-Allow-Origin: \*` on authenticated routes.

**Fix-plan items**

- `severity: critical` for money-movement endpoint with no rate limit, webhook with `==` compare on signature, missing idempotency.
- `severity: high` for `cors({origin: true})` on authenticated routes, OpenAPI exposed without auth.
- `severity: medium` for missing rate-limit on non-financial endpoints.

### 9. Logging, monitoring, and auditability

**What to evaluate**

- Audit trail for: money movement, data access (especially admin reads of customer data), auth events (login, MFA, password reset, permission change), KYC state changes.
- Logs are tamper-evident (write-once store, hash chain, or SIEM ingestion with retention).
- Structured logs with correlation IDs (`request_id`, `trace_id`).
- No sensitive data in logs (re-check section 4.3).
- Real-time anomaly detection or at least alerting thresholds for: failed-login spike, large transfer, new-device-from-new-country.

**Signals to grep**

- Money-movement modules: confirm there's an audit-log call (e.g. `AuditLog.create`, `audit_log.info(`, `events.publish('payment.`).
- Admin actions: confirm audit-log call on every admin route.
- Logger configuration: structured JSON output enabled (`pino`, `winston` with json format, `structlog`, `serilog`).

**Fix-plan items**

- `severity: critical` for missing audit log on money movement or admin impersonation.
- `severity: high` for plaintext logs on disk with no retention/rotation policy, no SIEM ingestion path.
- `severity: medium` for missing correlation IDs, missing alerting thresholds.

### 10. Resilience, recovery, and durability

**What to evaluate**

- Backups: encrypted, off-site, automated, restore-tested at least quarterly.
- Disaster recovery plan documented with RTO / RPO targets.
- Idempotency on critical operations (replay-safe).
- Reconciliation: end-of-day matching against payment processor, ledger consistency checks.
- Outbox pattern for cross-service events (no lost events on crash).
- Retry strategy with backoff + dead-letter queue for failed jobs.
- No single point of failure for money flow.

**Signals to grep**

- Payment / transfer modules: look for `Outbox`, `OutboxEvent`, idempotency table / Redis-keyed dedup.
- Background jobs (`celery`, `sidekiq`, `bull`, `arq`, `dramatiq`): look for retry config + DLQ.
- Migrations folder: look for reconciliation tables (`ledger_entries`, `reconciliation_runs`).

**Fix-plan items**

- `severity: critical` for missing idempotency on transfer endpoint, no reconciliation job.
- `severity: high` for no documented DR plan, no DLQ on critical jobs.
- `severity: medium` for backups without quarterly restore test.

### 11. Supply chain and dependencies

**What to evaluate**

- All dependencies version-locked (`package-lock.json`, `requirements.txt` with hashes, `poetry.lock`, `Cargo.lock`).
- Dependency CVE scanning in CI with offline DB (see sealed-UAT note below).
- Supply-chain attestation where available: SLSA provenance, signed releases (Sigstore), `npm install --ignore-scripts` for CI installs.
- Pre-install / post-install scripts reviewed.
- Private registry or proxy for internal packages (avoid public-namespace confusion).
- Dependabot / Renovate enabled with auto-PRs for security advisories.

**Signals to grep**

- Lockfile presence: `package-lock.json`, `yarn.lock`, `poetry.lock`, `Pipfile.lock`, `Gemfile.lock`, `Cargo.lock`, `go.sum`.
- CI files (`.github/workflows/*.yml`, `azure-pipelines.yml`, `.gitlab-ci.yml`) for `npm audit`, `pip-audit`, `osv-scanner`, `snyk`, `trivy` steps.
- `package.json` for `"scripts": { "preinstall": ..., "postinstall": ... }` — review what runs.

**Fix-plan items**

- `severity: critical` for unresolved critical CVE in projection dependency.
- `severity: high` for missing lockfile, no CI vuln scan, suspicious install scripts.
- `severity: medium` for outdated deps with no auto-update tooling.

### 12. Compliance and governance overlay

For each detected compliance regime (inferred from repo signals — payment terms, GDPR DSAR routes, HIPAA PHI columns, SOC 2 audit-log requirements), map findings to the relevant control.

**PCI-DSS signals (cardholder data)**

- Columns: `pan`, `card_number`, `cvv`, `cvc`, `cardholder_name`, `expiry`.
- Stripe / Adyen / Braintree SDKs.
- Required: no plaintext PAN storage, tokenization, network segmentation, quarterly ASV scans.

**GDPR signals (EU PII)**

- Routes: `/api/user/export`, `/api/user/delete`, `/data-subject-request`, `/dsar`.
- Required: user-data export endpoint, deletion (right-to-be-forgotten) endpoint, consent storage, breach-notification runbook, DPIA for high-risk processing.

**HIPAA signals (PHI)**

- Columns: `diagnosis`, `prescription`, `medical_record`, `phi_*`.
- Required: BAA on cloud providers, encryption-in-transit + at-rest, access logs with patient-level granularity.

**SOC 2 / ISO 27001 signals**

- `compliance/`, `audit/`, `policies/` folders.
- Required: change management evidence (PR reviews), access-review cadence, incident response runbook.

**Fix-plan items**

- For each detected regime, emit one `severity: high` item per missing control with `evidence.regime: "<PCI-DSS|GDPR|HIPAA|SOC2>"`, `evidence.control: "<short id>"`.

### 13. DevSecOps and SDLC maturity

**What to evaluate**

- SAST in CI (`semgrep`, `codeql`, `bandit`, `eslint-plugin-security`).
- SCA in CI (vuln scanners — see section 11).
- DAST or interactive scan (`zap`, `burp`) at least pre-release on staging.
- Required security review on PRs (CODEOWNERS for security-sensitive paths).
- Threat-model artifact in repo updated on architecture changes.
- Pre-commit hooks: `gitleaks`, `detect-secrets`, lint, format.
- Branch protection: required reviews, signed commits where possible.

**Signals to grep**

- `.github/workflows/*.yml` for SAST/SCA/DAST tool invocations.
- `.github/CODEOWNERS` with security-sensitive paths assigned to a security team.
- `.pre-commit-config.yaml` with secret-scan hook.
- `.github/dependabot.yml` or `renovate.json`.

**Fix-plan items**

- `severity: high` for no SAST or SCA in CI, no CODEOWNERS on security-sensitive paths.
- `severity: medium` for no pre-commit hooks, no signed commits, no DAST.
- `severity: low` for missing threat-model artifact (deferred — agent regenerates from interview).

## Mental model (what the reviewer asks)

For every dimension, the reviewer applies the attacker lens:

> "If I were an attacker, how would I steal money, data, or identities here?"

Then verifies the codebase answers four questions in the negative:

1. Can I bypass authentication?
2. Can I escalate privileges?
3. Can I access data I shouldn't?
4. Can I exploit timing / consistency / replay across services?

Each dimension's fix-plan items are framed against these four questions in `evidence.attacker_question`.

## Output

### Reports

- `./.quality-run/results/<ts>/security/fintech-review.md` — human report, grouped by the 13 dimensions, with executive summary at top.
- `./.quality-run/results/<ts>/security/fintech-findings.json` — machine-readable raw findings (file, line, dimension, signal, attacker_question).
- `./.quality-run/results/<ts>/security/fintech-fix-plan.json` — shared Fix Plan Schema (see suite README).

### Fix-plan item conventions

- `category`: always `security`.
- `source`: `release-harness-fintech-security-review`.
- `evidence.dimension`: 1–13 (matches sections above).
- `evidence.attacker_question`: one of `bypass-auth`, `escalate-privilege`, `access-forbidden-data`, `exploit-consistency`.
- `evidence.confidence`: `high` (signal directly observed), `medium` (signal implied), `low` (no threat model to anchor against).
- `evidence.regime` (optional): `PCI-DSS`, `GDPR`, `HIPAA`, `SOC2` when section 12 applies.
- `severity` mapping per dimension table above.

### Deferred-test fix-plan items (sealed-UAT)

When a check requires the public internet (live CVE DB, external SSL/TLS probe, public registry lookup), emit a `category: "deferred-test"` item with `evidence.reason: "requires-internet"` and `evidence.what_to_run_offline: "<concrete mitigation>"`. Do not silently skip.

## Hard rules (do not violate)

- Read-only scanning. Never mutate the working tree. Fixes are produced as recommendations and applied by `release-harness-fix-executor` only after explicit user approval.
- Never include actual secret values in any output file. Reference by file + line + pattern name.
- If a tool is unavailable, record the gap explicitly rather than skipping silently.
- Treat false positives explicitly. When a pattern matches but context proves it safe (test fixture, example, mock), mark `severity: informational` and exclude from the fix-plan.
- Never invent compliance regime applicability. If signals are absent, do not emit PCI-DSS / GDPR / HIPAA / SOC 2 items — surface "no compliance signals detected, confirm with the operator" in the report instead.

## Pipeline Contract

Standard pipeline contract applies — working directory, `./.quality-run/` layout (artefacts vs results), worktree-only rules, and gate semantics per `references/pipeline-contract.md` (vendored into this skill's install). This skill's specifics:

### Required input

- Working tree of the repo.
- Optional: `artefacts/threat-model.md` from `security-sentinel` (the orchestrating agent). If present, ingest it; if absent, run with `evidence.confidence: low` on architecture-level items.

### Outputs this skill produces

- **Artefacts:** none.
- **Results:** `results/<ts>/security/fintech-review.md`, `results/<ts>/security/fintech-findings.json`, `results/<ts>/security/fintech-fix-plan.json`.

### Hard rules

- Never include actual secret values in any output file.
- Never mutate the working tree. Read-only scanning only.
- If a scanner is missing on PATH, record the gap; do not skip silently.
- Coordinate with `release-harness-security-audit` — when the same finding is produced by both skills, the consolidator dedupes by `affected_files + title`. This skill should produce DEEPER framing (architectural root-cause, compliance overlay) so the merged entry is richer.
- **Sealed UAT — no internet.** Same rule as `release-harness-security-audit`. Vuln-DB and external probe steps require offline DBs (`osv-scanner --offline-vulnerabilities <dir>`, cached `npm audit`, `pip-audit --no-deps`). If no cached DB is present under `artefacts/security-db/`, emit one `deferred-test` fix-plan item per missing DB. Do not call out to any public service.
- **Worktree-only.** No `git fetch`, no `git pull`, no remote refs. If the review wants a delta against a baseline, require the local ref (the agent provides it from `release/baseline.json`).

### Gates

- Stop and surface every `critical` finding before the consolidator runs.
- If the compliance overlay (section 12) detects PCI-DSS signals AND finds a `critical` item in section 4 (data protection), mark the release as blocked in the fix-plan via a top-level `evidence.release_blocking: true` flag for `release-harness-release-decider` to honor.
