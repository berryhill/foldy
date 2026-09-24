import { afterEach, beforeEach, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, stat, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runFoldyInstanceCli } from '../src/foldy-runtime/instance-cli.js';
let server: Server, root: string, origin: string, cookie: string, token: string;
let requests: { path: string; method: string; origin: string | undefined; cookie: string | undefined; body: unknown }[];
let status = 200, payload: unknown, out: string, err: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'instance-cli-'));
  cookie = `__Host-foldy-owner=${randomBytes(32).toString('base64url')}`;
  token = randomBytes(32).toString('base64url');
  await writeFile(join(root, 'owner'), cookie, { mode: 0o600 });
  requests = []; status = 200; payload = { state: 'READY' }; out = ''; err = '';
  server = createServer(async (req, res) => {
    const parts = []; for await (const chunk of req) parts.push(chunk);
    const text = Buffer.concat(parts).toString();
    requests.push({ path: req.url!, method: req.method!, origin: req.headers.origin, cookie: req.headers.cookie, body: text ? JSON.parse(text) : undefined });
    if (req.url === '/api/claim' || req.url === '/api/owner/recover') res.setHeader('set-cookie', `${cookie}; Secure; HttpOnly; Path=/`);
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
const run = (args: string[], input = '') => runFoldyInstanceCli(args, { stdin: Readable.from([input]), stdout: text => { out += text; }, stderr: text => { err += text; } });
const flags = () => ['--instance-url', origin, '--allow-loopback-http', '--owner-cookie-file', join(root, 'owner'), '--json'];
test('readiness uses owner cookie and exact origin', async () => {
  expect(await run(['readiness', ...flags()])).toBe(0);
  expect(requests[0]).toMatchObject({ path: '/api/readiness', method: 'GET', cookie, origin });
  expect(JSON.parse(out).state).toBe('READY');
});
test('owner status and diagnostics use authenticated common HTTP surfaces', async () => {
  expect(await run(['status', ...flags()])).toBe(0);
  expect(await run(['diagnostics', ...flags()])).toBe(0);
  expect(requests.map(r => r.path)).toEqual(['/api/owner/status', '/api/owner/diagnostics']);
  expect(requests.every(r => r.cookie === cookie && r.method === 'GET')).toBe(true);
});
test('operations are shared-domain passthrough, not a parallel command schema', async () => {
  const body = { name: 'future_domain_operation', arguments: { expectedRevisionId: 'r1' } };
  expect(await run(['operation', ...flags(), '--prompt-file', '-'], JSON.stringify(body))).toBe(0);
  expect(requests[0]).toMatchObject({ path: '/api/operations', method: 'POST', body });
});
test('access status and protected password configuration use existing endpoints', async () => {
  expect(await run(['access-status', ...flags()])).toBe(0);
  const body = { mode: 'password_required', password: randomBytes(24).toString('hex') };
  await writeFile(join(root, 'input'), JSON.stringify(body), { mode: 0o600 });
  expect(await run(['access-config', ...flags(), '--prompt-file', join(root, 'input')])).toBe(0);
  expect(requests.map(r => r.path)).toEqual(['/api/owner/viewer-access', '/api/owner/viewer-access']);
  expect(requests[1]!.body).toEqual(body);
  expect(out + err).not.toContain(body.password);
});
test('grant issuance requires exclusive custody, recursively scrubs JSON and never overwrites', async () => {
  payload = { grantId: 'g1', token, nested: { password: token }, scopes: ['foldy:read'] };
  expect(await run(['mcp-grant-create', ...flags(), '--prompt-file', '-'], '{}')).toBe(1);
  expect(requests).toHaveLength(0);
  const custody = join(root, 'grant');
  expect(await run(['mcp-grant-create', ...flags(), '--prompt-file', '-', '--credential-file', custody], '{}')).toBe(0);
  expect(JSON.parse(await readFile(custody, 'utf8')).token).toBe(token);
  expect((await stat(custody)).mode & 0o777).toBe(0o600);
  expect(out + err).not.toContain(token);
  expect(await run(['mcp-grant-create', ...flags(), '--prompt-file', '-', '--credential-file', custody], '{}')).toBe(1);
  expect(requests).toHaveLength(1);
});
test('claim reads assertion only from stdin and stores reusable owner cookie', async () => {
  const assertion = randomBytes(32).toString('base64url');
  expect(await run(['claim', '--instance-url', origin, '--allow-loopback-http', '--prompt-file', '-', '--credential-file', join(root, 'claimed')], JSON.stringify({ assertion }))).toBe(0);
  expect(await readFile(join(root, 'claimed'), 'utf8')).toBe(cookie + '\n');
  expect(out + err).not.toContain(assertion);
});
test('revoke calls exact endpoint', async () => {
  expect(await run(['mcp-grant-revoke', ...flags(), '--prompt-file', '-'], '{"grantId":"g1"}')).toBe(0);
  expect(requests[0]).toMatchObject({ path: '/api/mcp-grants/revoke', body: { grantId: 'g1' } });
});
test('help is human readable and succeeds without an origin or network', async () => {
  expect(await run(['--help'])).toBe(0);
  expect(out).toContain('Usage: od foldy instance');
  expect(out).toContain('--output-file');
  expect(out).toContain('recover');
  expect(err).toBe(''); expect(requests).toHaveLength(0);
});
test('backup writes intact data exclusively to private custody, never stdout', async () => {
  payload = { workbook: { title: 'secret research', token: 'workbook-content', text: cookie } };
  expect(await run(['backup', ...flags()])).toBe(1);
  expect(requests).toHaveLength(0);
  const output = join(root, 'backup.json');
  expect(await run(['backup', ...flags(), '--output-file', output])).toBe(0);
  expect(requests[0]).toMatchObject({ path: '/api/backup', method: 'GET', cookie, origin });
  expect(await readFile(output, 'utf8')).toBe(JSON.stringify(payload));
  expect((await stat(output)).mode & 0o777).toBe(0o600);
  expect(out).not.toContain('workbook-content'); expect(out).not.toContain(cookie);
  expect(await run(['backup', ...flags(), '--output-file', output])).toBe(1);
  expect(requests).toHaveLength(1);
});
test('backup rejects symlinks and nonprivate parent directories before requesting', async () => {
  await symlink(join(root, 'owner'), join(root, 'linked-backup'));
  expect(await run(['backup', ...flags(), '--output-file', join(root, 'linked-backup')])).toBe(1);
  await chmod(root, 0o755);
  expect(await run(['backup', ...flags(), '--output-file', join(root, 'backup')])).toBe(1);
  expect(requests).toHaveLength(0);
});
test('recover requires custody and posts the authority assertion schema without old cookie', async () => {
  const assertion = randomBytes(32).toString('base64url');
  const args = ['recover', '--instance-url', origin, '--allow-loopback-http', '--prompt-file', '-'];
  expect(await run(args, JSON.stringify({ assertion }))).toBe(1);
  expect(requests).toHaveLength(0);
  payload = { recovered: true };
  expect(await run([...args, '--credential-file', join(root, 'recovered')], JSON.stringify({ assertion }))).toBe(0);
  expect(requests[0]).toMatchObject({ path: '/api/owner/recover', method: 'POST', body: { assertion }, cookie: undefined, origin });
  expect(await readFile(join(root, 'recovered'), 'utf8')).toBe(cookie + '\n');
  expect(out + err).not.toContain(assertion); expect(out + err).not.toContain(cookie);
});
test('logout posts empty object with owner authentication', async () => {
  payload = { loggedOut: true };
  expect(await run(['logout', ...flags()])).toBe(0);
  expect(requests[0]).toMatchObject({ path: '/api/owner/logout', method: 'POST', body: {}, cookie, origin });
  expect(JSON.parse(out)).toEqual(payload);
});
test('parser and HTTPS policy fail closed without reflecting argv secrets', async () => {
  for (const args of [
    ['readiness', '--instance-url', origin],
    ['readiness', '--instance-url', 'http://example.com', '--allow-loopback-http'],
    ['readiness', '--instance-url', 'https://example.com/path'],
    ['readiness', '--instance-url', 'https://user:password@example.com'],
    ['readiness', ...flags(), '--token', token],
    ['readiness', ...flags(), '--json'],
    ['readiness', ...flags(), '--prompt-file', '-'],
  ]) expect(await run(args)).toBe(1);
  expect(requests).toHaveLength(0); expect(err).not.toContain(token);
});
test('insecure files and symlinks are rejected before network', async () => {
  await chmod(join(root, 'owner'), 0o644);
  expect(await run(['readiness', ...flags()])).toBe(1);
  await chmod(join(root, 'owner'), 0o600);
  await symlink(join(root, 'owner'), join(root, 'link'));
  expect(await run(['readiness', '--instance-url', origin, '--allow-loopback-http', '--owner-cookie-file', join(root, 'link')])).toBe(1);
  expect(requests).toHaveLength(0);
});
test('manifest is public and responses redact secret copies in unrelated fields', async () => {
  payload = { token, message: `issued ${token}`, nested: [{ authorization: token }] };
  expect(await run(['mcp-manifest', '--instance-url', origin, '--allow-loopback-http', '--json'])).toBe(0);
  expect(requests[0]).toMatchObject({ path: '/mcp/manifest.json', cookie: undefined });
  expect(out + err).not.toContain(token);
});
test('redirects are not followed with owner credentials', async () => {
  server.removeAllListeners('request');
  let count = 0;
  server.on('request', (_req, res) => { count++; res.writeHead(302, { location: origin + '/redirected' }); res.end(); });
  expect(await run(['readiness', ...flags()])).toBe(1);
  expect(count).toBe(1); expect(out + err).not.toContain(cookie);
});
test('server failures and malformed inputs do not expose bodies or echoed credentials', async () => {
  status = 403; payload = { message: token, token };
  expect(await run(['readiness', ...flags()])).toBe(1);
  expect(err).toContain('HTTP_403'); expect(out + err).not.toContain(token);
  expect(await run(['operation', ...flags(), '--prompt-file', '-'], token)).toBe(1);
  expect(out + err).not.toContain(token);
});
