# Preserved-copy migration (manually provisioned test instance)

This is an offline, deployment-principal packaging operation, not a public import API or native Cynder deployment. It never updates the original Foldy project, URL, publication pointer, credentials or runtime. The autonomous copy receives separate owner/viewer/MCP custody. Retain the original and the reviewed export as recovery inputs.

## Obtain and review a source

1. Select one **existing, small, non-sensitive** original project. Inspect it in the original owner workstation before exporting. Do not use private material for ChatGPT acceptance.
2. Use the existing original-project **Download as .zip** workflow (`GET /api/projects/:id/archive`) and safely extract the content-only tree into a fresh, operator-controlled directory. Do not use a live `.od/` project/state directory, silently select a subset, flatten paths, or export authority/database/credential material. Reject unsafe archive paths and links before extraction. Record the exact original project overview HTTPS URL and its project ID.
3. Freeze this export while inspecting/building: no concurrent writer is supported. Review **every** member for custody and sensitivity, then record exact paths, media types, byte lengths and SHA-256 digests in the plan below. The CLI's pattern checks cannot identify arbitrary secrets; its no-op content-classification adapter relies on this separately authenticated local-principal review. A plan supplied by an untrusted web request is NOT authorization.
4. Record the approved immutable source revision ID and its authority/provenance. If the original source has no immutable revision, the deploying principal must approve and name the exact frozen export inventory; describe it as an export snapshot, never invent an original publication revision. Keep the original URL and `projectId` unchanged. Choose a **new** autonomous `instanceId`, a recorded `workbookId`, and the independently verified built runtime OCI digest/version. Do not substitute a synthetic digest for a deployable release.

## Plan and commands

Write a local UTF-8 JSON plan **outside the source tree**, following `MigrationPlan` in `src/migrate.ts`:

- `schemaVersion`: `foldy-preserved-copy-plan.v1`.
- `sourceProjectUrl`: exact original overview URL, `https://HOST/projects/PROJECT_ID` (or the existing `/api/projects/PROJECT_ID` identity route); no credentials, query or fragment.
- `provenance`: nonsecret owner-reviewed source/export approval description; keep sensitive operational details out.
- `revision`: the existing `ApprovedRevision` contract: `instanceId`, `projectId`, `workbookId`, `revisionId`, `runtimeImageDigest`, `runtimeVersion`, `approvedRevisionId` equal to `revisionId`, `frozen: true`, `members`; optionally the existing approved `protectedPaths`.
- Each member: exactly `path`, `mediaType`, `bytes`, `sha256`, `executableMode: 0`. Preserve the complete original content inventory and exact bytes, including `index.html`.

These are local trusted-principal assertions, not cryptographic evidence of a remote approval. Keep the plan/source/report private and immutable during packaging. No owner assertion, password or MCP token belongs in them.

Build on Node 24 with pinned pnpm, then use absolute paths:

```sh
pnpm --filter @open-design/foldy-runtime build
node apps/foldy-runtime/dist/migrate.js \
  --source-dir "$REVIEWED_SOURCE" --plan-file "$REVIEWED_PLAN" --dry-run
node apps/foldy-runtime/dist/migrate.js \
  --source-dir "$REVIEWED_SOURCE" --plan-file "$REVIEWED_PLAN" \
  --output-dir "$FRESH_BUNDLE_DIRECTORY"
```

Dry-run performs inventory/hash/size/identity/dependency/compatibility validation without creating target state. A successful run prints a deterministic `foldy-preserved-copy-report.v1` JSON object including original URL/provenance, source inventory, revision and trusted-to-that-reviewed-plan bundle digest. An unsuccessful run exits nonzero with reason codes, never source bytes. Do not treat an `ok:false` report as an import.

A successful write creates only a fresh standard `foldy-release-bundle.v1` bundle and an adjacent `.migration-report.json` sidecar. Existing outputs, broken symlinks and source/target overlap are rejected. It does not start a service, create owner authority or change original content. The release loader independently verifies the written bundle. Failures after target creation can leave a partial target/report pair: retain it, consider it unavailable, inspect it offline and choose a fresh target; do not delete or overwrite original data to retry.

## Compatibility and preservation

The supported subset is the runtime's existing static HTML/CSS, text/JSON, PNG/JPEG/WebP and WOFF2 allowlist, with closed local dependencies. Original active JavaScript, event handlers, forms, iframes, object/embed, SVG/WASM, remote dependencies, dynamic/encoded references, unsupported paths and missing assets are rejected with compatibility reasons. Some harmless entities/escapes are conservatively unsupported by the existing dependency validator. **No JavaScript is stripped, markup sanitized, missing asset replaced, or source file deleted to produce success.** Choose a genuinely supported existing project or retain the blocker; a visual approximation is not a preserved copy.

Quoted `<script type="application/json" id="discovery-render-state">…</script>` data blocks are supported without changing their bytes: only `type="application/json"` and an optional simple `id` are allowed, JSON must parse, and raw `<`, ambiguous tokenizer contexts, duplicate/unknown attributes and noncanonical closing tags fail closed. The data is excluded only from the inspection view, not the preserved output; content CSP remains `script-src 'none'`. This is not active JavaScript support.

Original members stay byte-identical. The bundle adds standard runtime release/policy metadata and a hashed `runtime-migration.json` provenance member binding the source URL and canonical source-inventory digest. Migration provenance is protected from draft edits. The new domain persists an access-configuration gate before any content becomes available: even after owner claim, the owner must explicitly choose viewer protection/public reading. Grant revocation stays available while locked. Restart does not reset an already confirmed access choice. Keep private content under viewer protection and OAuth; never make it public merely to connect ChatGPT.

## Deploy and accept separately

Use [manual-host.md](manual-host.md) or the established native TLS packaging path with a new safe public HTTPS binding, durable private state, protected bootstrap custody and verified cache bypass prevention. The migration itself does not provision them. Complete owner claim and explicit reader policy, then use **Connect ChatGPT** in `/owner`; endpoint and identity come from the live manifest.

Compare each original source member's hash with the preserved export and migrated bundle, and compare original project URL/authority before and after. Verify desktop/narrow migrated content and owner connect UI, protected-byte denial, OAuth/PKCE/resource binding, real grant reads, revocation and restart. Public discovery/protocol smoke is not an actual ChatGPT account connection. Keep an evidence ledger distinguishing source tests, original preservation, deployed runtime/HTTPS, and real client acceptance or exact account/login/consent gate. Native Cynder/full Essential MVI completion is not claimed.
