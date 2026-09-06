# Copilot Instructions for Release-Harness

This repository uses @xibodev/release-harness for deterministic quality-gating and local UAT.

## Release Quality Workflow
1. Follow `AI-ADOPTION.md`. Inspect `npx release-harness skills list`, then doctor
   and `init --with-agents`. Restart the host if its catalog does not see new skills.
2. Use `release-harness-project-cartographer` and `release-harness-scenario-compiler`
   to derive contracts; present the generated artifact diff for human review.
3. Use `run-local --allow-dirty --evidence-dir <root>` while changes are uncommitted.
   Preserve user changes; do not stash/reset/commit them to make a gate pass.
4. Read `<root>/runs/<id>/verdict.json` and sealed files under its `evidence/`
   directory, including startup evidence. If no verdict exists, report diagnostics.
   Route by causes: fix PRODUCT_BUG, acquire missing fixtures, diagnose harness
   faults. Exit 3 UNKNOWN remains unresolved, not proof of a product defect.
5. Inspect underlying failed scenarios on exit 2. Preserve and investigate exit-4
   evidence; do not blindly clean or reseal it. Only the deterministic CLI certifies.
6. After approval and an authorized commit, rerun clean for exit 0. Integrate
   `check-pr` on PRs and `run-local` on release branches. Keep paired product_slug
   changes consistent; use canonical topology policy (legacy config supported,
   conflicts rejected). Browser filtering does not seal container networking.
7. Repair incompatible runtime frontmatter selectively, not with blanket
   `init --overwrite`, which resets project contracts too.
