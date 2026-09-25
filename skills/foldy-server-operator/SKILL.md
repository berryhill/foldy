---
name: foldy-server-operator
description: Use when inspecting or operating a Foldy Server factory, project import, publication, or Cynder deployment readiness. Keep legacy and native deployment truth separate.
version: 1.0.0
author: Foldy
triggers:
  - "Foldy Server"
  - "deploy a Foldy to Cynder"
  - "Foldy deployment status"
  - "Foldy import preflight"
od:
  mode: utility
  category: operations
metadata:
  hermes:
    tags: [foldy, deployment, cynder, operations]
---

# Foldy Server operator

## Scope

Foldy Server is a factory and deployment/upgrade control plane. It is not the day-to-day editing, owner review, or publication surface of an autonomous Foldy. Each deployed instance separately owns its content, UI, owner authority, and project-scoped HTTPS MCP endpoint. Read `docs/foldy/README.md` and `docs/foldy/essential-mvi-contract.json` from the current repository checkout when available; outside the checkout use the public `berryhill/foldy` repository at a recorded commit. The contract's 20 Essential and seven Updates & Review criteria are requirements, not proof of implementation.

Do not confuse the Foldy Server URL (for example a workstation UI) with a deployed Foldy instance URL. An HTML SPA fallback returned from `/mcp/manifest.json` on Foldy Server is not an instance manifest and does not by itself establish a proxy defect.

## Safe read-first procedure

1. Resolve the exact server origin and project ID from the request. `GET /api/health` proves process liveness only; `GET /api/version` identifies the running package version, not its Git commit. Read `GET /api/projects/:id` and its file/revision metadata before acting. For imported folders, `metadata.baseDir` is external project custody; namespace SQLite alone is not a complete backup.
2. For an imported project, `od foldy import-preflight --project <id> --daemon-url <origin> --json` is a read-only preflight. `adopt-import` is a mutation requiring an exact preflight, explicit confirmation, and readback; never infer that importing also transfers approvals, credentials, or deployment state.
3. `GET /api/projects/:id/cynder/status?environment=<name>` belongs to the older gateway-oriented revision-file adapter. Its 503 `FOLDY_CYNDER_NOT_CONFIGURED` means that adapter lacks an endpoint and credential reference. Do not cure it with a guessed endpoint or treat its success as an autonomous-instance deployment.
4. Inspect `od native-deployment --help` and `/api/foldy/native-deployments/*` separately. Native prepare/execute/inspect/reconcile have quote and operation-custody foundations, but the production route remains fail-closed until a distinct deploying-owner resolver and authoritative hosting-admission service are wired. A viewer-password session never grants deployment authority. Report `FOLDY_OWNER_NOT_CONFIGURED` and `FOLDY_HOSTING_NOT_CONFIGURED` accurately. Do not route around them through the old adapter.

## Native deployment boundary

Before any signed prepare, require a deterministic sealed release and immutable OCI digest, actual provider capabilities for durable storage, one-use protected owner bootstrap, fenced single writer, HTTPS/MCP routing, and a bound lease/retention contract. A client-supplied admission flag or fixture is not provider enforcement. The owner must review an exact quote and separately authorize paid execution within a bound budget; no skill installation, prompt, or health probe grants spend authority. Preserve the original request, origin, operation ID, and idempotency key across uncertain results. Reconcile that same action before a retry. Payment settlement or a provider deployment read is not Foldy activation: require claim, storage/revision/route/MCP/identity proof and compare-and-swap activation. Until then report `foldyActivation: not_verified`.

The current Cynder source must be checked before offering deployment. Public HTTPS container routing exists, but do not claim durable volume, protected bootstrap delivery, writer fencing, or renewable hosting lease from an older skill snapshot or from schema fields alone. If those capabilities are absent, stop before payment and name the provider dependency.

## Workstation rollout is not instance deployment

For an authorized Foldy Server update, verify exact GitHub main SHA, CI, clean source, package bytes, isolated namespace, SQLite-safe snapshot plus all imported external folders, systemd/Tailscale route, project entry hash and browser hydration. A running workstation server proves only the factory rollout; it does not create a Cynder-hosted instance. Site-specific deployment automation belongs to the operator environment, not this portable skill.

## Verification and report

Report separately: project/revision identity; server package/process and HTTP/browser state; old-adapter status; native owner/admission readiness; exact quote/action/receipt state if separately authorized; instance URL and semantic health if actually deployed; CI/main parity. Never call the 20+7 MVI complete without one real instance's browser, MCP, access-denial, backup/restore, upgrade/rollback, and teardown evidence. Avoid printing credentials, signed payloads, viewer passwords, raw request bodies, or secret-bearing logs.
