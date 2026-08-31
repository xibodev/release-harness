<!--
last_verified: 2026-06-09T13:45-06:00
verified_by: maintainer
verification_basis: synthetic fixture; the registry deliberately omits one env var so documentation-drift-auditor has something to detect
-->

# Secret registry

Source of truth for every secret consumed by the tinyapp deployment.
Every secret consumed at runtime MUST be listed here with its
source, target environment, and rotation cadence.

## Secrets

| Key | Source | Used by | Rotation |
|---|---|---|---|
| `DATABASE_URL` | env | backend | manual on infra change |
| `REDIS_URL` | env | backend | manual on infra change |
| `JWT_SECRET` | env | backend | quarterly |
| `AWS_ACCESS_KEY_ID` | env | backend (object storage) | quarterly |

## Known gaps

DELIBERATE DRIFT for documentation-drift-auditor:
`.env.example` mentions `SECRET_FROM_ENV_EXAMPLE` but this registry
does not list it. The auditor must flag this as missing-registry-entry.
