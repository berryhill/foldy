import { describe, expect, it } from 'vitest';

import { createFoldyRemoteMcpInstallInfo } from '../../src/foldy-mcp/install-info.js';

describe('Foldy remote MCP client instructions', () => {
  it('builds project/grant-specific remote instructions for GPT, Claude, and generic clients', () => {
    const mcpUrl = 'https://deploy.example/projects/project-1/mcp';
    const info = createFoldyRemoteMcpInstallInfo({ mcpUrl, projectId: 'project-1', grantId: 'grant-9' });
    const label = 'open-design-foldy-project-1-grant-9';

    expect(info.server).toEqual({ label, transport: 'streamable-http', url: mcpUrl });
    expect(info.tokenHandling).toMatchObject({ env: 'OD_FOLDY_MCP_TOKEN', authorizationScheme: 'Bearer' });
    expect(info.clients.gpt).toMatchObject({
      supported: true,
      target: 'openai-responses-api',
      tool: {
        type: 'mcp',
        server_label: label,
        server_url: mcpUrl,
        require_approval: 'always',
        authorization: { source: 'environment', env: 'OD_FOLDY_MCP_TOKEN' },
      },
    });
    expect(info.clients.gpt.javascript).toContain('process.env.OD_FOLDY_MCP_TOKEN');
    expect(info.clients.gpt.javascript).toContain('server_url: foldyMcpUrl');
    expect(info.clients.gpt.javascript).toContain('authorization: foldyToken');
    expect(info.clients.gpt.javascript).not.toContain('headers:');
    expect(info.clients.gpt.javascript).not.toContain('command:');
    expect(info.clients.claudeCode.mcpServers[label]).toEqual({
      type: 'http',
      url: mcpUrl,
      headers: { Authorization: 'Bearer ${OD_FOLDY_MCP_TOKEN}' },
    });
    expect(info.clients.claudeDesktop).toMatchObject({ bridge: 'mcp-remote', version: '0.14.0' });
    expect(info.clients.claudeDesktop.posix.mcpServers[label]).toMatchObject({
      command: 'sh',
      env: { OD_FOLDY_MCP_URL: mcpUrl },
    });
    const posixCommand = info.clients.claudeDesktop.posix.mcpServers[label]!.args.join(' ');
    expect(posixCommand).toContain('mcp-remote@0.14.0');
    expect(posixCommand).toContain('$OD_FOLDY_MCP_TOKEN');
    expect(posixCommand).not.toContain('...');
    expect(info.clients.claudeDesktop.windows.mcpServers[label]).toMatchObject({
      command: 'cmd',
      env: { OD_FOLDY_MCP_URL: mcpUrl },
    });
    const windowsCommand = info.clients.claudeDesktop.windows.mcpServers[label]!.args.join(' ');
    expect(windowsCommand).toContain('mcp-remote@0.14.0');
    expect(windowsCommand).toContain('%OD_FOLDY_MCP_TOKEN%');
    expect(windowsCommand).not.toContain('...');
    expect(info.clients.generic).toEqual({
      label,
      transport: 'streamable-http',
      url: mcpUrl,
      authorization: { type: 'bearer', tokenEnv: 'OD_FOLDY_MCP_TOKEN' },
    });
    for (const client of Object.values(info.clients)) {
      const serializedClient = JSON.stringify(client);
      expect(serializedClient).toContain(mcpUrl);
      expect(serializedClient).toContain(label);
      expect(serializedClient).toContain('OD_FOLDY_MCP_TOKEN');
    }
  });

  it('contains only an environment reference, never a token, verifier, localhost URL, or credential-like placeholder', () => {
    const rawToken = 'raw-token-must-not-escape';
    const verifier = 'scrypt$must-not-escape';
    const serialized = JSON.stringify(createFoldyRemoteMcpInstallInfo({
      mcpUrl: 'https://deploy.example/mcp',
      projectId: 'safe-project',
      grantId: 'safe-grant',
    }));

    expect(serialized).toContain('OD_FOLDY_MCP_TOKEN');
    expect(serialized).not.toContain(rawToken);
    expect(serialized).not.toContain(verifier);
    expect(serialized).not.toContain('localhost');
    expect(serialized).not.toContain('<FOLDY_MCP_TOKEN_SECRET_REF>');
    expect(JSON.stringify(JSON.parse(serialized).clients.gpt)).not.toContain('stdio');
  });
});
