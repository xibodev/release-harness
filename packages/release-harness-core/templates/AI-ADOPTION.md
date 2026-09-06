# Adopting Release-Harness

AI assistance is optional. The CLI can be used directly without agent scaffolding
or a separate operating model. Use the playbooks that fit your product; no fixed
set of product briefs, persona documents, backlog files or external agents is
required. Existing requirements, source code and confirmed user journeys are
valid inputs.

This is the standard integration protocol for AI coding agents. Contracts are
generated review artifacts: skills derive them from source, the human reviews
their diff, and the deterministic CLI executes and adjudicates them. Neither a
skill nor an agent can calculate, override, or talk a verdict into being green.

## Discover Before Scaffolding

The skills arrive with `init --with-agents`, not with `npm install`. Inspect the
packaged bundle without extracting anything:

```bash
npx release-harness skills list
npx release-harness skills info project-cartographer
npx release-harness skills info release-harness-scenario-compiler
```

`info` accepts bare and namespaced names. Invoke skills by their canonical
`release-harness-*` names, not similarly named user skills. `init --with-agents`
copies the bundle to `.claude/skills/`, `.agents/skills/`, and `.opencode/skills/`.
A bare `init` or `init --contracts-only` writes contracts only. Discovery reports
disk scaffold status, not whether the active host has registered the skill.
Invalid scaffold status means to inspect that file's metadata/path, not to
overwrite the project's contracts.

The bundle contains playbooks, not executable toolkits. The host must provide
file and shell tools, and screenshot review needs image input. Docker, browsers,
databases, vulnerability scanners and credentials are separate prerequisites;
scaffolding installs none of them. Use project-owned commands and authorized
local targets only. Missing tooling or observations are deferred checks, not
passes. Audit risk/visual scores never override the deterministic CLI verdict.

## Refresh The Host

Hosts may cache skills at session startup. After scaffolding, first check the
host's skill list for `release-harness-project-cartographer`.

- Claude Code: if the new skill is missing, exit and relaunch Claude Code from
  the same repository, then check its available skills again.
- opencode: if the catalog is stale, exit and restart the opencode process from
  the repository, then check discovery again.
- GitHub Copilot CLI: exit and relaunch the CLI in the repository if its session
  does not recognize the new skills.
- Cursor/Codex and other compatible hosts: use the host's documented session
  or window reload, or restart the host, and verify its catalog.

Exact hot-reload behavior varies by host/version; `/init` is not a portable
skill reload command. Preserve a short handoff before restarting. If restarting
is unavailable, read the scaffolded `SKILL.md` directly and follow its procedure
with available tools; do not claim a missing host tool was invoked.

## Golden Sequence And Phase Prompts

1. Run `npx release-harness doctor` and address reported prerequisites. Inspect
   `skills list`, then run `npx release-harness init --with-agents`. Refresh the host.
2. Cartographer: "Use release-harness-project-cartographer to derive topology
   and origins from actual services, ports, and health probes. Present the
   generated artifact diff for review, including configuration assumptions."
3. Compiler: "Use release-harness-scenario-compiler to compile these user
   journeys into declarative scenarios with independently verifiable side
   effects. Present the resulting diff for approval, not a blank schema."
4. Conductor: "Use release-conductor to run doctor and the local readiness
   gate with an explicit external evidence root. Report the deterministic
   verdict, causes, scenario results, and any startup evidence."
5. Remediation: "Use release-harness-fix-planner to derive an evidence-linked
   execution-plan.json from this run's verdict and logs. Wait for approval,
   then use release-harness-fix-executor for targeted fixes. Preserve unrelated
   working changes and never weaken contracts to force a pass."
6. While approved changes are uncommitted, run
   `npx release-harness run-local --allow-dirty --evidence-dir <external-root>`.
   Inspect underlying results; a complete dirty run is NON-CERTIFYING (exit 2),
   not a green release. Resolve failures and unmet conditions. After human
   approval and an authorized commit, rerun without `--allow-dirty` for certified
   exit 0. Do not commit or stash user changes merely to make a command pass.
7. Integrate `check-pr` on PRs and `run-local` on release branches only after
   establishing that clean baseline. The deterministic CLI is the decider;
   phase prompts and human review never substitute for its verdict.

## Evidence And Cause-Based Triage

Choose an agreed private external evidence root to keep outputs out of the source
repository and published documentation. Keep assessment reports, execution plans
and session handoffs in an agreed private location outside sealed runs as well.
Example `results/<ts>/...` paths in playbooks are relative to that assessment
root, not a required public documentation tree. Review any material separately
before publishing it; a hidden or gitignored directory alone is not a privacy
boundary. These assessment formats are agent notes, not CLI configuration or
automatically ingested evidence.

For `--evidence-dir <root>` and run ID `<id>`, read
`<root>/runs/<id>/verdict.json`, `<root>/runs/<id>/run.manifest.json`, and sealed
files under `<root>/runs/<id>/evidence/`, including its `evidence.manifest.json`.
Use the run ID printed by the CLI; do not guess `evidence/run-*/run-summary.json`.
Without an override, the root is the platform cache's `release-harness/<product_slug>`:
`LOCALAPPDATA`, then `XDG_CACHE_HOME`, otherwise `~/.cache`.

| Code | Meaning and action |
|------|--------------------|
| 0 | Certified only when the CLI reports PASS with complete, valid evidence. |
| 1 | Inspect causes: fix a demonstrated PRODUCT_BUG, acquire HARNESS_FIXTURE_MISSING inputs, or follow diagnostics if no verdict exists. |
| 2 | UNPROVEN: inspect scenario statuses, unmet conditions and waivers; resolve underlying failures before clean certification. |
| 3 | HARNESS_ERROR: inspect startup evidence, runtime diagnostics, and causes. UNKNOWN means attribution is unresolved, not a product defect. |
| 4 | EVIDENCE_INVALID: preserve the entire run, investigate the mismatch, and never edit/reseal evidence to obtain a pass. |

**Exit 3 means the harness could not do its job, not that the product is
broken.** A startup failure may leave sealed startup evidence before scenarios
execute. Use that evidence to distinguish an identified contract/environment
fault from an ambiguous failure (exit 3, `UNKNOWN`). Never classify by exit
number alone. If no verdict exists, report that absence and the CLI diagnostics;
do not fabricate a verdict or fix product code without evidence.

Startup evidence may contain only structured, secret-safe observations. Raw
build/Compose logs may be omitted; do not promise their capture or copy arbitrary
logs into a report without reviewing them for secrets.

Dirty development does not suppress integrity faults: harness errors keep exit
3 and invalid evidence keeps exit 4. Even exit 2 may contain failing scenarios.
Preserve exit-4 evidence before investigation; `clean` is resource cleanup, not
evidence repair. After investigation, use a new run ID for a new attempt.

## Materialization, Policy And Upgrades

Git-ignored local assets do not reach the detached source copy. Certification
excludes untracked files; dirty development includes nonignored untracked files.
Inspect `git status`, `git check-ignore`, and materialization warnings when a
build cannot find a fixture or `.env`. Commit non-secret assets only when
authorized; supply secrets via the project's approved runtime environment.

`topology.json.network_policy` is canonical. Legacy
`harness.config.json.network_policy` remains supported; conflicting declarations
are rejected. Migrate deliberately to one policy and review its diff. Browser
egress interception is not container-wide network sealing: configure and verify
container isolation separately, and use local mocks for external dependencies.

Existing projects keep their contracts and skill files by default. If changing
an existing `product_slug`, update topology and harness config together and
review both; do not change only one side. Repair incompatible runtime agent
frontmatter in the specific agent file using that host's documented format,
preserving its body and project customizations. Do not use blanket
`init --overwrite` or `--force` as an upgrade shortcut: it resets contracts too.
