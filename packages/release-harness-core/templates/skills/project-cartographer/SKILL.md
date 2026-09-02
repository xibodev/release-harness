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
5. Verify schema validity with `npx release-harness check-pr`.
