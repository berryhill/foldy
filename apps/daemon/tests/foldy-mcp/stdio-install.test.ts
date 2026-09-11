import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  createFoldyMcpTools,
  handleFoldyMcpRequest,
  startFoldyMcpSession,
} from '../../src/foldy-mcp/stdio-server.js';
import { createFoldyMcpInstallInfo } from '../../src/foldy-mcp/install-info.js';

describe('Foldy MCP stdio protocol', () => {
  it('omits tools outside the fixed grant scopes and never exposes a project argument', () => {
    const tools = createFoldyMcpTools(['read', 'reviewer']);
    expect(tools.map((tool) => tool.name)).toEqual([
      'foldy_get_publication', 'foldy_get_revision', 'foldy_request_review',
      'foldy_add_review_comment', 'foldy_decide_review',
    ]);
    expect(JSON.stringify(tools)).not.toContain('projectId');
    expect(JSON.stringify(tools)).not.toContain('project_id');
  });

  it('supports initialize, tools/list, resources/list/read and forwards the bearer without cookies', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/session')) return new Response(JSON.stringify({ grantId: 'g', projectId: 'fixed-p', scopes: ['read'] }), { status: 200 });
      if (url.endsWith('/resources')) return new Response(JSON.stringify({ resources: [{ uri: 'foldy://project/publication', name: 'Publication state' }] }), { status: 200 });
      if (url.includes('/resources/read')) return new Response(JSON.stringify({ contents: [{ uri: 'foldy://project/publication', text: '{}' }] }), { status: 200 });
      throw new Error(url);
    });
    const session = await startFoldyMcpSession({ daemonUrl: 'http://127.0.0.1:7456', token: 'runtime-secret', fetcher });
    expect((await handleFoldyMcpRequest(session, { id: 1, method: 'initialize' }))?.result).toMatchObject({
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'open-design-foldy', version: '0.7.0' },
    });
    expect((await handleFoldyMcpRequest(session, { id: 2, method: 'tools/list' }))?.result).toMatchObject({ tools: expect.any(Array) });
    expect((await handleFoldyMcpRequest(session, { id: 3, method: 'resources/list' }))?.result).toMatchObject({ resources: expect.any(Array) });
    expect((await handleFoldyMcpRequest(session, { id: 4, method: 'resources/read', params: { uri: 'foldy://project/publication' } }))?.result).toMatchObject({ contents: expect.any(Array) });
    for (const call of fetcher.mock.calls) {
      const headers = new Headers(call[1]?.headers);
      expect(headers.get('authorization')).toBe('Bearer runtime-secret');
      expect(headers.has('cookie')).toBe(false);
    }
  });

  it('obeys notification, ping, pre-initialize, and single-initialize lifecycle rules', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ grantId: 'g', projectId: 'fixed-p', scopes: ['read'] }), { status: 200 }));
    const session = await startFoldyMcpSession({ daemonUrl: 'http://127.0.0.1:7456', token: 'runtime-secret', fetcher });

    expect(await handleFoldyMcpRequest(session, { method: 'notifications/cancelled' })).toBeUndefined();
    expect(await handleFoldyMcpRequest(session, { id: 1, method: 'tools/list' })).toMatchObject({ error: { code: -32002 } });
    expect(await handleFoldyMcpRequest(session, { id: 2, method: 'initialize' })).toHaveProperty('result');
    expect(await handleFoldyMcpRequest(session, { method: 'notifications/initialized' })).toBeUndefined();
    expect(await handleFoldyMcpRequest(session, { id: 3, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
    expect(await handleFoldyMcpRequest(session, { id: 4, method: 'initialize' })).toMatchObject({ error: { code: -32600 } });
    expect(await handleFoldyMcpRequest(session, { method: 'tools/list' })).toBeUndefined();
  });

  it('rejects missing, extra, and mistyped tool arguments before HTTP forwarding', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/session')) return new Response(JSON.stringify({ grantId: 'g', projectId: 'fixed-p', scopes: ['read', 'deployer'] }), { status: 200 });
      throw new Error(`unexpected forwarding: ${String(input)}`);
    });
    const session = await startFoldyMcpSession({ daemonUrl: 'http://127.0.0.1:7456', token: 'runtime-secret', fetcher });
    await handleFoldyMcpRequest(session, { id: 1, method: 'initialize' });
    const malformed = [
      { name: 'foldy_get_revision', arguments: {} },
      { name: 'foldy_get_revision', arguments: { revisionId: 'r', extra: true } },
      { name: 'foldy_get_revision', arguments: { revisionId: 7 } },
      { name: 'foldy_get_publication', arguments: { project: 'other' } },
      { name: 'foldy_deploy', arguments: { revisionId: 'r', environment: 'prod', idempotencyKey: 'k' } },
      { name: 'foldy_deploy', arguments: { revisionId: 'r', environment: 'prod', idempotencyKey: 'k', expectedActiveProviderRevisionId: 7 } },
      { name: 'foldy_deploy', arguments: { revisionId: 'r', environment: 'prod', idempotencyKey: 'k', expectedActiveProviderRevisionId: null, project_id: 'other' } },
    ];
    for (const params of malformed) {
      expect(await handleFoldyMcpRequest(session, { id: 2, method: 'tools/call', params })).toMatchObject({ error: { code: -32602 } });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('Foldy MCP client instructions', () => {
  it('wires the dedicated project-scoped server through od mcp foldy', async () => {
    const cliSource = await readFile(new URL('../../src/cli.ts', import.meta.url), 'utf8');
    expect(cliSource).toContain("if (args[0] === 'foldy')");
    expect(cliSource).toContain("import('./foldy-mcp/stdio-server.js')");
    expect(cliSource).toMatch(/await runFoldyMcpServer\(\)/);
  });

  it('returns executable client-native configs without putting a token placeholder in process env', () => {
    const info = createFoldyMcpInstallInfo({ command: 'od', daemonUrl: 'http://127.0.0.1:7456', grantId: 'g-1' });
    expect(info.clients).toHaveProperty('gpt');
    expect(info.clients).toHaveProperty('claudeDesktop');
    expect(info.clients).toHaveProperty('claudeCode');
    expect(info.clients).toHaveProperty('generic');
    const serialized = JSON.stringify(info);
    expect(serialized).toContain('OD_FOLDY_MCP_TOKEN');
    expect(serialized).toContain('<FOLDY_MCP_TOKEN_SECRET_REF>');
    expect(serialized).not.toContain('runtime-secret');
    expect(info.clients.claudeDesktop).toHaveProperty('mcpServers.open-design-foldy');
    expect(info.clients.claudeCode).toHaveProperty('mcpServers.open-design-foldy');
    expect(info.clients.gpt).toMatchObject({ supported: false });
    expect(info.clients.generic).toMatchObject({ command: 'od', args: ['mcp', 'foldy'] });
    expect(serialized).not.toContain('\"OD_FOLDY_MCP_TOKEN\":\"<FOLDY_MCP_TOKEN_SECRET_REF>\"');
    expect(info.tokenHandling).toMatchObject({ env: 'OD_FOLDY_MCP_TOKEN', displayPlaceholder: '<FOLDY_MCP_TOKEN_SECRET_REF>' });
    expect(info.safeTestPrompt).toMatch(/read-only/i);
    expect(info.revoke).toMatchObject({ method: 'DELETE', path: '/api/foldy/mcp/grants/g-1' });
  });
});
