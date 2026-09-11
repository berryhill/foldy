import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readCurrentAppVersionInfo } from '../app-version.js';
import type { FoldyMcpScope } from './grants.js';
import {
  FOLDY_MCP_TOOL_DEFINITIONS,
  FoldyMcpArgumentsError,
  validateFoldyMcpToolArguments,
} from './schemas.js';

type JsonObject = Record<string, unknown>;
export interface FoldyMcpTool { name: string; description: string; inputSchema: JsonObject }
export interface FoldyMcpSession {
  daemonUrl: string;
  token: string;
  grantId: string;
  projectId: string;
  scopes: FoldyMcpScope[];
  fetcher: typeof fetch;
  initialized: boolean;
}
interface JsonRpcRequest { id?: string | number | null; method?: string; params?: JsonObject }

const FOLDY_MCP_SERVER_NAME = 'open-design-foldy';

async function foldyMcpServerInfo(env: NodeJS.ProcessEnv = process.env): Promise<{ name: string; version: string }> {
  const { version } = await readCurrentAppVersionInfo({ env });
  return { name: FOLDY_MCP_SERVER_NAME, version };
}

export function createFoldyMcpTools(scopes: readonly FoldyMcpScope[]): FoldyMcpTool[] {
  const allowed = new Set(scopes);
  return FOLDY_MCP_TOOL_DEFINITIONS
    .filter((tool) => allowed.has(tool.scope))
    .map(({ scope: _scope, ...tool }) => ({ ...tool, inputSchema: tool.inputSchema as JsonObject }));
}

function endpoint(base: string, suffix: string): string {
  return `${base.replace(/\/+$/u, '')}/api/foldy/mcp${suffix}`;
}

async function daemonRequest(
  session: Pick<FoldyMcpSession, 'daemonUrl' | 'token' | 'fetcher'>,
  suffix: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await session.fetcher(endpoint(session.daemonUrl, suffix), {
    ...init,
    headers: {
      authorization: `Bearer ${session.token}`,
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  });
  const responseText = await response.text();
  let payload: unknown = null;
  if (responseText) {
    try { payload = JSON.parse(responseText); } catch { payload = responseText; }
  }
  if (!response.ok) {
    const error = new Error(`Foldy MCP daemon request failed (${response.status})`);
    (error as Error & { details?: unknown }).details = payload;
    throw error;
  }
  return payload;
}

export async function startFoldyMcpSession(input: {
  daemonUrl: string;
  token: string;
  fetcher?: typeof fetch;
}): Promise<FoldyMcpSession> {
  if (!input.token) throw new Error('OD_FOLDY_MCP_TOKEN is required');
  const seed = { daemonUrl: input.daemonUrl, token: input.token, fetcher: input.fetcher ?? fetch };
  const response = await daemonRequest(seed, '/session');
  if (!response || typeof response !== 'object') throw new Error('invalid Foldy MCP session response');
  const data = response as { grantId?: unknown; projectId?: unknown; scopes?: unknown };
  if (typeof data.grantId !== 'string' || typeof data.projectId !== 'string' || !Array.isArray(data.scopes)) {
    throw new Error('invalid Foldy MCP session response');
  }
  return {
    ...seed,
    grantId: data.grantId,
    projectId: data.projectId,
    scopes: data.scopes as FoldyMcpScope[],
    initialized: false,
  };
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): JsonObject {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

export async function handleFoldyMcpRequest(
  session: FoldyMcpSession,
  request: JsonRpcRequest,
): Promise<JsonObject | undefined> {
  const isNotification = !Object.prototype.hasOwnProperty.call(request, 'id');
  if (isNotification) return undefined;
  const id = request.id ?? null;
  if (typeof request.method !== 'string' || request.method.length === 0) {
    return rpcError(id, -32600, 'invalid request');
  }
  if (request.method === 'initialize') {
    if (session.initialized) return rpcError(id, -32600, 'server is already initialized');
    session.initialized = true;
    const serverInfo = await foldyMcpServerInfo();
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {}, resources: {} },
        serverInfo,
      },
    };
  }
  if (!session.initialized) return rpcError(id, -32002, 'server is not initialized');
  if (request.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  try {
    if (request.method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: createFoldyMcpTools(session.scopes) } };
    }
    if (request.method === 'resources/list') {
      return { jsonrpc: '2.0', id, result: await daemonRequest(session, '/resources') as JsonObject };
    }
    if (request.method === 'resources/read') {
      const uri = typeof request.params?.uri === 'string' ? request.params.uri : '';
      if (!uri) return rpcError(id, -32602, 'resources/read requires a non-empty uri');
      return {
        jsonrpc: '2.0',
        id,
        result: await daemonRequest(session, `/resources/read?uri=${encodeURIComponent(uri)}`) as JsonObject,
      };
    }
    if (request.method === 'tools/call') {
      const name = typeof request.params?.name === 'string' ? request.params.name : '';
      if (!createFoldyMcpTools(session.scopes).some((tool) => tool.name === name)) {
        return rpcError(id, -32602, 'tool is not granted');
      }
      let args: Record<string, unknown>;
      try {
        args = validateFoldyMcpToolArguments(name, request.params?.arguments);
      } catch (error) {
        if (error instanceof FoldyMcpArgumentsError) return rpcError(id, -32602, error.message);
        throw error;
      }
      const result = await daemonRequest(session, `/operations/${encodeURIComponent(name)}`, {
        method: 'POST',
        body: JSON.stringify(args),
      });
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
      };
    }
    return rpcError(id, -32601, `method not found: ${request.method}`);
  } catch (error) {
    return rpcError(
      id,
      -32000,
      error instanceof Error ? error.message : String(error),
      (error as { details?: unknown })?.details,
    );
  }
}

export async function runFoldyMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<{ exitCode: number }> {
  const token = env.OD_FOLDY_MCP_TOKEN;
  if (!token) throw new Error('OD_FOLDY_MCP_TOKEN is required');
  const session = await startFoldyMcpSession({
    daemonUrl: env.OD_DAEMON_URL ?? 'http://127.0.0.1:7456',
    token,
  });
  const server = new Server(
    await foldyMcpServerInfo(env),
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: createFoldyMcpTools(session.scopes),
  }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return await daemonRequest(session, '/resources') as { resources: [] };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return await daemonRequest(
      session,
      `/resources/read?uri=${encodeURIComponent(request.params.uri)}`,
    ) as { contents: [] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (!createFoldyMcpTools(session.scopes).some((tool) => tool.name === name)) {
      throw new McpError(ErrorCode.InvalidParams, 'tool is not granted');
    }
    let args: Record<string, unknown>;
    try {
      args = validateFoldyMcpToolArguments(name, request.params.arguments);
    } catch (error) {
      if (error instanceof FoldyMcpArgumentsError) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      throw error;
    }
    const result = await daemonRequest(session, `/operations/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: JSON.stringify(args),
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  await server.connect(new StdioServerTransport());
  return { exitCode: 0 };
}
