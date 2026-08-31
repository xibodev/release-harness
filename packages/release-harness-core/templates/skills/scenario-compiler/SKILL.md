---
name: scenario-compiler
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
