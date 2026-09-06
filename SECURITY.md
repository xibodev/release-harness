# Security

Release-Harness evaluates declared quality gates. It is not a sandbox for
untrusted repositories, an independent evidence authority, or a deployment
approval system.

## Trusted Execution

Run only repositories, contracts, dependencies, fixtures, and container images
you trust. Build scripts, configured PR commands, and custom probes can execute
on the host with the invoking user's permissions. Docker access can grant broad
host privileges through mounts, privileged containers, or the daemon socket.
Detached source workspaces do not isolate these capabilities.

Custom probes use `shell: false` to pass arguments without implicit shell parsing.
This is not trusted isolation: a declared executable can still read files, access
the network, execute other programs, or explicitly invoke a shell. Review commands
and Compose definitions before execution. Use disposable test environments with
least-privilege credentials; do not expose production secrets to untrusted PRs.

## Evidence Integrity And Confidentiality

SHA-256 hashes and sealed manifests detect inconsistency against recorded evidence.
They do not provide independent authenticity: someone able to replace both the
evidence and its manifest can construct a new consistent bundle. Protect the
producer, source provenance, evidence store, and artifact access separately.

Evidence may contain PII, credentials, URLs, screenshots, traces, attachments,
custom-probe stdout/stderr, and command arguments. Redaction is pattern-based and
does not guarantee removal of every secret or personal datum from every format.
Avoid secrets in arguments and outputs; use nonsecret fixtures and review all
artifacts before sharing. Restrict access and retention for evidence and CI logs.
Hashing does not encrypt data or make it safe to publish.

Version 2.0.0 startup diagnostics omit arbitrary build/Compose logs to reduce secret
capture. That does not make other evidence automatically confidential or safe.
If a secret is exposed, revoke or rotate it; redacting a later copy does not undo
the disclosure. Preserve original invalid evidence securely for investigation
rather than editing or resealing it to obtain a different verdict.

## Browser Network Boundary

The destination-filtering proxy behavior described here is included in **2.0.0**;
do not assume these transport protections from `1.2.0`.
See [CHANGELOG.md](CHANGELOG.md) for migration guidance.

In sealed mode, harness-managed Chromium HTTP and WebSocket traffic uses a
destination-filtering proxy. HTTPS/WSS tunnels are checked by destination host,
port, and transport, not by decrypted request content, TLS SNI, or certificate
identity. An allowed service that relays traffic is outside this boundary.

Non-proxied WebRTC UDP is suppressed, but blocked attempts do not produce
individual verdict violations. Suppression is not per-attempt audit coverage.
The browser policy is not a container firewall and does not constrain arbitrary
host commands, custom probes, builds, or other processes. Missing policy retains
legacy open behavior with a warning; configure policy explicitly and use separate
OS/container/network controls where isolation is required.

## Verdict Scope

`PASS` means the evaluator's declared requirements were met by the accepted
evidence. It does not prove complete test coverage, absence of vulnerabilities,
production safety, or permission to deploy. An AI review or advisory score cannot
override a deterministic verdict. Unsupported probes such as `sql_query` cannot
serve as successful checks; use a trusted probe that makes the required assertion.

## Reporting A Vulnerability

Check the repository's [Security page](https://github.com/xibodev/release-harness/security)
and [Security Advisories](https://github.com/xibodev/release-harness/security/advisories)
for reporting options and published notices. GitHub private vulnerability
reporting is not currently enabled for this repository; these links are not a
promise of an available private submission channel.

Contact a maintainer privately using a contact method they have published, if one
is available. If no private route is listed, ask for a secure contact method
without including vulnerability details. Do not post secrets, sensitive evidence,
or exploit details in a public issue. Once a private route is agreed, include the
affected version, impact, and a minimal reproduction using synthetic data. No
response-time or supported-version guarantee is stated here.
