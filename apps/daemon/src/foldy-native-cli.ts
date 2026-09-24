import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
const usage = 'Usage: od native-deployment prepare|execute|inspect|reconcile --daemon-url URL --credential-file FILE [--prompt-file FILE|-] [--operation-id ID] [--json]\n';
async function privateFile(file: string, maxBytes: number): Promise<string> {
  const f = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await f.stat();
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) || st.size > maxBytes) throw new Error();
    return await f.readFile('utf8');
  } finally { await f.close(); }
}
async function inputText(file: string): Promise<string> {
  if (file !== '-') return privateFile(file, 262144);
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk); bytes += value.length;
    if (bytes > 262144) throw new Error();
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function runNativeDeploymentCli(args: string[]): Promise<void> {
  try {
    if (args.length === 1 && args[0] === '--help') { process.stdout.write(usage); return; }
    const [command, ...rest] = args;
    if (!['prepare', 'execute', 'inspect', 'reconcile'].includes(command ?? '')) throw new Error();
    const flags: Record<string, string> = {};
    let json = false;
    for (let i = 0; i < rest.length; i++) {
      const k = rest[i]!;
      if (k === '--json') { if (json) throw new Error(); json = true; continue; }
      const key = k === '--input-file' ? '--prompt-file' : k;
      if (!['--daemon-url', '--credential-file', '--prompt-file', '--operation-id'].includes(key) || !rest[i + 1] || flags[key]) throw new Error();
      flags[key] = rest[++i]!;
    }
    const base = new URL(flags['--daemon-url']!);
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || !['http:', 'https:'].includes(base.protocol)) throw new Error();
    const cookie = (await privateFile(flags['--credential-file']!, 4096)).trim();
    if (!/^foldy_browser_session=[A-Za-z0-9._-]+$/.test(cookie)) throw new Error();
    const id = flags['--operation-id'];
    if ((command === 'inspect' || command === 'reconcile') && !/^[a-f0-9]{64}$/.test(id ?? '')) throw new Error();
    if ((command === 'prepare' || command === 'execute') && id !== undefined) throw new Error();
    if (command === 'inspect' && flags['--prompt-file']) throw new Error();
    const suffix = command === 'inspect' ? '/' + id : command === 'reconcile' ? '/' + id + '/reconcile' : '/' + command;
    const body = command === 'inspect' ? undefined : JSON.stringify(JSON.parse(command === 'reconcile' && !flags['--prompt-file'] ? '{}' : await inputText(flags['--prompt-file']!)));
    const res = await fetch(base.origin + '/api/foldy/native-deployments' + suffix, { method: command === 'inspect' ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { cookie, origin: base.origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body }) });
    if (!res.ok) throw new Error();
    const reader = res.body?.getReader(); if (!reader) throw new Error();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break;
        bytes += value.length; if (bytes > 262144) throw new Error(); chunks.push(value); }
    } finally { await reader.cancel(); }
    const output = JSON.stringify(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (output.includes(cookie) || output.includes(cookie.slice(cookie.indexOf('=') + 1))) throw new Error();
    process.stdout.write(output + '\n');
  } catch { process.stdout.write(JSON.stringify({ error: { code: 'FOLDY_CLI_REQUEST_FAILED' } }) + '\n'); process.exitCode = 1; }
}
