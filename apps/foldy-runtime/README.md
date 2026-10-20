# Autonomous Foldy runtime — first executable slice

This package is an independent Node 24 process. It imports the public MCP SDK, not daemon private source. It is **not the complete Essential MVI** and is not a Cynder deployment adapter.

## Build and exercise

```sh
pnpm install
pnpm --filter @open-design/foldy-runtime build
pnpm --filter @open-design/foldy-runtime test
pnpm --filter @open-design/foldy-runtime start
```

`start` requires explicit environment configuration. It never creates a public owner claim secret or elects the first visitor.

- `FOLDY_BUNDLE_DIR`: directory containing `manifest.json` and declared files only.
- `FOLDY_BUNDLE_DIGEST`: trusted SHA-256 hex digest of the exact manifest bytes, provided independently of the bundle.
- `FOLDY_STATE_DIR`: separately protected writable runtime state directory, never inside the served bundle. This is standalone runtime state, not daemon-managed data.
- `FOLDY_BOOTSTRAP_FILE`: protected regular file (0600) containing `{instanceId, verifier, expiresAt}`. The deploying controller supplies a SHA-256 verifier of a high-entropy random assertion; `expiresAt` is epoch milliseconds, at most fifteen minutes in the future. Deliver the assertion independently through protected custody. Never put it in shell arguments, URLs, source, bundle, or logs.
- `FOLDY_TLS_KEY_FILE`, `FOLDY_TLS_CERT_FILE`, `FOLDY_PUBLIC_HOST`: required for normal HTTPS operation; the host includes its port if nondefault. Proxy headers are not trusted.
- `FOLDY_PROXY_PUBLIC_ORIGIN`: opt-in production same-host HTTPS terminator mode, mutually exclusive with native TLS and enabled development mode. Set an exact canonical public HTTPS origin with no trailing slash; upstream binds only 127.0.0.1 and requires the exact public Host/Origin. Forwarded headers are never authority. See [manual hosting](packaging/manual-host.md) for the same-principal trust and ingress requirements. `FOLDY_DEV_LOOPBACK=0` remains an explicit disabled development setting.
- `FOLDY_PORT`: defaults to 8080.
- `FOLDY_DEV_LOOPBACK=1`: explicit local test-only HTTP mode, binds **only** 127.0.0.1. Not a remote hosting mode. Owner cookies still carry Secure, so the raw-HTTP test client explicitly transports them; this is not browser acceptance.

## Client surfaces

`/` is the trusted Foldy reader shell with visible **Connect ChatGPT** and **Updates / Review** navigation. Its authored document lives at `/_document/index.html` in an opaque sandboxed iframe; relative page and asset requests remain in `/_document/`. Original paths remain available for compatibility, but the root now returns chrome, not authored bytes. All document/asset requests retain the viewer gate; owner cookies do not bypass it. Only HTML on the dedicated document path permits same-origin framing, and it remains scriptless/sandboxed. Generic locked chrome does not load any protected document.

`/connect` is public generic guidance, not an owner tab. Private identity, actual tunnel ID, prompts, scopes, expiry, observed activity and grant revocation require owner sign-in. Losing that session clears the private connection panel on the next check or action. The optional draft checkbox only reveals instructions; OAuth consent alone controls authority. Copy controls use real server values, never token examples. A successful MCP read is displayed as MCP evidence, never as proof of a particular ChatGPT account.

Local browser acceptance (isolated HTTPS fixture, no live ChatGPT): build the runtime, then run `pnpm --dir e2e exec playwright test -c lib/playwright/foldy.config.ts`. `FOLDY_CHROMIUM_EXECUTABLE` may select an already installed compatible browser. Tests cover 1280/390 surfaces, keyboard/status and accessibility, actual MCP-to-owner review/publication, session-loss privacy, relative CSS/navigation, byte preservation and reader/owner isolation. Traces are disabled so generated fixture assertions and credentials are not retained.

## Assistant connection status (runtime backend)

Public `GET /api/connect` reports only the generic connection contract and whether a Secure MCP Tunnel binding is configured. It does not expose the instance, project, content, grants, sessions, tunnel ID, origin or credentials. `chatgptReady` remains false: configuration is not proof of a reachable tunnel or a successful ChatGPT connection. A tailnet-only or development origin must never be presented as ChatGPT-ready.

The deploying operator may set `FOLDY_SECURE_MCP_TUNNEL_BINDING_FILE` to an absolute canonical path to a private, regular, single-link, owner-UID file in a private directory with protected ancestry. Its exact JSON shape is `{"schemaVersion":"foldy-secure-mcp-tunnel.v1","tunnelId":"<actual tunnel_ identifier with 32 lowercase hexadecimal characters>","credentialFile":"<absolute canonical path>"}`. Unknown fields, placeholders, binding-file symlinks and permissive binding-file custody fail startup. This is an operator-installed reference to an existing tunnel, not tunnel provisioning: the runtime does not open or validate the credential file, start a tunnel, validate public reachability or claim that it is online. Leave the variable unset until an actual binding exists; this package supplies none.

Owner-only `GET /api/connect/tunnel` reports the configured tunnel ID, if any, and `onlineVerified:false`. Owner-only `GET /api/connect/status` reports per-grant redacted evidence: grant ID, kind, scopes, expiry, active/verified state, and timestamps for successful read and draft MCP tools. `GET /api/mcp-grants` exposes the same evidence. No token, content or session data appears there. An OAuth authorization, MCP initialize, tools/list, owner UI refresh or failed/denied tool call is not evidence of a successful read. Evidence is committed in owner authority storage after a successful authenticated tool call, survives process restart, and becomes unverified after expiry or disappears on revocation. A successful read proves that grant's runtime MCP use, not that a specific named client or public transport connected.

## Transport activation boundary

The binding is an operator reference, not a running tunnel. Follow the current [OpenAI tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels): the tunnel must be associated with the target ChatGPT workspace, and its operator needs Tunnels Read + Use. OAuth discovery may travel through the tunnel, but the authorization server is not automatically tunneled; independently validate that browser authorization and the authorization-code/token exchange can reach the configured issuer without changing Foldy's origin-bound checks. Tailnet reachability alone is not that proof. Missing Platform account access, tunnel identity and runtime-key custody block live activation, not local UI or protocol verification. Do not ask recipients to create infrastructure keys or disable OAuth to work around this boundary.

## Contract implemented

The release manifest has `schemaVersion: foldy-release-bundle.v1`, `instanceId`, `projectId`, `workbookId`, `revisionId`, `runtimeImageDigest` and `members`. Each member has `path`, `mediaType`, `bytes`, `sha256`, `executableMode: 0`. The runtime verifies the trusted manifest digest, each member, allowlisted paths/media types, and rejects symlinks, executable files, undeclared files and size overruns. It serves an in-memory verified snapshot, so subsequent source-file changes cannot change served bytes. Active JavaScript is deliberately not supported; a sandbox CSP prevents workbook content acquiring owner privileges.

- Public `GET /api/health`: generic process liveness only.
- `POST /api/claim`: `{assertion,password}`; the protected, expiring, single-use assertion establishes ownership and the owner chooses a distinct password (12–128 Unicode scalar values). The Argon2id verifier and owner session are persisted in one durable authority replacement before a Secure/HttpOnly/SameSite cookie is returned. Replay fails across restart. The optional shared viewing password is not an owner credential.
- `POST /api/owner/login`: `{password}` rotates the single owner session while preserving issued MCP grants; previous owner cookies stop working. `POST /api/owner/logout` revokes the current session. Login admits at most eight attempts per socket source per minute, plus five per keyed source/candidate bucket; a bounded global Argon2 budget limits concurrent work. A shared proxy source shares this temporary login budget, including valid guesses; authenticated grant revocation and recovery are not behind that login limiter. Trusted ingress controls/private management remain required before public deployment.
- `POST /api/owner/recover`: `{assertion,password}` requires a separate, generation-bound operator-installed recovery authorization. It replaces the owner password, revokes prior owner sessions and all MCP grants, and consumes the recovery generation. Existing claimed legacy authority without a verifier may set one while its owner cookie remains valid through `POST /api/owner/password`; an expired legacy cookie needs operator recovery. These inputs never belong in URLs, logs, shell arguments or backups.
- Owner-only `GET /api/readiness`: identity/revision, bundle-verification and real writable storage probe. This is **slice readiness**, not provider activation, dependency-closure, backup or full-MVI acceptance.
- Owner-only `POST /api/mcp-grants`: `{}` issues a one-time-returned opaque read token; an explicit grant may also include `foldy:draft:write`. Only verifiers persist. Draft-write never grants approval, publication or administration.
- Owner-only `POST /api/mcp-grants/revoke`: `{grantId}` revokes a grant and its active MCP sessions.
- `GET /mcp/manifest.json`: connection metadata only after claim.
- `/mcp`: SDK-backed stateful Streamable HTTP, SDK-negotiated protocol versions (including `2025-11-25` and `2025-03-26`), advertised from the same SDK version list; unsupported initialize offers receive the SDK's latest supported version, grant-bound expiring sessions, exact revision reads and isolated draft-write tools. Unknown properties, wrong project/revision and unlisted tools are rejected. No approve/publish/admin client scope exists.
- MCP admission is bounded to 32 sessions per instance and eight per grant, including pending initializations; request windows admit 512 per instance and 60 per grant per minute. Expired/revoked sessions are removed and closed on MCP/OAuth/revocation traffic and an unref'ed minute cleanup timer. Session expiry is clamped to grant expiry. Closed-session capacity is reclaimed; restart discards sessions while durable grants retain their original expiry/revocation. These budgets never gate owner grant revocation. Read tools advertise read-only/non-destructive/closed-world MCP hints; scope and dispatch enforcement, not hints, remain the authority boundary.
- Browser public read after claim does not establish owner or MCP authority. Owner cookies are not accepted as MCP tokens; MCP tokens are not accepted for owner administration.

A state-directory exclusive lock rejects concurrent runtime processes. Normal SIGTERM/SIGINT releases it. An unclean kill leaves `runtime.lock` in place and startup fails closed; an operator must establish that the former process is dead before removing that lock. Automatic crash-lock recovery is not implemented.

## Viewer HTTP access boundary

`GET /api/viewer-access` returns mode/version only. Owner-authenticated
`GET /api/owner/viewer-access` reads settings; owner-authenticated
`POST /api/owner/viewer-access` accepts exactly either
`{mode: "password_required", password}` or `{mode: "public", confirmDisable: true}`.
`POST /api/viewer/unlock` accepts exactly `{password}`; `POST /api/viewer/logout`
accepts exactly `{}`. These POSTs require the exact request Origin, JSON content
type, a bounded 4096-byte body, and same-origin Fetch Metadata when supplied.
Secrets must be supplied through protected client custody, never shell arguments.

Viewer state resides in the dedicated `viewer-access` child of `FOLDY_STATE_DIR`;
that directory is never served or exported. Cookies remain host-only Secure,
HttpOnly, SameSite=Strict with Path=/ (the narrowest scope covering all workbook
routes), including in loopback tests. Raw HTTP tests manually carry cookies;
they are not production browser/TLS acceptance. Public content is gated even
when an owner cookie is present. Owner reads use the explicit authenticated
`/api/operations` route; MCP always uses its independent bearer grant. Generic
readiness contains identity/status only, not workbook bytes.

Every application response, including access denials and assets, is no-store.
There is no runtime public-response cache. Enabling/replacing/disabling access
requires **explicit `FOLDY_EXTERNAL_CACHE_ENABLED=0`**; absent or any other value
fails cache verification and leaves the viewer gate sealed. This flag is an
operator assertion, not discovery or purge of a provider cache. Before setting
it, the provider/proxy operator must disable all content caching/object bypasses,
honor no-store on every route, and purge any previously cached material. This
runtime cannot recall copies or prove external purge. No external-cache-enabled
configuration is supported by this slice.

Unlock ingress uses only the socket peer, never X-Forwarded-For/Forwarded. Each
instance has a process-local HMAC-keyed limiter: 20 submissions per source per
minute and at most 1024 live buckets, expiring after a minute, in addition to the
persistent password-failure policy. Behind a proxy all clients share its socket
budget unless a separately reviewed trusted-proxy implementation is added. No
raw IP/request-body logging is added. The content decision and response enqueue
run synchronously after authorization; there is no asynchronous file streaming
between authorization and byte submission. Future streaming/export routes must
preserve this boundary or coordinate generation/in-flight revocation fencing.

Real-process tests cover protection, every fixture asset, authority separation,
logout replay, replacement, disable/re-enable and restart. Access change receipts
are returned but durable receipt history is **not** claimed by this integration.

## Offline operator restore

After building, run the standalone entrypoint from this package:

```sh
node dist/restore-cli.js --backup-file "$BACKUP_FILE" \
  --bundle-dir "$BUNDLE_DIR" --bundle-digest "$BUNDLE_DIGEST" \
  --authorization-file "$AUTHORIZATION_FILE" --target-dir "$TARGET_DIR" --json
```

All arguments are paths or public digests, never owner assertions, passwords,
MCP tokens or other credentials. Output contains identity, digests and sealed
restore status only. The bundle digest must come from trusted deployment custody,
not be calculated from an untrusted download and accepted as authority.

**Prerequisite: deploying-principal OS file custody.** The deployment operator
must install a private authorization JSON file, owned by the invoking deployment
UID, with no group/other permissions, no hard links or symlinks, in a private
owned directory with protected ancestry. The CLI reuses the owner-authority
ancestry boundary and checks the opened file descriptor. This is the same trusted
local principal boundary as bootstrap/recovery file installation; it does not
identify an arbitrary browser owner. Signed upstream issuance is not available:
there is no signature verifier, remote authorization service or public restore
endpoint. Do not expose this command to untrusted local users running under the
same UID. This CLI does not manufacture authorization files.

The exact authorization fields are:

- `schemaVersion`: `foldy-restore-authorization.v1`.
- `instanceId`, `projectId`, `workbookId`: original verified bundle identity.
- `bundleDigest`: SHA-256 of the original exact manifest bytes.
- `backupDigest`: SHA-256 of the exact backup file bytes (not its inner payload).
- `expiresAt`: epoch milliseconds, unexpired and at most fifteen minutes ahead.
- `nonce`: operator-generated random 64-character lowercase hexadecimal nonce.
- `custodyDirectory`: absolute canonical path to the authorization's immediate
  parent; moving a copy to a different directory is rejected.
- `targetDirectory`: absolute canonical path of the intended fresh state directory.

The backup must also be a protected regular file. The target must not exist,
including as an empty directory or symlink, and its existing parent must be
private with protected ancestry. Target, bundle and authorization custody must
not overlap. The CLI creates a 0700 target and restores only content SQLite state;
owner/MCP authority and viewer passwords/sessions are never imported. Existing
state is never overwritten. Exact verified bundle loading and reopening the
restored domain authenticate the original protected policy and protected bytes.

`restore-used/<nonce>.json` in the authorization custody directory is an exclusive,
fsynced **irreversible consumption marker**, outside the restored target. Preserve
this journal across retries, target deletion and host migration. Concurrent uses
cannot both consume a nonce. Once consumed, failure/crash leaves an intentionally
unknown-outcome marker, not a retry permit; inspect the target offline and have
the deployment principal issue a fresh authorization for a new target. Never
clear the journal to retry. A partial target remains unavailable and must not be
mistaken for a successful restore. Errors deliberately omit input and filesystem
contents.

After success, configure the normal runtime with the verified original bundle,
the new state directory and a **new independently provisioned bootstrap file**.
The operator must still complete the owner claim in the owner UI. Claim alone
cannot expose restored content: an explicit successful owner viewer-access policy
configuration is required, including the external-cache prerequisite documented
above. Until then, public files, owner content operations and backup, MCP grant
issuance, and MCP tools are denied; grant revocation and status remain available.
The restore gate persists across process restart. CLI tests exercise real
startup, claim, restart, explicit policy and content readback over local HTTP;
this is not hosted browser/TLS acceptance.

## Preserved-copy migration

The offline [preserved-copy CLI](packaging/preserved-copy.md) reuses the release-bundle contract, validates a frozen owner-reviewed original project export, supports no-write dry-run compatibility reports, and preserves original bytes and URL without sanitization or deletion. Unsupported JavaScript/interactivity remains a reported blocker. Migrated bundles carry protected hashed provenance and persist the existing access-configuration gate before content opens, including after owner claim; the owner explicitly chooses reader policy. This is a manually hosted test-instance path, not native Cynder activation. **Connect ChatGPT** under the owner dashboard's Connect assistants panel shows the actual manifest endpoint, identity, read-only OAuth instructions, optional draft limits and revocation controls. A local test is not an actual account connection.

## Owner handoff and actionable connection setup

The public `/connect` journey includes direct and copyable ChatGPT/setup links.
Recipients use `/owner/setup` with a separately delivered one-use invitation to
choose and confirm their own password; a generic URL is never ownership proof.
The offline invitation issuer, supported operator transport driver, normalized
readiness observer and secure delivery boundaries are documented in
[client onboarding](packaging/client-onboarding.md). Real OpenAI tunnel/account
provisioning, secure invitation delivery and human password entry remain distinct
from implemented source and synthetic acceptance tests.

The alternative browser pairing path begins only when a recipient clicks
“Request ownership of this browser” at `/owner/setup`. Its displayed requestId
is a lookup reference, never a verification factor or an approval. The random
possession secret is held solely in a Secure HttpOnly same-site browser cookie;
only a verifier is kept in the bounded pending store. Completion accepts a new
password only after a separately authorized offline OS operator decision writes
the exact request's protected recovery authorization while the runtime is
stopped. The operator must compare that exact reference with the recipient in
a supported secure decision UI or independently authenticated owner channel;
never take a code in chat, approve the first/list entry, or infer authorization
from possession of a reference. This repository does not provide that recipient
confirmation or operator decision UI. The offline primitive/CLI alone does not
establish the human decision and must not be run as an approval substitute.
No actual pairing approval or live recipient handoff is evidenced by local tests.

## Explicit remaining acceptance

The runtime now includes a SQLite update/review/publication domain, OAuth/PKCE
and opaque MCP grants, browser viewer protection, owner recovery, secret-free
content restore, offline runtime upgrade, and a local lifecycle fixture. The
read MCP tools include revision-bound HTML pages, a `workbook.json` read when
present, and bounded literal search over textual files. This is not a knowledge
graph: typed links, backlinks, semantic retrieval, and graph navigation are not
implemented.

Full provider deployment and CAS activation are not implemented. Foldy Server's
native deployment API remains explicitly unavailable until a verified hosting
admission resolver is configured; it must not silently fall back to static
hosting or auto-authorize payment. Provider volume, bootstrap, lease, cache,
upgrade, and teardown outcomes remain unverified. Client onboarding for GPT,
Claude Desktop, Claude Code, and a generic remote MCP client is not yet proven
against a hosted instance. The local protocol and browser tests do not establish
hosted-provider, TLS-client, or full accessibility acceptance. Do not call the
Essential MVI complete on the strength of this package's green suite.
