import { afterEach, beforeEach, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
let server: Server, root: string, origin: string, cookie: string;
let requests: { path: string; method: string; body: unknown }[];
const operationId = 'a'.repeat(64);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'native-cli-'));
  cookie = `foldy_browser_session=${randomBytes(32).toString('base64url')}`;
  await writeFile(join(root, 'session'), cookie, { mode: 0o600 });
  await writeFile(join(root, 'input'), '{}', { mode: 0o600 });
  requests = [];
  server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    requests.push({ path: req.url!, method: req.method!, body: text ? JSON.parse(text) : undefined });
    if (req.headers.cookie !== cookie || req.headers.origin !== origin) { res.writeHead(401); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ operationId, state: 'quoted' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
function run(args: string[], stdin = ''): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    const child = execFile(process.execPath, ['--import', 'tsx', 'tests/fixtures/native-deployment-cli.ts', ...args],
    { cwd: process.cwd(), timeout: 10000 }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, output: stdout + stderr }));
    child.stdin!.end(stdin);
  });
}
const flags = () => ['--daemon-url', origin, '--credential-file', join(root, 'session'), '--json'];
test('help succeeds without credentials or network', async () => {
  const result = await run(['--help']); expect(result.code).toBe(0); expect(result.output).toContain('Usage: od native-deployment'); expect(requests).toHaveLength(0);
});
test('all commands use shared HTTP routes and prompt-file stdin', async () => {
  for (const command of ['prepare', 'execute', 'inspect', 'reconcile']) {
    const args = [command, ...flags()];
    if (command === 'inspect' || command === 'reconcile') args.push('--operation-id', operationId);
    if (command !== 'inspect') args.push('--prompt-file', '-');
    const result = await run(args, '{}'); expect(result.code).toBe(0); expect(JSON.parse(result.output).operationId).toBe(operationId);
  }
  expect(requests.map(r => r.path)).toEqual(['/api/foldy/native-deployments/prepare', '/api/foldy/native-deployments/execute', `/api/foldy/native-deployments/${operationId}`, `/api/foldy/native-deployments/${operationId}/reconcile`]);
});
test('unsafe credential custody and unknown flags fail without disclosure or requests', async () => {
  await chmod(join(root, 'session'), 0o644);
  expect((await run(['inspect', ...flags(), '--operation-id', operationId])).code).toBe(1);
  await chmod(join(root, 'session'), 0o600); await symlink(join(root, 'session'), join(root, 'link'));
  const result = await run(['inspect', '--daemon-url', origin, '--credential-file', join(root, 'link'), '--operation-id', operationId]);
  expect(result.code).toBe(1); expect(result.output).not.toContain(cookie); expect(requests).toHaveLength(0);
});
test('server failure bodies cannot reflect credential values', async () => {
  server.removeAllListeners('request'); server.on('request', (_req, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: cookie })); });
  const result = await run(['inspect', '--daemon-url', origin, '--credential-file', join(root, 'session'), '--operation-id', operationId]);
  expect(result.code).toBe(1); expect(result.output).not.toContain(cookie);
});
