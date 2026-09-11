import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

interface AcceptanceContext {
  root: string;
}

function bootstrap(): AcceptanceContext {
  const root = mkdtempSync(path.join(tmpdir(), 'foldy-acceptance-'));
  return { root };
}

function cleanup(ctx: AcceptanceContext): void {
  rmSync(ctx.root, { recursive: true, force: true });
}

describe('foldy essential MVI acceptance harness', () => {
  let ctx: AcceptanceContext;
  beforeEach(() => { ctx = bootstrap(); });
  afterEach(() => { cleanup(ctx); });

  it('proves canonical publication file surface is reachable from the harness root', async () => {
    const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
    mkdirSync(path.join(ctx.root, 'projects/p'), { recursive: true });
    writeFileSync(path.join(ctx.root, 'projects/p/index.html'), '<h1>hello</h1>');
    expect(existsSync(path.join(ctx.root, 'projects/p/index.html'))).toBe(true);
  });

  it('runs the focused Foldy suite as the bounded acceptance repair loop', async () => {
    const { spawnSync } = await import('node:child_process');
    const targets = [
      'tests/foldy-publication-store.test.ts',
      'tests/foldy-publication-routes.test.ts',
      'tests/foldy-access/browser-password-gate.test.ts',
      'tests/foldy-access/server-wiring.test.ts',
      'tests/foldy-mcp/grants.test.ts',
      'tests/foldy-mcp/routes.test.ts',
      'tests/foldy-mcp/stdio-install.test.ts',
      'tests/foldy-cynder-deployment.test.ts',
      'tests/foldy-cynder-routes.test.ts',
    ];
    let failed = 0;
    for (const t of targets) {
      const result = spawnSync('corepack', ['pnpm', 'exec', 'vitest', 'run', '-c', 'vitest.config.ts', t], {
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 180_000,
      });
      if (result.status !== 0) { failed += 1; }
    }
    expect(failed).toBe(0);
  }, 300_000);
});
