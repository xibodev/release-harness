---
name: release-harness-project-cartographer
description: Scans the project repository to discover Docker Compose services, web/API routes, and health probes, populating .release-harness/topology.json and origins.json.
allowed-tools: [Read, Grep, Glob, Write]
---

# Project Cartographer

Discovers the project's service architecture and maps it into formal Release-Harness contracts.

## Steps
1. Inspect `docker-compose.yml`, `package.json`, `Dockerfile`, and application routes.
2. Identify served origins (web apps, APIs, workers).
3. Populate `.release-harness/topology.json` matching `topology-v1.json` schema.
4. Populate `.release-harness/origins.json` matching `origins-v1.json` schema.
5. Keep `product_slug` consistent between topology and harness config. On an
   existing project, propose a paired change rather than renaming only one.
6. Derive `topology.json.network_policy` from actual browser dependencies.
   Legacy config policy remains supported; conflicting declarations are
   rejected. Browser interception does not prove container-wide isolation.
7. Present the generated artifact diff for human approval. Preserve existing
   customizations; never use `init --overwrite` as a repair shortcut.
8. Run `npx release-harness doctor` using the calling agent's shell tool to
   check topology/origin validity. `check-pr` rejects a dirty tree for
   certification; do not discard or commit working changes just to pass it.
