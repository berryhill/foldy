import { readFile } from 'node:fs/promises';
import { resolveDaemonUrl } from './daemon-url.js';

async function readConfirmation(file: string): Promise<string> {
  if (file !== '-') return readFile(file, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function runFoldyImportCli(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  const flags: Record<string, string> = {};
  try {
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i]!;
      if (flag === '--json') { flags.json = 'true'; continue; }
      if (!['--project', '--prompt-file', '--daemon-url'].includes(flag) || !rest[i + 1] || rest[i + 1]!.startsWith('--')) throw new Error(`invalid option: ${flag}`);
      if (flags[flag]) throw new Error(`duplicate option: ${flag}`);
      flags[flag] = rest[++i]!;
    }
    if (!['import-preflight', 'adopt-import'].includes(command ?? '') || !flags['--project']) throw new Error('Usage: od foldy import-preflight|adopt-import --project <id> [--prompt-file <confirmed-request.json>] [--json] [--daemon-url <url>]');
    if (command === 'adopt-import' && !flags['--prompt-file']) throw new Error('adopt-import requires --prompt-file containing the exact preflight plus confirmExactContent:true');
    if (command === 'import-preflight' && flags['--prompt-file']) throw new Error('preflight does not accept --prompt-file');
    const url = await resolveDaemonUrl(flags['--daemon-url'] ? { flagUrl: flags['--daemon-url'] } : {});
    const body = flags['--prompt-file'] ? JSON.stringify(JSON.parse(await readConfirmation(flags['--prompt-file']))) : undefined;
    const response = await fetch(`${url}/api/projects/${encodeURIComponent(flags['--project'])}/foldy/import-adoption`, {
      method: command === 'adopt-import' ? 'POST' : 'GET',
      ...(body ? { body, headers: { 'content-type': 'application/json' } } : {}),
    });
    const result: unknown = await response.json();
    process.stdout.write(`${JSON.stringify(result, null, flags.json ? undefined : 2)}\n`);
    return response.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { message: error instanceof Error ? error.message : String(error) } })}\n`);
    return 1;
  }
}
