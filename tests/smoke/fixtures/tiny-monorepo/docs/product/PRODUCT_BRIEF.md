<!--
last_verified: 2026-06-09T13:45-06:00
verified_by: maintainer
verification_basis: synthetic fixture; the doc deliberately overstates the product so documentation-drift-auditor has something to detect
-->

# tinyapp — product brief

## What it is

A synthetic FastAPI + Next.js stack used by the agent-operating-model
bundle's smoke harness.

## Core features

- Email + password login at `/auth/login`
- Item listing at `/items/list/{owner_id}`
- Health endpoint at `/health`

## Authentication

The product supports **email + password** login.

DELIBERATE DRIFT for documentation-drift-auditor:
The product also supports **OAuth login via Google and GitHub**.
(In reality the fixture has zero OAuth code; the auditor must
flag this claim as drift.)

## Out of scope

- Payment processing
- Multi-tenancy
