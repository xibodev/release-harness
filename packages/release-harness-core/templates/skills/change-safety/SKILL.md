---
name: release-harness-change-safety
description: Pre-commit/pre-push gate that inspects diffs for secret leaks, destructive deletions, and verifies clean git tree before release evaluation.
allowed-tools: [Read, Grep, Glob, Bash]
---

# Change Safety Gate

Verifies that the working tree is clean and safe for release adjudication.

## Steps
1. Run `npx release-harness check-pr`.
2. Inspect git diff for credentials, API tokens, or hardcoded secrets.
3. Ensure all tests and contract files are committed before certification runs.

Inspect command safety and project tooling first; `check-pr` can run configured
project commands. A dirty tree may be inspected without discarding it. Do not
stash, reset, commit or push user changes just to satisfy this check. Missing
tools or nonzero results are gaps to report; only the deterministic CLI
adjudicates certification. Findings go in an agreed private assessment location
outside sealed runs and published documentation, using available host file tools.
