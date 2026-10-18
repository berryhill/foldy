# Connect assistants to an owned Foldy

The owner workspace’s **Connect assistants** section reads the live `/mcp/manifest.json` and resolves its endpoint and OAuth discovery metadata against the actual instance origin. Prefer client-initiated OAuth and open the client’s authorization link in the existing owner browser. A bare authorization endpoint is not a usable authorization request: the client must register and supply redirect, resource, state and PKCE parameters.

- **ChatGPT:** in the owner dashboard, expand **Connect ChatGPT** under **Connect assistants**. It displays this instance’s exact manifest-derived Streamable HTTP `/mcp` endpoint, instance/project/workbook IDs and current published revision. **Copy MCP endpoint (no credentials)** copies only the same-origin URL. Use a publicly reachable HTTPS endpoint; neither loopback nor a tailnet-only address works for the cloud client. This UI does not establish public reachability or assume a separate Funnel endpoint is available.
- **Claude Desktop:** remote custom connector support depends on version and account. A stdio-only configuration cannot directly consume Streamable HTTP.
- **Claude Code:** configure a remote HTTP MCP server using the installed version’s commands and authenticate through its browser authorization flow.
- **Generic client:** requires Streamable HTTP, protected-resource discovery, dynamic client registration and authorization-code PKCE S256. There are no refresh grants; reconnect after expiry.

These are compatibility requirements and manual instructions, not claims of testing any named client or account. Local protocol tests are not named-client certification.

For ChatGPT, follow [OpenAI’s current connection guide](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt): Plugins → + → Add custom MCP server, enter name/description and the public MCP URL, select OAuth, read the risk warning, Create as a plugin and review the tools. Install the plugin, then use @ to select it in a new conversation; Refresh after tool metadata changes. Labels and availability can vary by account and workspace policy. The supported alternative in OpenAI’s guide is a Secure MCP Tunnel; it is not automatically provisioned by Foldy. Do not interpret a local protocol test as an actual connected ChatGPT account.

Use a harmless first prompt: “Using this Foldy plugin, call get_project and list_pages (read only). Report the instanceId, projectId and workbookId in get_project.value, the available page paths, and observedRevisionId from each response; do not create or edit anything. Call get_workbook only if workbook.json is present; that file is optional.” Compare get_project.value IDs to the owner panel and both observed revisions to the displayed current published revision. A mismatch may mean a different instance/plugin or a changed publication; stop before any write. Neither this prompt nor the UI connects an account by itself.

Read-only is the default. Explicitly select draft proposals and request `foldy:read foldy:draft:write` in the client if needed; the owner consent page displays the actual requested scopes. Neither scope grants approval, publication, backup or owner administration.
Viewing password, owner cookie and MCP OAuth grant are separate credentials. Never paste any of them into the endpoint URL. Grant revocation remains available in the owner workspace even when issuance budgets are exhausted.

The advanced opaque-token fallback reveals an actually issued token once after explicit owner confirmation, removes the display after one minute, and never stores it in browser storage or URLs. Use only clients with protected Authorization-header custody. Dismiss after saving securely. OAuth remains preferred.

## Grant administration

Owner-only `GET /api/mcp-grants` returns grant ID, kind, scopes, expiry and active status, never verifier or token. `POST /api/mcp-grants/revoke` accepts `{ "grantId": "the listed ID" }`; `POST /api/mcp-grants/revoke-all` accepts `{}`. Both terminate matching active MCP sessions. Grants cannot invoke these owner endpoints.

`od foldy instance mcp-grant-list` and `mcp-grant-revoke-all` use those same endpoints, with `--instance-url`, `--owner-cookie-file` and optional `--json`. Revoke-all needs no prompt file. Single revoke uses `mcp-grant-revoke` with a protected JSON `--prompt-file`. Credential issuance still requires an exclusive protected `--credential-file` and redacts stdout.
