import { afterEach, describe, expect, it, vi } from 'vitest';
import nextConfig from '../../next.config';
import * as spaShellRoute from '../../app/page';

const originalOutputMode = process.env.OD_WEB_OUTPUT_MODE;

afterEach(() => {
  if (originalOutputMode == null) delete process.env.OD_WEB_OUTPUT_MODE;
  else process.env.OD_WEB_OUTPUT_MODE = originalOutputMode;
  vi.unstubAllEnvs();
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

  it('proxies Foldy publication URLs to the daemon during development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('OD_PORT', '17456');
    delete process.env.OD_WEB_OUTPUT_MODE;
    vi.resetModules();

    const { default: developmentConfig } = await import('../../next.config');
    expect(developmentConfig.rewrites).toBeTypeOf('function');
    await expect(developmentConfig.rewrites?.()).resolves.toMatchObject({
      beforeFiles: [
        { source: '/api/:path*', destination: 'http://127.0.0.1:17456/api/:path*' },
        { source: '/artifacts/:path*', destination: 'http://127.0.0.1:17456/artifacts/:path*' },
        { source: '/frames/:path*', destination: 'http://127.0.0.1:17456/frames/:path*' },
        { source: '/p/:path*', destination: 'http://127.0.0.1:17456/p/:path*' },
      ],
    });
  });
});
