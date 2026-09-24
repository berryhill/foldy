# Update domain integration slice

`src/domain.ts` owns SQLite content, immutable file revisions, update records, review comments, approval identity, current pointer and idempotent receipts. Node 24 built-in `node:sqlite` requires the package's Node 24 type definitions. Transactions use BEGIN IMMEDIATE with WAL/FULL synchronization. The verified bootstrap bundle seeds the database only once; its identity is checked on reopen.

Both MCP tools/call and authenticated POST `/api/operations` call `Domain.dispatch(name, arguments, actor)`. Owner POST envelope is exactly `{name, arguments}`. Owner authority comes only from the existing owner session, never an argument. MCP grants optionally accept `{scopes:["foldy:read","foldy:draft:write"]}`; empty grant request retains read-only default. Clients never receive review/approve/publish/close tools and calls are independently denied.

Read tool schemas and mutation schemas are returned by `Domain.tools(actor)`. Mutations require projectId, expectedBaseRevisionId, idempotencyKey; existing-update mutations also require updateId and expectedUpdateRevisionId. update_page accepts an existing textual member path and UTF-8 content. Approval/publication/close/request-changes and resolution require reason. Contextual owner comments accept text, blocking and target containing optional path/block/field/selection. Same actor/key and identical operation arguments replay the original receipt; changed inputs conflict.

Serving reads the transactional current revision on each request. Historical file bytes remain available via atRevisionId. Publication changes bytes and discovery/readiness identity without restarting. No Cynder operations are introduced.

## Bounded limitations for parent follow-on

- Existing textual files can be changed; file/page creation, removal, moves and structured workbook field editing are not implemented.
- Readiness currently enforces entry existence, blocking comments, base CAS and exact approval. Recursive HTML/CSS dependency closure and protected page/field policies still need implementation; do not describe this as complete bundle/publication assurance.
- Update records/comments are current durable records; immutable file revision history and operation receipts persist. Full historical snapshots of review metadata, persisted independent check reports and receipt-list UI remain follow-on. Historical collection reads explicitly fail rather than silently substitute current data.
- UI, owner recovery, backup/restore, OAuth, access protection and refresh-proposal workflow remain outside this slice.
- Existing process lock remains fail-closed after abrupt termination; recovery is not implemented here.

## Verification

`pnpm --filter @open-design/foldy-runtime test` builds and executes domain plus real-process tests. The tests cover sealed bootstrap, auth separation, grant scope denial, immutable bundle serving, persisted domain reopen, client draft → owner review → publication → changed live bytes, stale approval, competing publication CAS, idempotent replay and process restart parity. Typecheck is package-scoped.

Dependency installation: the initial filtered add ran the root postinstall, which failed because unrelated contracts/esbuild dependencies were absent in this isolated worktree. Completed the targeted installation with `pnpm install --filter @open-design/foldy-runtime --ignore-scripts --frozen-lockfile`; runtime build/tests do not require that root postinstall.
