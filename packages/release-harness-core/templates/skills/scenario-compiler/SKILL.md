---
name: release-harness-scenario-compiler
description: Translates user personas, authentication flows, and user stories into declarative Playwright scenarios (.release-harness/scenarios/*.json).
allowed-tools: [Read, Grep, Glob, Write]
---

# Scenario Compiler

Compiles user journeys into deterministic JSON/YAML scenarios for Release-Harness.

## Scenario Schema Verbs
- `navigate`: `{ "action": "navigate", "target": "/path" }`
- `fill`: `{ "action": "fill", "target": "#selector", "value": "text" }`
- `click`: `{ "action": "click", "target": "button.submit" }`
- `assert`: `{ "action": "assert", "target": "text:Expected Text" }`
- `screenshot`: `{ "action": "screenshot" }`
- `negative_control`: `{ "expected_http_status": 401, "expected_rejection_reason": "invalid_credentials" }`

## Steps
1. Review user stories, authentication flows, and form inputs.
2. Author declarative scenarios in `.release-harness/scenarios/<scenario-id>.json`.
3. Ensure every browser_app origin has at least one required scenario.
4. For every scenario whose journey produces state outside the browser -- a
   file, an email, a cache entry, a stored object -- add `expected_side_effects`
   so the scenario asserts the product's output and not only its UI. See
   "Asserting side effects" below.

## Asserting side effects

A scenario that only drives the UI proves the UI responded. It does not prove
the product did its job. Add `expected_side_effects` to the scenario to assert
what the product actually produced.

Each entry declares `service`, `probe_type`, and `params`. Both `service` and
`probe_type` are closed enums in `scenario-v1.json`, and the contract is
validated at load time -- a value outside the enum is rejected with a message
naming the allowed values, not discovered deep in a run.

### Named probes

Use a named probe when the effect lands in a service the harness already
speaks:

```json
{
  "expected_side_effects": [
    { "service": "minio", "probe_type": "s3_object_exists",
      "params": { "bucket": "uploads", "key": "invoice-42.pdf", "expected_content_type": "application/pdf" } },
    { "service": "redis", "probe_type": "redis_key_exists",
      "params": { "key": "session:abc" } },
    { "service": "mailpit", "probe_type": "mail_received",
      "params": { "to": "user@example.com", "subject": "Your receipt" } }
  ]
}
```

| service | probe_type | key params |
|---|---|---|
| `minio` / `s3` | `s3_object_exists` | `bucket`, `key`, `expected_content_type`, `expected_sha256` |
| `minio` / `s3` | `s3_object_absent` | `bucket`, `key` |
| `redis` | `redis_key_exists` / `redis_key_absent` | `key` |
| `redis` | `redis_key_value_equals` | `key`, `expected_value` |
| `mailpit` | `mail_received` | `to`, `subject`, `contains_text` |
| `mailpit` | `mailpit_inbox_empty` | -- |

An S3 probe also accepts `forbidden_paths` plus `observed_storage_path`, which
fails the scenario when the product wrote to a local path such as `/tmp/*`
instead of to object storage.

`host` and `port` default to the service's conventional address. Leave them
unset unless the topology says otherwise: when a run uses `--port-offset`, the
harness shifts a declared numeric `port` for you, and `absolute_port: true`
opts a probe out of that shift.

### `sql_query` is not implemented

The harness ships no SQL client. A scenario declaring `service: "postgres"` with
`probe_type: "sql_query"` fails as a harness configuration error (exit 3); it
does not evaluate `expected_rows_count` or `forbidden_values`. Assert database
state with a custom probe that runs your own query tool.

### The custom probe

Use a **custom probe** when the product's real deliverable is a file -- a
rendered video, a compiled binary, a generated PDF, an exported dataset -- or
when you need an assertion the named probes cannot express:

```json
{
  "expected_side_effects": [
    { "service": "custom", "probe_type": "custom",
      "params": {
        "command": "./scripts/probe-artifact.sh",
        "args": ["renders/final.mp4"],
        "expect_exit_code": 0
      } }
  ]
}
```

The harness runs the command from the materialized workspace with no shell in
between, compares the exit code to `expect_exit_code`, and seals stdout and
stderr as evidence under `evidence/probes/`. `params.timeoutMs` overrides the
60-second default. The harness holds no opinion about what the command checks --
that judgment is yours.

**The exit code is the whole verdict.** There is no `expect_stdout_contains`:
stdout and stderr are captured as evidence for a human to read, never matched
against. Every condition you care about must be expressed as an exit code by
your own script.

**Rules for custom probes:**

- **Commit the script.** The command must live in the repository at the
  declared path. A command generated at run time would let the thing being
  certified author its own assertion, which is the one thing certification
  cannot allow.
- **Exit 0 means the assertion held.** Any other exit code fails the scenario as
  a product failure. Write diagnostics to stderr -- they are captured in
  evidence and shown to the operator.
- **Assert the deliverable, not the mechanism.** Check that the `.mp4` is valid
  H.264 of the expected duration, not that ffmpeg was invoked. A probe that
  asserts a tool ran certifies nothing about what it produced.
- **Keep it deterministic and offline.** No network, no wall-clock dependence,
  no reliance on machine-specific state. A probe that flakes turns the gate into
  noise, and a probe that reaches the network makes the run non-reproducible.
- **Assert one thing per probe.** Declare several `expected_side_effects`
  entries rather than one script that checks everything; a failing exit code
  then names which assertion broke.
