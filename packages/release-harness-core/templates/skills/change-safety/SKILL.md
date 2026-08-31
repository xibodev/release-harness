---
name: change-safety
description: Pre-commit/pre-push gate that inspects diffs for secret leaks, destructive deletions, and verifies clean git tree before release evaluation.
allowed-tools: [Read, Grep, Glob, Bash]
---

# Change Safety Gate

Verifies that the working tree is clean and safe for release adjudication.

## Steps
1. Run `npx release-harness check-pr`.
2. Inspect git diff for credentials, API tokens, or hardcoded secrets.
3. Ensure all tests and contract files are committed before certification runs.
