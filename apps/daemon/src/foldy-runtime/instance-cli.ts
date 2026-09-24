import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface FoldyInstanceCliIO {
  stdin?: AsyncIterable<string | Uint8Array>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}
class CliError extends Error {}
function fail(code: string): never { throw new CliError(code); }
const limit = 65536;
const sensitive = /password|secret|token|cookie|authorization|assertion|verifier|credential|privatekey|apikey/i;
const routes: Record<string, { path: string; post?: boolean; owner?: boolean; issue?: boolean }> = {
  readiness: { path: '/api/readiness', owner: true },
  status: { path: '/api/owner/status', owner: true },
  diagnostics: { path: '/api/owner/diagnostics', owner: true },
  operation: { path: '/api/operations', post: true, owner: true },
  'access-status': { path: '/api/owner/viewer-access', owner: true },
  'access-config': { path: '/api/owner/viewer-access', post: true, owner: true },
  'mcp-manifest': { path: '/mcp/manifest.json' },
  'mcp-grant-create': { path: '/api/mcp-grants', post: true, owner: true, issue: true },
  'mcp-grant-list': { path: '/api/mcp-grants', owner: true },
  'mcp-grant-revoke-all': { path: '/api/mcp-grants/revoke-all', post: true, owner: true },
  'mcp-grant-revoke': { path: '/api/mcp-grants/revoke', post: true, owner: true },
  claim: { path: '/api/claim', post: true, issue: true },
  recover: { path: '/api/owner/recover', post: true, issue: true },
  logout: { path: '/api/owner/logout', post: true, owner: true },
  backup: { path: '/api/backup', owner: true },
};
async function protectedRead(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await file.stat();
    if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) || (process.getuid && s.uid !== process.getuid()) || s.size > limit) fail('PROTECTED_FILE_REQUIRED');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
async function stdinRead(input: AsyncIterable<string | Uint8Array>): Promise<string> {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of input) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > limit) fail('REQUEST_TOO_LARGE'); parts.push(bytes); }
  return Buffer.concat(parts).toString('utf8');
}
function collectSecrets(value: unknown, secrets: Set<string>, protectedValue = false): void {
  if (typeof value === 'string' && protectedValue && value) secrets.add(value);
  else if (Array.isArray(value)) value.forEach(v => collectSecrets(v, secrets, protectedValue));
  else if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) collectSecrets(v, secrets, protectedValue || sensitive.test(key));
}
function scrub(value: unknown, secrets: Set<string>): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text.replace(/Bearer\s+[^\s"']+|__Host-foldy-owner=[^\s;"']+/gi, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(v => scrub(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [String(scrub(k, secrets)), sensitive.test(k) ? '[REDACTED]' : scrub(v, secrets)]));
  return value;
}
/** args begins with the action, after `od foldy instance`. Never accepts credentials in argv. */
export async function runFoldyInstanceCli(args: string[], io: FoldyInstanceCliIO = {}): Promise<number> {
  const stdout = io.stdout ?? (text => { process.stdout.write(text); });
  const stderr = io.stderr ?? (text => { process.stderr.write(text); });
  let custody: FileHandle | undefined;
  try {
    const [command, ...rest] = args;
    if (args.includes('--help') || args.includes('-h') || command === 'help') {
      stdout(`Usage: od foldy instance <action> --instance-url <https-origin> [options]

Actions: readiness, status, diagnostics, operation, access-status, access-config, mcp-manifest,
         mcp-grant-create, mcp-grant-list, mcp-grant-revoke, mcp-grant-revoke-all, claim, recover, logout, backup

Options:
  --owner-cookie-file <protected-file>   Required for owner actions
  --prompt-file <protected-json-file|->  JSON request; '-' reads stdin
  --credential-file <new-private-file>   Required for claim, recover and grant creation
  --output-file <new-private-file>       Required for backup; never prints workbook data
  --json                                Compact JSON status output
  --allow-loopback-http                  Development only: 127.0.0.1
  --help                                Show this help

Claim/recover JSON: {"assertion":"<one-use assertion>"}; recovery requires
operator-installed recovery authorization. Logout posts {} (no prompt required).
Credential and backup files are exclusive, mode 0600 in a private directory.
An output file left after failure may be incomplete; do not treat it as success.
`);
      return 0;
    }
    const flags = new Map<string, string>();
    for (let i = 0; i < rest.length; i++) {
      const key = rest[i]!;
      if (flags.has(key)) fail('DUPLICATE_OPTION');
      if (key === '--json' || key === '--allow-loopback-http') { flags.set(key, 'true'); continue; }
      if (!['--instance-url', '--owner-cookie-file', '--prompt-file', '--credential-file', '--output-file'].includes(key)) fail('INVALID_OPTION');
      const value = rest[++i]; if (!value || value.startsWith('--')) fail('OPTION_VALUE_REQUIRED');
      flags.set(key, value);
    }
    const route = command && Object.hasOwn(routes, command) ? routes[command] : undefined;
    if (!route || !flags.has('--instance-url')) fail('USAGE: od foldy instance readiness|operation|access-status|access-config|mcp-manifest|mcp-grant-create|mcp-grant-revoke|claim --instance-url <https-origin> [--owner-cookie-file <protected-file>] [--prompt-file <protected-json-file|->] [--credential-file <new-private-file>] [--json]');
    const rawOrigin = flags.get('--instance-url')!;
    let url: URL;
    try { url = new URL(rawOrigin); } catch { return fail('INVALID_ORIGIN'); }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || ![url.origin, url.origin + '/'].includes(rawOrigin)) fail('INVALID_ORIGIN');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && flags.has('--allow-loopback-http') && url.hostname === '127.0.0.1')) fail('HTTPS_REQUIRED');
    if (!!(route.post && !['logout','mcp-grant-revoke-all'].includes(command || '')) !== flags.has('--prompt-file')) fail('PROMPT_FILE_REQUIRED_FOR_WRITES_ONLY');
    if (!!route.owner !== flags.has('--owner-cookie-file')) fail('OWNER_COOKIE_FILE_REQUIRED_FOR_OWNER_ACTIONS_ONLY');
    if (!!route.issue !== flags.has('--credential-file')) fail('CREDENTIAL_FILE_REQUIRED_FOR_ISSUANCE_ONLY');
    if ((command === 'backup') !== flags.has('--output-file')) fail('OUTPUT_FILE_REQUIRED_FOR_BACKUP_ONLY');
    const secrets = new Set<string>();
    const headers: Record<string, string> = { origin: url.origin, accept: 'application/json' };
    if (route.owner) {
      const cookie = (await protectedRead(flags.get('--owner-cookie-file')!)).trim();
      if (!/^__Host-foldy-owner=[A-Za-z0-9_-]{1,256}$/.test(cookie)) fail('OWNER_COOKIE_INVALID');
      headers.cookie = cookie; secrets.add(cookie); secrets.add(cookie.split('=')[1]!);
    }
    let body: string | undefined;
    if (['logout','mcp-grant-revoke-all'].includes(command || '')) { body = '{}'; headers['content-type'] = 'application/json'; }
    else if (route.post) {
      const path = flags.get('--prompt-file')!;
      const text = path === '-' ? await stdinRead(io.stdin ?? process.stdin) : await protectedRead(path);
      let input: unknown; try { input = JSON.parse(text); } catch { return fail('REQUEST_JSON_INVALID'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('REQUEST_OBJECT_REQUIRED');
      collectSecrets(input, secrets); body = JSON.stringify(input); headers['content-type'] = 'application/json';
    }
    if (route.issue || command === 'backup') {
      // Reserve before mutation. Keep the file on failure: remote outcome may be uncertain.
      const path = resolve(flags.get(command === 'backup' ? '--output-file' : '--credential-file')!);
      const parent = await lstat(dirname(path));
      if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) || (process.getuid && parent.uid !== process.getuid())) fail('PRIVATE_CUSTODY_DIRECTORY_REQUIRED');
      custody = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    }
    const response = await fetch(url.origin + route.path, { method: route.post ? 'POST' : 'GET', headers, ...(body ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); fail(`HTTP_${response.status}`); }
    if (command === 'backup') {
      // Backup bytes are domain data, not diagnostic output: never redact them.
      if (!response.body || !custody) fail('BACKUP_BODY_MISSING');
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await custody.writeFile(value);
        }
      } finally { reader.releaseLock(); }
      await custody.sync();
      stdout(JSON.stringify({ ok: true, saved: true }) + '\n');
      return 0;
    }
    let result: unknown;
    try { result = await response.json(); } catch { return fail('RESPONSE_JSON_INVALID'); }
    collectSecrets(result, secrets);
    if (custody) {
      if (command === 'claim' || command === 'recover') {
        const cookie = response.headers.get('set-cookie')?.split(';')[0];
        if (!cookie || !/^__Host-foldy-owner=[A-Za-z0-9_-]{1,256}$/.test(cookie)) fail('OWNER_COOKIE_MISSING');
        secrets.add(cookie); secrets.add(cookie.split('=')[1]!);
        await custody.writeFile(cookie + '\n');
      } else {
        if (!result || typeof result !== 'object' || !('token' in result) || typeof result.token !== 'string' || !result.token) fail('GRANT_TOKEN_MISSING');
        await custody.writeFile(JSON.stringify(result) + '\n');
      }
      await custody.sync();
    }
    stdout(JSON.stringify(scrub(result, secrets), null, flags.has('--json') ? undefined : 2) + '\n');
    return 0;
  } catch (error) {
    // Never print native/network/JSON error messages: they can embed credentials.
    stderr(JSON.stringify({ ok: false, error: { code: error instanceof CliError ? error.message : 'INSTANCE_REQUEST_FAILED' } }) + '\n');
    return 1;
  } finally { await custody?.close().catch(() => {}); }
}
