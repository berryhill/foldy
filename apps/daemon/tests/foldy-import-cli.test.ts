import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { runFoldyImportCli } from '../src/foldy-import-cli.js';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
test('CLI preflight --json and adoption --prompt-file use the same explicit API', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'foldy-cli-'));
  try {
    const input = { confirmExactContent: true, importedRootSha256: 'a'.repeat(64) };
    const file = path.join(root, 'request.json'); await writeFile(file, JSON.stringify(input));
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetcher); vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await runFoldyImportCli(['import-preflight', '--project', 'target', '--daemon-url', 'http://localhost:3456', '--json'])).toBe(0);
    expect(fetcher).toHaveBeenLastCalledWith('http://localhost:3456/api/projects/target/foldy/import-adoption', expect.objectContaining({ method: 'GET' }));
    fetcher.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    expect(await runFoldyImportCli(['adopt-import', '--project', 'target', '--daemon-url', 'http://localhost:3456', '--json', '--prompt-file', file])).toBe(0);
    expect(fetcher).toHaveBeenLastCalledWith('http://localhost:3456/api/projects/target/foldy/import-adoption', expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('CLI will not adopt without explicit request file', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  expect(await runFoldyImportCli(['adopt-import', '--project', 'target', '--json'])).toBe(1);
  expect(fetcher).not.toHaveBeenCalled();
});

test('CLI accepts exact confirmation JSON from --prompt-file -', async () => {
  const input = { confirmExactContent: true, importedRootSha256: 'b'.repeat(64) };
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal('fetch', fetcher);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from([JSON.stringify(input)]) as typeof process.stdin);
  expect(await runFoldyImportCli(['adopt-import', '--project', 'target', '--daemon-url', 'http://localhost:3456', '--prompt-file', '-', '--json'])).toBe(0);
  expect(fetcher).toHaveBeenCalledWith('http://localhost:3456/api/projects/target/foldy/import-adoption', expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }));
});
