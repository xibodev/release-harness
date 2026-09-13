# Security

Release-Harness executes deliberately accepted HTTP and CLI assertions, seals
the resulting evidence, and adjudicates it deterministically. It is not a
sandbox, an independent evidence authority, or a deployment authorization
system.

## Trusted execution

Run only contracts, bindings, repositories, executables, and fixtures you trust.
A CLI binding starts the declared executable directly with `shell: false`, but
that executable still has the invoking user's filesystem, process, and network
permissions. It may start other programs or explicitly invoke a shell.

The binding parser rejects shell composition such as pipelines and redirections
in the normal execution path. Windows and POSIX executable paths are structured
path data: separators, drive letters, spaces, and parentheses are not shell
syntax and do not require transport-layer quoting.

Use disposable environments and least-privilege credentials. Do not expose
production secrets to untrusted branches or executables.

## Failure attribution

Only a failed accepted assertion against a subject that was structurally reached
may become a PRODUCT finding. Missing executables, nonexistent file operands,
unreachable HTTP targets, unresolved normative references, harness failures, and
abnormal termination retain non-product causes.

stdout and stderr may be compared with an expectation the contract author chose,
and both are sealed separately. The harness never pattern-matches unexpected
stderr to decide whether software deserves a PRODUCT accusation.

## Evidence integrity and confidentiality

SHA-256 manifests detect inconsistency against recorded evidence. They do not
provide independent authenticity: someone able to replace evidence and its
manifest can construct a different internally consistent bundle. Protect the
producer, accepted contracts, source provenance, evidence storage, and access to
artifacts separately.

Evidence can contain credentials, personal data, internal URLs, response bodies,
and command output. Hashing does not encrypt it or make it safe to publish. Avoid
secrets in command arguments and outputs, use nonsecret fixtures, restrict
retention, and review artifacts before sharing. If a secret is exposed, rotate
or revoke it; redacting a later copy does not undo disclosure.

Preserve invalid evidence for investigation rather than editing or resealing it
to obtain another verdict.

## Contract and verdict scope

Acceptance records responsibility for an exact proposition. It is not proof,
authentication, or authorization. A PASS means the accepted assertions held for
the recorded bindings, exact normative references, and source in that run. It
does not prove complete coverage, absence of vulnerabilities, production safety,
or permission to deploy.

An exploratory run is never a certificate. An AI recommendation cannot override
the deterministic verdict or supply a missing acceptance decision.

## Reporting a vulnerability

Use the repository's [Security page](https://github.com/xibodev/release-harness/security)
and [Security Advisories](https://github.com/xibodev/release-harness/security/advisories)
for current reporting options. GitHub private vulnerability reporting is not
currently promised. If no private channel is available, request one without
including vulnerability details in a public issue.

Once a private route is agreed, include the affected version, impact, and a
minimal reproduction using synthetic data. Do not post secrets, sensitive
evidence, or working exploit details publicly.
