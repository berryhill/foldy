# Owner invitation and ChatGPT connection

## Client experience

The reading workspace links to `/connect` and `/owner`. The connection page offers direct Open ChatGPT Plugins and invitation-setup links, and copy buttons for `https://chatgpt.com/plugins` and the current Foldy's `/owner/setup` address. These links contain no authorization secret. A real configured tunnel ID is shown and copyable only after owner authentication; a private MCP URL is explicitly not a publicly reachable ChatGPT URL.

A recipient with a protected invitation opens `/owner/setup`, enters the separately delivered one-use key, chooses a password, and confirms it. They do not need a previous/generated password. Mismatched confirmation submits nothing; fields are cleared before the request. Existing owner sign-in and invitation setup are separate entry points.

A bare URL or first visit never grants ownership. A password's existence is not proof that the intended recipient selected it. Secure invitation delivery and the recipient's password entry are real prerequisites, not inferred completion states.

## Deploying-principal invitation issuance

For an already claimed instance, reuse the existing protected recovery authorization. Finish automated owner logins and acceptance checks before issuing an invitation: login advances the authority generation and can invalidate a pending authorization. Do not redeem the invitation or generate another password on behalf of the recipient.

Stop the exact instance cleanly, preserve its state/custody, and use explicitly selected private paths. The issuer acquires the same exclusive `runtime.lock`; an active instance or stale lock is rejected rather than removed. It authenticates the current bundle, instance and authority generation, then creates a recovery-verifier file and a separate key file with owner-only permissions. Existing outputs, links, relative paths and files inside the served bundle are rejected. The key is never printed or put in the setup URL.

After building the runtime:

```sh
node dist/owner-invitation.js \
  --state-dir "$PRIVATE_STATE_DIRECTORY" \
  --bundle-dir "$VERIFIED_BUNDLE_DIRECTORY" \
  --bundle-digest "$TRUSTED_BUNDLE_DIGEST" \
  --recovery-file "$FRESH_PRIVATE_RECOVERY_FILE" \
  --key-file "$FRESH_PRIVATE_INVITATION_KEY_FILE" \
  --setup-origin "$EXACT_FOLDY_HTTPS_ORIGIN"
```

All arguments are paths, public digests or the canonical origin—not the key or password. Output contains only a generic setup URL, protected file references and expiry. Configure `FOLDY_OWNER_RECOVERY_FILE` to the verifier file, not the key file, and restart the same instance with its existing data and identity. Deliver the key through an independently authenticated secure channel. Never include it in URLs/fragments, chat, source, logs, screenshots or diagnostics. No recipient address/channel is guessed or automatically created by this command.

The authorization expires within fifteen minutes and is consumed through a durable authority-generation replacement. Redemption replaces the owner password, invalidates prior owner sessions and MCP grants, and preserves content, history and reader-access policy. Issuance alone does not change the password or prove handoff. Existing recovery tests cover expiry/replay/generation fences; the invitation issuer tests cover protected outputs and concurrency exclusion. Paired-output cleanup on caught errors is not a claim of crash-atomic invitation delivery. After an interrupted issuance, retain and inspect the partial artifacts rather than blindly overwriting them.

## Browser-bound ownership request (no key delivery)

At `/owner/setup`, the recipient explicitly clicks **Request ownership of this browser**. The server sets a Secure, HttpOnly, SameSite=Strict cookie with a random 256-bit possession secret; JavaScript sees only an independent request reference and expiry. The reference is a lookup identifier, not a verification/possession factor. No request is created by visiting the page. Never ask anyone to paste pairing/verification codes, passwords or keys in chat.

The deploying principal must obtain a real decision for the **exact named pending request** through a supported secure masked/decision UI or an independently authenticated owner-approval channel, after the recipient compares the reference in their own browser. Queue text, page content, a request reference, and first-in-list order are not approval. This runtime does not supply that human confirmation UI. If no supported recipient-proof channel is available, keep the request pending and report that precise gate; do not invoke approval as a substitute.

Only after that decision, stop the canonical runtime cleanly and run the protected offline primitive:

```sh
node dist/owner-pairing.js \
  --request-id "$EXACT_CONFIRMED_REQUEST_REFERENCE" \
  --state-dir "$PRIVATE_STATE_DIRECTORY" \
  --bundle-dir "$VERIFIED_BUNDLE_DIRECTORY" \
  --bundle-digest "$TRUSTED_BUNDLE_DIGEST" \
  --recovery-file "$FRESH_PRIVATE_RECOVERY_FILE"
```

The request reference in argv is only a lookup. The primitive loads the private pending verifier and creates the existing generation-bound recovery authorization. It acquires `runtime.lock`, rejects links/unsafe custody, expiry, wrong identity/generation, and preexisting recovery outputs. Restart the **same** instance with `FOLDY_OWNER_RECOVERY_FILE` bound to this authorization. Do not log in again with the old password in between: that rotates the generation. In the original recipient browser, the recipient chooses/confirms their own password under **After approval, choose password**. Completion accepts only a password; the HttpOnly cookie supplies the possession secret. It revokes old owner sessions and MCP grants and rejects replay across restart. No operator should type the recipient's password or redeem their browser session.

Pending records contain verifiers only, expire within fifteen minutes, and are bounded to 32. Creation prunes only validated expired/generation-stale own records under the pairing lock; unknown/unsafe entries fail closed. Approval does not overwrite existing recovery files. If a prior authorization exists, preserve it and have the deploying principal explicitly review lifecycle/custody before a new handoff; never clear it automatically. Interrupted lock creation remains fail-closed, like the existing runtime lock.

## Operator transport configuration—not client administration

A client should not create an operator API key or manage hosting. The deploying operator must provision an actual OpenAI tunnel, restricted runtime credential and intended organization/workspace association before handoff. Creation/editing and runtime-use permissions are distinct. Never give an admin key to the long-lived tunnel process.

Official entry points:

- ChatGPT: https://chatgpt.com/plugins
- Tunnel management: https://platform.openai.com/settings/organization/tunnels
- Runtime keys: https://platform.openai.com/settings/organization/api-keys
- Roles: https://platform.openai.com/settings/organization/people/roles
- Supported client: https://github.com/openai/tunnel-client/releases/latest
- Primary instructions: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

No documented tunnel-specific ChatGPT installation deep link is fabricated. The client opens Plugins, adds a custom MCP server, chooses Connection: Tunnel, and selects/pastes the actual associated tunnel ID. OAuth discovery, browser consent and code/token exchange reachability must also work; the authorization server is not automatically made public merely by starting a tunnel.

### Protected operator request

`operator-transport-cli.js` accepts a private JSON request with exact `foldy-operator-transport.v1` fields defined by `TransportRequest` in `src/operator-driver.ts`:

- Actual `tunnelId`, local alias/profile and canonical HTTPS `/mcp` URL.
- `clientExecutable`: the explicitly approved, resolved native `tunnel-client` binary, not a symlink launcher; regular, executable, single-link, owner/root-owned and not group/other-writable, with protected ancestry.
- Existing private `profileDir`, `homeDir`, `xdgConfigDir`, `xdgStateDir` roots. Shared workstation/other-agent defaults are not inherited.
- `runtimeKeyFile`: an existing private regular single-link file. Validation checks metadata; the Foldy process never opens the credential target, and the native client resolves the file reference.
- Private `bindingFile`, `evidenceFile`, `healthUrlFile` and `pidFile` targets; files and credential/request paths must be distinct. Binding/evidence share a private parent.

The request stores references only. No literal key belongs in source, arguments, config, receipts or logs. The driver pins the native client's supported `TUNNEL_CLIENT_STATE_DIR` beneath the selected private state root, so legacy directories under HOME cannot silently take precedence. Vendor-generated health locator metadata may be readable inside that private root, but must be current-principal-owned, single-link, no-follow and not writable by group/others; credentials, operator inputs and normalized evidence retain owner-only custody.

```sh
node dist/operator-transport-cli.js dry-run "$PRIVATE_OPERATOR_REQUEST"
node dist/operator-transport-cli.js configure "$PRIVATE_OPERATOR_REQUEST"
node dist/operator-transport-cli.js start "$PRIVATE_OPERATOR_REQUEST"
node dist/operator-transport-cli.js status "$PRIVATE_OPERATOR_REQUEST"
# Supervise this observer normally; it does not start a second Foldy instance.
node dist/operator-transport-cli.js watch "$PRIVATE_OPERATOR_REQUEST"
```

Dry-run validates without issuing commands or writing configuration. Configure uses the supported native init/doctor interface and writes a versioned binding only after those commands succeed. Start attaches the actual tunnel through the native managed-runtime interface; it does not launch demo tools or an additional Foldy. Native status must match alias, tunnel, profile, canonical target, current PID and selected private state roots. Errors are normalized; raw tool diagnostics are not copied into the client UI.

The native supervisor/status tool is a trusted deploying-principal component and can perform its own metadata/health discovery. No public Foldy request can invoke it. Foldy's own health probe uses only fixed loopback `/healthz`, `/readyz`, `/metrics` routes, rejects redirects, bounds responses and applies deadlines; it does not use the redirect-following vendor health command as readiness proof.

A real running process, fresh health observation and recent successful control-plane poll are required for `ready-poll-confirmed`. A healthy process without fresh poll evidence remains merely `healthy`; binding presence alone remains `configured-not-verified`. Evidence is invalidated before commands that can fail. The observer periodically replaces normalized private evidence, and stale, malformed, mismatched or dead/restarted-process evidence is rejected by the app.

The current process-incarnation proof uses Linux `/proc`, matching UID, executable role and start-time ticks. The app and observer must share the relevant process namespace. Unsupported hosts remain unverified rather than accepting a recorded PID as proof. This is not a claim of cross-platform/provider deployment acceptance.

Set `FOLDY_SECURE_MCP_TUNNEL_BINDING_FILE` to the protected binding reference and restart the existing Foldy. Legacy v1 bindings remain configuration-only; v2 bindings point to private incarnation-checked evidence. Transport readiness is not independent proof of which ChatGPT account connected. The recipient still performs the in-app safe-read identity/revision check, then may explicitly authorize draft proposals. Approval/publication and access administration remain owner-only.
