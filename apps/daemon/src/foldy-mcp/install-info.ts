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
