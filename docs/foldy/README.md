# Foldy Essential MVI

The canonical requirements are captured in [essential-mvi-contract.json](essential-mvi-contract.json), recovered without narrowing scope from the approved runtime-transition workbook. This is a requirements record, not a completion claim.

## Product boundary

Foldy Server is a factory and deployment/upgrade control plane. Each deployed Foldy owns its UI, durable content, updates, owner review, publication, and project-scoped MCP. Content publication must not require runtime redeployment.

Only the single owner may approve, publish, administer access, recover, upgrade, or retire an instance. MCP clients receive read-only access by default and may explicitly receive draft-write access. Shared viewer passwords grant neither owner nor MCP authority.

## Completion boundary

Completion requires all 20 Essential MVI acceptance criteria and all seven Updates & Review criteria, including real-process and deployed evidence. Existing daemon publication controls, the stdio MCP bridge, simulated provider health, and a green unit suite do not establish autonomous-instance completion.

The existing gateway-oriented deployment adapter is not the native Cynder API. Native integration must use documented signed actions, immutable OCI digests, separately approved exact payment quotes, and durable uncertainty reconciliation. Provider capability gaps must remain explicit; local CAS or fixtures cannot manufacture upstream atomic activation, durable storage, or public hosting lease support.

## Preserved requirements

- Sealed ownership bootstrap and recoverable single-owner authority.
- Deterministic, dependency-complete release bundles.
- Real HTTPS Streamable HTTP MCP, OAuth PKCE, scoped fallback tokens and revocation.
- Isolated updates, frozen review, contextual feedback, owner-only publication and CAS.
- Per-instance public-default access and optional Argon2id shared viewer password.
- Secret-free consistent backup/restore, runtime upgrade rollback, stop and confirmed teardown.
- Exact-identity browser, MCP, security, accessibility and provider golden-path evidence.

Implementation evidence must distinguish source tests, local runtime verification, actual provider acceptance, and canonical repository delivery.
