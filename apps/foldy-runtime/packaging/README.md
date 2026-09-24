# Standalone Foldy packaging

This is local packaging capability, not Cynder deployment acceptance. The normative
contract is `docs/foldy/essential-mvi-contract.json`, `releaseBundle`. The runtime
executes `node dist/main.js` and consumes `src/bundle.ts`'s exact v1 manifest.

## Release export

Call `buildReleaseBundle(adapter, freshOutputDirectory)` from
`dist/release-bundle.js`. The trusted factory adapter supplies an immutable,
content-only directory and exact `ApprovedRevision` inventory. It must authenticate
owner approval of the specified frozen revision, not accept an approval boolean
from a public request. Its mandatory `assertContentOnly(path, bytes)` must reject
all custody-classified material, including secret-derived values. No generic
pattern scanner can recognize arbitrary credentials: the built-in filename and
key-material checks are defense in depth, not a substitute for this adapter.
No daemon state, wallet, signer, payment or operator credential roots are read.

The exporter rejects undeclared/missing/duplicate members, symlinks/hardlinks,
executable members, traversal, wrong hashes, unknown fields, stale approval,
custody paths, and unsupported remote/dynamic references. It verifies every
member before creating output and then uses the real runtime loader to verify
written bytes. Sources and output-parent directories must remain immutable or
exclusively controlled during export; this is not a concurrent hostile filesystem
sandbox. The supported subset is static HTML/CSS plus the runtime media allowlist;
JavaScript, encoded references, srcset, and remote dependencies must be transformed
by the trusted adapter or are rejected. This is intentionally narrower than the
full contract's eventual external-dependency capability.

`manifest.json` uses fixed key order, lexically sorted members, UTF-8 JSON and one
trailing newline. Its SHA-256 is the aggregate `bundleDigest`. Runtime version is
bound through generated `runtime-release.json`, a hashed application/json member;
no unrecognized top-level property is added to v1. That file is public content,
not custody. The same input produces identical manifest bytes, not a promise of
bit-identical OCI layers across builders.

`runtimeImageDigest` identifies the already-built immutable runtime release,
**not the final instance image containing this bundle**: embedding an image's own
digest would be circular. Record the final instance OCI digest separately in the
deployment receipt. The synthetic image smoke uses the base digest only as a test
identity; it is not an approved product runtime release.

## OCI context and test

Build on Node 24 with the workspace-pinned pnpm. Produce production dependencies
in an isolated deployment stage; disable lifecycle scripts to avoid unrelated
workspace rebuilds:

```sh
pnpm --filter @open-design/foldy-runtime build
node --test apps/foldy-runtime/tests/release-bundle.test.ts
pnpm --filter @open-design/foldy-runtime --ignore-scripts deploy --prod --legacy "$DEPENDENCY_STAGE"
NODE_IMAGE=node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 \
  node apps/foldy-runtime/packaging/image-smoke.ts "$DEPENDENCY_STAGE"
```

The digest above was returned by an anonymous public pull of
`node:24-bookworm-slim` during local verification. Dockerfile has no floating base
default: explicitly pass a verified Node 24 immutable image. Registry custody is
not needed for this smoke; it uses an empty temporary Docker configuration.
The smoke builds a fresh allowlisted context containing only runtime dist,
production node_modules, a synthetic verified bundle and build recipe. It runs
the real bundle loader and MCP dependency import under UID 1000 with read-only
rootfs, network disabled, no capabilities and no-new-privileges, then removes its
image. This proves packaging/import/loader execution, not TLS or owner activation.

For real packaging stage only `dist/`, production `node_modules/` and verified
`bundle/`. Copy this Dockerfile and Dockerfile.dockerignore into that context.
Never use a repository, dependency deploy output, daemon data directory, home or
credential directory directly as the context. Dependency staging is trusted
release input: audit it for extraneous state before building. Do not add broad
COPY instructions or build secrets. The final image does not contain factory
code, wallet/signing tools or payment configuration.

## Launch contract (not an automated deployment)

- Launch `--read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges`.
- Explicitly mount a durable writable `/data`, owned by UID 1000, mode 0700.
  No anonymous volume is declared. `FOLDY_STATE_DIR=/data` is the standalone
  runtime's storage input; `OD_DATA_DIR` is **not** currently consumed here.
  Daemon-managed data follows root AGENTS.md, not this standalone mount contract.
- Set `FOLDY_BUNDLE_DIGEST` to the verified manifest digest. The image sets
  `FOLDY_BUNDLE_DIR=/opt/foldy/bundle`, `FOLDY_PORT=8080`, `FOLDY_STATE_DIR=/data`.
- Production uses native TLS. Set exact `FOLDY_PUBLIC_HOST`,
  `FOLDY_TLS_KEY_FILE`, `FOLDY_TLS_CERT_FILE` pointing at read-only protected mounts.
  A plaintext reverse proxy upstream is not a supported production substitute.
  `FOLDY_DEV_LOOPBACK=1` binds only 127.0.0.1 inside the container and is not a
  public container deployment option.
- First start requires `FOLDY_BOOTSTRAP_FILE`: protected JSON with `instanceId`,
  `verifier`, `expiresAt`, injected by the authenticated deploying principal.
  File must be UID 1000-owned, single-link, mode 0600, inside a 0700 directory;
  ancestors cannot be writable by group/others or symlinked. A common root-owned
  generic secret mount is not automatically compatible. Never bake this file or
  its assertion into the bundle, image, environment value, URL or command line.
  Recovery uses separate `FOLDY_OWNER_RECOVERY_FILE` and the exact generation-bound
  schema in `owner-authority.ts`. Neither file is a durable content backup.
- Set `FOLDY_EXTERNAL_CACHE_ENABLED=0` only when there truly is no external cache.
- One process owns the explicit state mount. Crash-stale `runtime.lock` fails
  closed; do not auto-delete it without proving no runtime still owns that state.
  A writable-volume probe alone does not prove durable provider storage.
- `/api/health` proves liveness only. Claim, owner readiness, revision identity,
  storage persistence, MCP and browser access require separate checks.

Current Cynder durable-volume/storage binding is unsupported by this packaging
slice; no Cynder launch/quote/payment/registration/activation was performed.
TLS custody provisioning, durable provider storage, restart/restore, route parity,
owner claim, rollback and the deployed golden path remain integration gates.
