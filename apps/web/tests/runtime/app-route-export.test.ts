import { afterEach, describe, expect, it, vi } from 'vitest';
import nextConfig from '../../next.config';
import * as spaShellRoute from '../../app/page';

const originalOutputMode = process.env.OD_WEB_OUTPUT_MODE;

afterEach(() => {
  if (originalOutputMode == null) delete process.env.OD_WEB_OUTPUT_MODE;
  else process.env.OD_WEB_OUTPUT_MODE = originalOutputMode;
  vi.resetModules();
});

describe('SPA shell export route', () => {
  it('stays compatible with static export builds', () => {
    expect(nextConfig.output).toBe('export');
    expect(spaShellRoute.default).toBeTypeOf('function');
    expect('generateStaticParams' in spaShellRoute).toBe(false);
  });

  it.each(['server', 'standalone'] as const)(
    'rewrites %s production deep links to the prerendered SPA shell',
    async (outputMode) => {
      process.env.OD_WEB_OUTPUT_MODE = outputMode;
      vi.resetModules();

      const { default: serverConfig } = await import('../../next.config');
      expect(serverConfig.output).toBe(outputMode === 'standalone' ? 'standalone' : undefined);
      expect(serverConfig.rewrites).toBeTypeOf('function');
      await expect(serverConfig.rewrites?.()).resolves.toMatchObject({
        fallback: [{ source: '/:path*', destination: '/' }],
      });
    },
  );
});
