---
name: foldy-instance-operator
description: Use when connecting to or operating one autonomous Foldy instance through its owner UI, project-scoped MCP endpoint, or od foldy instance CLI. Verify instance authority and revision receipts.
version: 1.0.0
author: Foldy
triggers:
  - "connect to a Foldy instance"
  - "Foldy MCP"
  - "review a Foldy update"
  - "Foldy instance backup"
od:
  mode: utility
  category: operations
metadata:
  hermes:
    tags: [foldy, instance, mcp, review]
---

# Foldy instance operator

## Scope

This skill is for an actual deployed instance, not the workstation Foldy Server. The instance owns its published bytes, isolated updates, single-owner decisions, access configuration, backup, and project-scoped MCP. The normative acceptance contract is `docs/foldy/essential-mvi-contract.json` in a current `berryhill/foldy` checkout; record its commit. A local synthetic runtime test does not establish a reachable Cynder instance or named-client interoperability.

## Connect and inspect safely

1. Obtain the exact instance HTTPS origin from an authoritative deployment receipt. Do not guess it from the Foldy Server port or a project ID. `GET <origin>/mcp/manifest.json` must return JSON with matching instance, project, workbook, current revision, protocol, endpoint, authentication discovery and tool-contract version. An HTML shell is not an MCP manifest. `GET <origin>/api/health` proves liveness only; owner readiness is a separate authenticated check.
2. The real CLI surface is `od foldy instance <action> --instance-url <https-origin> [--json]`. `od foldy instance --help` lists `mcp-manifest`, `readiness`, `status`, `diagnostics`, `operation`, `access-status`, `access-config`, grant administration, `claim`, `recover`, `logout`, and `backup`. Outside the checkout, verify the installed `od` supports these before presenting a command as usable. Loopback HTTP is a development exception, not a deployment target.
3. Claim/recovery use one-use operator-supplied assertions and protected `--prompt-file`/`--credential-file` custody. Never put assertions, cookies, passwords, tokens, or authorizations in command arguments, URLs, output, chat or logs. Owner actions require a protected owner-cookie file; write actions use a protected JSON prompt file or stdin as the CLI documents. Grant issuance writes a new private credential file; backup writes a new private output file. A successful response must be read back at the same instance.

## Authority and review

Public browser reading is the default. The optional single shared viewing password gives viewer access only; it never grants owner, deployment, or MCP authority. MCP clients start with `foldy:read` and may receive `foldy:draft:write`; they may propose/revise an isolated update but cannot approve, publish, configure access, administer grants, recover, upgrade, or delete. Confirm both `tools/list` visibility and `tools/call` denial, then revoke and verify post-revocation denial. Prefer OAuth PKCE where a named client actually supports remote Streamable HTTP; fallback opaque tokens require protected client custody. The repository's `docs/foldy/mcp-client-connections.md` is guidance, not proof that ChatGPT, Claude Desktop, or Claude Code was tested.

Read `get_update`, `get_update_changes`, `get_update_preview`, `get_readiness_checks`, `list_review_comments`, `get_revision_history`, and bounded `list_update_receipts` for exact revision and actor/receipt evidence. The owner UI and MCP share the instance domain contract; an owner-cookie HTTP adapter is not itself a second authority. A material edit makes prior approval stale. After changes are requested or a blocking comment is resolved, the exact current revision must be resubmitted for review before approval. Publication is a separate owner-only compare-and-swap action against the current published revision; inspect the returned receipt and rendered bytes, not merely a successful button click.

## Recovery and lifecycle truth

A manual backup must be consistent and secret-free, retain identity/revisions/comments/checks/receipts, and be validated against a fresh compatible runtime. Do not claim restore from a downloaded file alone. Offline release selection is not a provider image upgrade; verify actual image, storage, readiness and rollback through provider receipts. Stop is reversible; deletion needs separate owner confirmation and truthful per-step workload, credential, cache, artifact and volume outcomes. Never delete user data merely to make a test pass.

## Verification and report

Bind evidence to the literal instance URL and revision. Report source implementation, local tests, browser-rendered behavior, named-client proof, provider acceptance, and remote-main delivery as separate states. For the Essential MVI, all 20 Essential and seven Updates & Review criteria must pass on one deployed instance. Missing provider capability or credentials are gates, not permission to fabricate a deployed result. Do not use this skill to initiate a paid Cynder action: that belongs to the Foldy Server owner workflow with a separate exact-quote approval.
