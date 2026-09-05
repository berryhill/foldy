// Tiny URL router. We avoid pulling in react-router for two reasons:
// the surface area we need is small (three routes, plain pushState), and
// we want a single source of truth for "what file is open" — encoding
// that in the URL is the simplest way to make it deep-linkable.

import { useEffect, useState } from 'react';

// Entry-shell sub-views. The home/project landing renders one of three
// columns and each sub-view now owns a top-level path so the browser
// back/forward buttons work, deep links are shareable, and per-tab
// state isn't trapped behind a `useState` boundary.
export type EntryHomeView =
  | 'home'
  | 'projects'
  | 'tasks'
  | 'plugins'
  | 'design-systems'
  | 'integrations';

export type Route =
  | { kind: 'home'; view: EntryHomeView }
  | {
      kind: 'project';
      projectId: string;
      /**
       * Deep-link to a specific conversation inside the project. When
       * present, the project view picks this conversation as the active
       * one instead of defaulting to `list[0]`. Falls back to the
       * default picker when the routed conversation no longer exists.
       * Added for issue #1505 (Routines history → specific conversation).
       */
      conversationId?: string | null;
      fileName: string | null;
    }
  | { kind: 'marketplace' }
  | { kind: 'marketplace-detail'; pluginId: string };

function decodeRoutePart(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.includes('\0') ? null : decoded;
  } catch {
    return null;
  }
}

function decodeFilePath(parts: string[]): string | null {
  const decoded: string[] = [];
  for (const part of parts) {
    const segment = decodeRoutePart(part);
    // Keep path ownership unambiguous: separators come from URL path
    // boundaries, never from an encoded segment, and dot segments may not
    // escape the project root when this value reaches the file viewer.
    if (
      segment == null
      || segment === '.'
      || segment === '..'
      || segment.includes('/')
      || segment.includes('\\')
    ) {
      return null;
    }
    decoded.push(segment);
  }
  return decoded.join('/');
}

export function parseRoute(pathname: string): Route {
  // `useRoute` passes location.pathname, but accepting a copied path with a
  // query/hash here makes the parser safe for other direct-load callers too.
  const pathOnly = pathname.split(/[?#]/, 1)[0] ?? '';
  const parts = pathOnly.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length === 0) return { kind: 'home', view: 'home' };
  if (parts[0] === 'projects') {
    if (parts[1]) {
      const projectId = decodeRoutePart(parts[1]);
      if (projectId == null) return { kind: 'home', view: 'home' };
      // /projects/:id/conversations/:cid[/files/...]
      if (parts[2] === 'conversations' && parts[3]) {
        const conversationId = decodeRoutePart(parts[3]);
        if (conversationId == null) return { kind: 'home', view: 'home' };
        if (parts[4] === 'files' && parts[5]) {
          const fileName = decodeFilePath(parts.slice(5));
          if (fileName == null) return { kind: 'home', view: 'home' };
          return {
            kind: 'project',
            projectId,
            conversationId,
            fileName,
          };
        }
        return { kind: 'project', projectId, conversationId, fileName: null };
      }
      // /projects/:id/files/...
      if (parts[2] === 'files' && parts[3]) {
        const fileName = decodeFilePath(parts.slice(3));
        if (fileName == null) return { kind: 'home', view: 'home' };
        return {
          kind: 'project',
          projectId,
          conversationId: null,
          fileName,
        };
      }
      return { kind: 'project', projectId, conversationId: null, fileName: null };
    }
    return { kind: 'home', view: 'projects' };
  }
  if (parts[0] === 'design-systems') {
    return { kind: 'home', view: 'design-systems' };
  }
  if (parts[0] === 'automations' || parts[0] === 'tasks') {
    return { kind: 'home', view: 'tasks' };
  }
  if (parts[0] === 'plugins' && !parts[1]) {
    return { kind: 'home', view: 'plugins' };
  }
  if (parts[0] === 'integrations') {
    return { kind: 'home', view: 'integrations' };
  }
  // Phase 2B / spec §11.6 — marketplace deep UI routes. Two paths:
  //   /marketplace            → catalog grid (MarketplaceView)
  //   /marketplace/<pluginId> → detail page (PluginDetailView)
  // Aliases to /plugins remain reserved for the public site (spec §13);
  // in-app we keep /marketplace canonical.
  if (parts[0] === 'marketplace' || parts[0] === 'plugins') {
    if (parts[1]) {
      return { kind: 'marketplace-detail', pluginId: decodeURIComponent(parts[1]) };
    }
    return { kind: 'marketplace' };
  }
  return { kind: 'home', view: 'home' };
}

export function buildPath(route: Route): string {
  if (route.kind === 'home') {
    if (route.view === 'projects') return '/projects';
    if (route.view === 'tasks') return '/automations';
    if (route.view === 'plugins') return '/plugins';
    if (route.view === 'design-systems') return '/design-systems';
    if (route.view === 'integrations') return '/integrations';
    return '/';
  }
  if (route.kind === 'marketplace') return '/marketplace';
  if (route.kind === 'marketplace-detail') return `/marketplace/${encodeURIComponent(route.pluginId)}`;
  const id = encodeURIComponent(route.projectId);
  const file = route.fileName
    ? route.fileName.split('/').map((s) => encodeURIComponent(s)).join('/')
    : null;
  if (route.conversationId) {
    const cid = encodeURIComponent(route.conversationId);
    return file
      ? `/projects/${id}/conversations/${cid}/files/${file}`
      : `/projects/${id}/conversations/${cid}`;
  }
  return file ? `/projects/${id}/files/${file}` : `/projects/${id}`;
}

// Centralized navigation. Components call this instead of mutating
// `window.location` directly so we can fan the change out to any
// `useRoute()` subscriber via a custom event.
export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const targetPath = buildPath(route);
  const suffix = `${window.location.search}${window.location.hash}`;
  const target = `${targetPath}${suffix}`;
  const current = `${window.location.pathname}${suffix}`;
  if (target === current) return;
  if (opts.replace) {
    window.history.replaceState(null, '', target);
  } else {
    window.history.pushState(null, '', target);
  }
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return route;
}
