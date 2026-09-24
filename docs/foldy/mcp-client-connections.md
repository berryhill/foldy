# Connect assistants to an owned Foldy

The owner workspace’s **Connect assistants** section reads the live `/mcp/manifest.json` and resolves its endpoint and OAuth discovery metadata against the actual instance origin. Prefer client-initiated OAuth and open the client’s authorization link in the existing owner browser. A bare authorization endpoint is not a usable authorization request: the client must register and supply redirect, resource, state and PKCE parameters.

- **ChatGPT:** use a remote custom MCP connector only where the account supports it. Its cloud service needs reachable HTTPS; a development loopback endpoint is not reachable.
- **Claude Desktop:** remote custom connector support depends on version and account. A stdio-only configuration cannot directly consume Streamable HTTP.
- **Claude Code:** configure a remote HTTP MCP server using the installed version’s commands and authenticate through its browser authorization flow.
- **Generic client:** requires Streamable HTTP, protected-resource discovery, dynamic client registration and authorization-code PKCE S256. There are no refresh grants; reconnect after expiry.

These are compatibility requirements and manual instructions, not claims of testing any named client or account. Local protocol tests are not named-client certification.

Read-only is the default. Explicitly select draft proposals and request `foldy:read foldy:draft:write` in the client if needed; the owner consent page displays the actual requested scopes. Neither scope grants approval, publication, backup or owner administration.

The advanced opaque-token fallback reveals an actually issued token once after explicit owner confirmation, removes the display after one minute, and never stores it in browser storage or URLs. Use only clients with protected Authorization-header custody. Dismiss after saving securely. OAuth remains preferred.

## Grant administration

Owner-only `GET /api/mcp-grants` returns grant ID, kind, scopes, expiry and active status, never verifier or token. `POST /api/mcp-grants/revoke` accepts `{ "grantId": "the listed ID" }`; `POST /api/mcp-grants/revoke-all` accepts `{}`. Both terminate matching active MCP sessions. Grants cannot invoke these owner endpoints.

`od foldy instance mcp-grant-list` and `mcp-grant-revoke-all` use those same endpoints, with `--instance-url`, `--owner-cookie-file` and optional `--json`. Revoke-all needs no prompt file. Single revoke uses `mcp-grant-revoke` with a protected JSON `--prompt-file`. Credential issuance still requires an exclusive protected `--credential-file` and redacts stdout.
