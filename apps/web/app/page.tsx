import { ClientApp } from './client-app';

// Open Design is a client-driven SPA. Both output modes serve this one
// prerendered shell: the daemon provides the static-export fallback, while
// server outputs use next.config.ts's fallback rewrite. Rewrites are internal,
// so window.location keeps the requested deep URL for src/router.ts to parse.
export default function Page() {
  return <ClientApp />;
}
