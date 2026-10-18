# Same-host manual HTTPS ingress (template, not deployment)

This is an operator runbook for a NEW, separately authorized binding. No service,
reverse proxy, DNS, TLS material, port or existing workstation is changed by this
repository. Do not touch existing tailnet 8443/8444 or unrelated Funnel 10000.
The parent selects and provisions a safe binding. Reuse the established tools-pack
workstation separately; do not run this service as a substitute workstation.
Native Cynder hosting stays disabled. No hosted browser/ChatGPT acceptance is claimed.

## Trust boundary

Direct production TLS remains the default. The opt-in `FOLDY_PROXY_PUBLIC_ORIGIN`
mode is valid only when the HTTPS terminator and runtime are controlled by the SAME
deployment principal on the SAME host. The runtime listens on IPv4 127.0.0.1 only;
never route its plaintext upstream over a network, a shared container bridge or
remote forward. Firewall the upstream and verify no other untrusted same-host
principal can reach/reconfigure the proxy/runtime or inject trusted requests.
Protect the proxy configuration and TLS private key. The proxy MUST forward the
exact public Host header (including a nondefault port), never rewrite it to the
upstream Host; pass the original Origin unchanged. It must not trust client-supplied
Forwarded, X-Forwarded-Host/Proto/For or equivalent values as authority. The
runtime does not consume those headers. Normalize/reject ambiguous/multiple Host
headers at the edge and permit only the configured public host; block direct public
access to the upstream. Do not cache any responses (including errors, static files,
OAuth and owner routes), log request bodies, Authorization or Cookie headers,
query strings that may contain OAuth codes, or response Set-Cookie/credentials.
Preserve `Cache-Control: no-store` end to end and disable CDN caching before setting
`FOLDY_EXTERNAL_CACHE_ENABLED=0`. Provide ingress-wide abuse controls for the
shared proxy socket peer; application limiters do not distinguish clients there.

The origin must be an EXACT canonical HTTPS origin such as
`https://foldy.example` or `https://foldy.example:9443`, without trailing slash,
path, credentials, query or fragment. Do not set `FOLDY_DEV_LOOPBACK`, native TLS
file variables or a conflicting `FOLDY_PUBLIC_HOST` in proxy mode. Exact request
Host and supplied Origin are checked against the configured identity, not inferred
from headers. OAuth issuer/resource/redirect and browser Secure host-only cookies
continue to use the public HTTPS origin. Run `packaging/manual-host-config.ts`'s
`validateManualHostConfig` against nonsecret deployment inputs before provisioning;
this shape check is not permission or proof of safe binding.

## Immutable input and state preparation

1. On Node 24, build the runtime (`pnpm --filter @open-design/foldy-runtime build`)
   and stage `dist/` plus production dependencies with the pinned workspace
   package workflow. Stage the trusted, independently approved release bundle
   outside the source tree, verify its exact manifest digest and every member with
   the runtime loader, and make the deployed runtime/bundle read-only to the service
   UID. Record immutable release paths and digests for rollback. Do not copy
   `.od/`, source credentials, factory custody or operator keys into the bundle.
2. Provision a durable private state directory outside the bundle and source,
   service-UID owned mode 0700, with protected non-symlink ancestry. Confirm durable
   storage across process and host restart, backups and restore semantics separately.
   `runtime.lock` enforces a single state writer; after a crash, verify the old
   process is dead before an operator handles a stale lock. Never auto-remove it.
3. The authenticated deployment principal installs the one-use bootstrap verifier
   file outside source/bundle with service-UID ownership, mode 0600, single link and
   protected 0700 parent. The assertion/password are delivered through independent
   protected custody, never an env file, unit, CLI argument, logs or bundle. See
   the runtime README for schema and expiry. Owner recovery is a separate file.
4. Reserve a NEW HTTPS public binding and NEW loopback upstream port; configure the
   proxy to preserve exact Host, enforce HTTPS and no-cache/no-secret-logging, then
   verify its config and access controls before enabling traffic. This runbook
   does not select ports, configure DNS or install a reverse proxy.

## User systemd template (adapt paths only after authorized host preflight)

Place a unit under the deployment principal's user systemd directory. The
`EnvironmentFile` contains only nonsecret path/digest/origin/port values; mode
0600 and outside source. Do not include the assertion, password, token or TLS key.
Example variables: `FOLDY_BUNDLE_DIR`, `FOLDY_BUNDLE_DIGEST`, `FOLDY_STATE_DIR`,
`FOLDY_BOOTSTRAP_FILE`, `FOLDY_PROXY_PUBLIC_ORIGIN`, `FOLDY_PORT`, and
`FOLDY_EXTERNAL_CACHE_ENABLED=0` only after cache verification. The service's
working directory contains the staged built `dist/` and production `node_modules/`.

```ini
[Unit]
Description=Standalone Foldy runtime (same-host HTTPS ingress)
After=network.target

[Service]
Type=simple
WorkingDirectory=/absolute/verified/release/apps/foldy-runtime
EnvironmentFile=/absolute/private/config/foldy-paths.env
ExecStart=/absolute/node24/bin/node dist/main.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/absolute/private/durable/state
PrivateTmp=yes

[Install]
WantedBy=default.target
```

User-manager sandbox support varies by host; validate the effective unit and
file access without relaxing source/bundle integrity. Do not enable automatic
restart until lock behavior and supervised clean SIGTERM are verified: an unclean
exit intentionally fails closed rather than racing a second writer. Check
`/api/health` for liveness through the approved HTTPS route, and owner-only
`/api/readiness` for exact instance/revision/bundle and writable storage. The
latter does NOT attest to a deployment lease or full MVI. Verify the OAuth public
issuer/resource metadata, negative Host/Origin requests, Secure cookie flags,
owner/viewer/MCP separation and real client/browser flow before acceptance.

For a non-destructive update, preserve the current bundle, state and unit; stage
and verify a new immutable runtime/bundle, run the offline upgrade prerequisites,
stop the single process cleanly, change only the release path/digest, and start it
against the SAME durable state after checking lock ownership. Read back health,
owner readiness and actual served revision. For rollback, preserve state and the
prior verified release; use the runtime's supported offline upgrade/rollback path
and compatibility checks rather than overwriting state, deleting a lock, or
replaying a bootstrap. If compatibility cannot be proven, leave the incumbent
available or stop safely and escalate. No such update/restart/rollback has been
performed by this slice.
