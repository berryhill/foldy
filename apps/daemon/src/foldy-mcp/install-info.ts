import type { FoldyRemoteMcpInstallInfo } from '@open-design/contracts';

interface StdioServerConfig {
  command: string;
  args: ['mcp', 'foldy'];
  env: { OD_DAEMON_URL: string };
}

export interface FoldyMcpInstallInfo {
  tokenHandling: {
    env: 'OD_FOLDY_MCP_TOKEN';
    displayPlaceholder: '<FOLDY_MCP_TOKEN_SECRET_REF>';
    note: string;
  };
  clients: {
    gpt: { supported: false; reason: string };
    claudeDesktop: { mcpServers: { 'open-design-foldy': StdioServerConfig } };
    claudeCode: { mcpServers: { 'open-design-foldy': StdioServerConfig } };
    generic: StdioServerConfig;
  };
  safeTestPrompt: string;
  revoke: { method: 'DELETE'; path: string; note: string };
}

export function createFoldyMcpInstallInfo(input: {
  command: string;
  daemonUrl: string;
  grantId: string;
}): FoldyMcpInstallInfo {
  // `od mcp foldy` is the custody wrapper. It reads the token from its own
  // inherited process environment at launch and refuses to start when absent.
  // Client configs therefore never assign a token literal or a display-only
  // placeholder that a client could mistakenly treat as the credential.
  const server: StdioServerConfig = {
    command: input.command,
    args: ['mcp', 'foldy'],
    env: { OD_DAEMON_URL: input.daemonUrl },
  };
  return {
    tokenHandling: {
      env: 'OD_FOLDY_MCP_TOKEN',
      displayPlaceholder: '<FOLDY_MCP_TOKEN_SECRET_REF>',
      note: 'Set OD_FOLDY_MCP_TOKEN in the MCP client process environment using your process supervisor or secret manager. The od mcp foldy wrapper reads it at launch; never put a token in args, prompts, or the displayed client config.',
    },
    clients: {
      // OpenAI GPT remote connectors do not support spawning a local stdio
      // command. Do not publish a plausible-looking but non-executable shape.
      gpt: {
        supported: false,
        reason: 'GPT remote MCP connectors do not support local stdio commands; use a supported stdio client.',
      },
      claudeDesktop: { mcpServers: { 'open-design-foldy': server } },
      claudeCode: { mcpServers: { 'open-design-foldy': server } },
      generic: server,
    },
    safeTestPrompt: 'Perform a read-only check: list the available Foldy tools and resources, then read the publication state. Do not mutate files, reviews, publication, or deployments.',
    revoke: {
      method: 'DELETE',
      path: `/api/foldy/mcp/grants/${encodeURIComponent(input.grantId)}`,
      note: 'Send this request from the local administrative authority. Existing MCP processes are denied on their next operation.',
    },
  };
}

/**
 * Builds secret-free connection instructions for an already validated remote
 * deployment binding. Token material is intentionally absent from the input;
 * every client resolves it from OD_FOLDY_MCP_TOKEN at execution time.
 */
export function createFoldyRemoteMcpInstallInfo(input: {
  mcpUrl: string;
  projectId: string;
  grantId: string;
}): FoldyRemoteMcpInstallInfo {
  const label = `open-design-foldy-${input.projectId}-${input.grantId}`;
  const javascript = [
    `const foldyMcpUrl = ${JSON.stringify(input.mcpUrl)};`,
    'const foldyToken = process.env.OD_FOLDY_MCP_TOKEN;',
    "if (!foldyToken) throw new Error('OD_FOLDY_MCP_TOKEN is required');",
    'const foldyMcpTool = {',
    "  type: 'mcp',",
    `  server_label: ${JSON.stringify(label)},`,
    '  server_url: foldyMcpUrl,',
    "  require_approval: 'always',",
    '  authorization: foldyToken,',
    '};',
    '// Pass foldyMcpTool in the OpenAI Responses API tools array.',
  ].join('\n');
  const posixDesktopBridge = {
    command: 'sh' as const,
    args: [
      '-lc',
      'exec npx -y mcp-remote@0.14.0 "$OD_FOLDY_MCP_URL" --header "Authorization: Bearer $OD_FOLDY_MCP_TOKEN"',
    ] as ['-lc', string],
    env: { OD_FOLDY_MCP_URL: input.mcpUrl },
  };
  const windowsDesktopBridge = {
    command: 'cmd' as const,
    args: [
      '/d',
      '/s',
      '/c',
      'npx -y mcp-remote@0.14.0 "%OD_FOLDY_MCP_URL%" --header "Authorization: Bearer %OD_FOLDY_MCP_TOKEN%"',
    ] as ['/d', '/s', '/c', string],
    env: { OD_FOLDY_MCP_URL: input.mcpUrl },
  };

  return {
    server: { label, transport: 'streamable-http', url: input.mcpUrl },
    tokenHandling: {
      env: 'OD_FOLDY_MCP_TOKEN',
      authorizationScheme: 'Bearer',
      note: 'Set OD_FOLDY_MCP_TOKEN in the client process environment with a secret manager. These instructions reference the environment variable and never contain the credential.',
    },
    clients: {
      gpt: {
        supported: true,
        target: 'openai-responses-api',
        tool: {
          type: 'mcp',
          server_label: label,
          server_url: input.mcpUrl,
          require_approval: 'always',
          authorization: { source: 'environment', env: 'OD_FOLDY_MCP_TOKEN' },
        },
        javascript,
      },
      claudeCode: {
        configFile: '.mcp.json',
        mcpServers: {
          [label]: {
            type: 'http',
            url: input.mcpUrl,
            headers: { Authorization: 'Bearer ${OD_FOLDY_MCP_TOKEN}' },
          },
        },
      },
      claudeDesktop: {
        bridge: 'mcp-remote',
        version: '0.14.0',
        note: 'These are shell bridges to the deployed remote MCP server, not native remote-server entries. Use the POSIX sh form on macOS/Linux or the cmd form on Windows; npx and OD_FOLDY_MCP_TOKEN must be available in the Claude Desktop process environment.',
        posix: { mcpServers: { [label]: posixDesktopBridge } },
        windows: { mcpServers: { [label]: windowsDesktopBridge } },
      },
      generic: {
        label,
        transport: 'streamable-http',
        url: input.mcpUrl,
        authorization: { type: 'bearer', tokenEnv: 'OD_FOLDY_MCP_TOKEN' },
      },
    },
    safeTestPrompt: 'Perform a read-only check: list the available Foldy tools and resources, then read the publication state. Do not mutate files, reviews, publication, or deployments.',
  };
}
