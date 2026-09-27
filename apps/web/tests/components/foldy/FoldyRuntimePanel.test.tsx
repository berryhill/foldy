// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FoldyRuntimeMount,
  FoldyRuntimePanel,
  isFoldyProjectMetadata,
} from '../../../src/components/foldy/FoldyRuntimePanel';

const publication = {
  schemaVersion: 1 as const,
  projectId: 'project-1',
  latestRevisionId: 'rev-2',
  publishedRevisionId: 'rev-1',
  publishedGeneration: 4,
  revisions: [
    { revisionId: 'rev-2', entryFile: 'index.html', createdAt: '2026-09-10T10:00:00Z', createdBy: 'operator', fileCount: 2, byteCount: 10, bundleSha256: 'a'.repeat(64) },
    { revisionId: 'rev-1', entryFile: 'index.html', createdAt: '2026-09-09T10:00:00Z', createdBy: 'operator', fileCount: 1, byteCount: 5, bundleSha256: 'b'.repeat(64) },
  ],
  activeReview: null,
  reviews: [
    { reviewId: 'review-1', revisionId: 'rev-2', status: 'approved' as const, version: 2, requestedAt: '2026-09-10T10:01:00Z', requestedBy: 'operator', comments: [], decidedAt: '2026-09-10T10:02:00Z', decidedBy: 'operator', staleAt: null, staleBecauseRevisionId: null },
  ],
  transitions: [],
};

const deployerGrant = { grantId: 'grant-deployer', projectId: 'project-1', scopes: ['read', 'deployer'], createdAt: '2026-09-10T10:00:00Z', revokedAt: null };
const remoteInstallInfo = {
  server: { label: 'Foldy project-1', transport: 'streamable-http', url: 'https://foldy.example/mcp' },
  tokenHandling: { env: 'OD_FOLDY_MCP_TOKEN', authorizationScheme: 'Bearer', note: 'Use the environment.' },
  clients: {
    gpt: { supported: true, target: 'openai-responses-api', tool: {}, javascript: 'process.env.OD_FOLDY_MCP_TOKEN' },
    claudeDesktop: { bridge: 'mcp-remote', version: '0.14.0', note: 'Bridge', posix: {}, windows: {} },
    claudeCode: { configFile: '.mcp.json', mcpServers: {} },
    generic: { label: 'Foldy', transport: 'streamable-http', url: 'https://foldy.example/mcp', authorization: { type: 'bearer', tokenEnv: 'OD_FOLDY_MCP_TOKEN' } },
  },
  safeTestPrompt: 'List the project without changing it.',
};
const activeReceipt = {
  schemaVersion: 1 as const, receiptId: 'receipt-active', kind: 'deploy' as const, status: 'active' as const,
  recoverable: false,
  projectId: 'project-1', revisionId: 'rev-2', bundleSha256: 'c'.repeat(64), environment: 'production',
  idempotencyKey: 'deploy-key', accessMode: 'public' as const, mcpGrantId: 'grant-deployer', scopes: ['read', 'deployer'],
  expectedActiveProviderRevisionId: null, priorActive: null,
  binding: { providerDeploymentId: 'deployment-1', providerRevisionId: 'provider-rev-2', projectId: 'project-1', revisionId: 'rev-2', bundleSha256: 'c'.repeat(64), environment: 'production', url: 'https://foldy.example/live', mcpUrl: 'https://foldy.example/mcp', accessMode: 'public' as const },
  health: { checks: [{ name: 'artifact', ok: true, status: 200 }, { name: 'mcp', ok: true, status: 200 }] },
  createdAt: '2026-09-12T10:00:00Z', completedAt: '2026-09-12T10:01:00Z', remoteMcpInstallInfo: remoteInstallInfo,
};
const emptyStatus = { projectId: 'project-1', environment: 'production', binding: null, completed: [], staged: [] };

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

function mockBootstrap(access = { enabled: false, authenticated: true }) {
  vi.mocked(fetch).mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/foldy-access/status')) return response(access);
    if (url.endsWith('/publication')) return response(publication);
    if (url.includes('/native-deployments/availability')) return response({ available: false });
    if (url.includes('/mcp/grants')) return response({ grants: [] });
    throw new Error(`Unexpected fetch ${url}`);
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn());
  mockBootstrap();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FoldyRuntimePanel', () => {
  it('shows a newly adopted project as unpublished with approval actions gated', async () => {
    const bootstrap = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => String(input).endsWith('/publication')
      ? response({ ...publication, latestRevisionId: null, publishedRevisionId: null, publishedGeneration: 0, revisions: [], reviews: [] })
      : bootstrap(input, init));
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    expect(await screen.findByText('Not published')).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Save revision' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Publish update' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Request review' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('requires a successful imported-workbook preflight and explicit adoption, then refetches metadata', async () => {
    const preflight = { version: 'foldy-import-adoption.v1', projectId: 'project-1', expectedCurrentRevisionId: null, importedRootSha256: 'a'.repeat(64), metadataSha256: 'b'.repeat(64), rootFiles: [], snapshotKind: 'imported-html-snapshot' };
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input).endsWith('/import-adoption')) return response(init?.method === 'POST' ? { ok: true } : preflight);
      if (String(input) === '/api/projects/project-1') return response({ project: { metadata: { foldy: true, entryFile: 'index.html' } } });
      throw new Error('unexpected request');
    });
    render(<FoldyRuntimeMount projectId="project-1" metadata={{ importedFrom: 'folder', entryFile: 'index.html' }} />);
    const button = await screen.findByRole('button', { name: 'Adopt exact imported content' });
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    fireEvent.click(button);
    await screen.findByRole('button', { name: 'Foldy runtime' });
    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/foldy/import-adoption', expect.objectContaining({ method: 'POST', body: JSON.stringify({ ...preflight, confirmExactContent: true }) }));
    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1', expect.anything());
  });

  it('does not offer adoption for folders without a valid workbook', async () => {
    vi.mocked(fetch).mockImplementation(() => response({ error: { message: 'missing workbook' } }, 422));
    render(<FoldyRuntimeMount projectId="project-1" metadata={{ importedFrom: 'folder' }} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Adopt exact imported content' })).toBeNull();
  });
  it('recognizes only exact Foldy enrollment metadata', () => {
    expect(isFoldyProjectMetadata({ foldy: true, entryFile: 'index.html' })).toBe(true);
    expect(isFoldyProjectMetadata({ foldy: 'true', entryFile: 'index.html' })).toBe(false);
    expect(isFoldyProjectMetadata({ foldy: true })).toBe(false);
    expect(isFoldyProjectMetadata(null)).toBe(false);
  });

  it('mounts the runtime affordance only for an enrolled project', () => {
    const view = render(<FoldyRuntimeMount projectId="project-1" metadata={{ foldy: false, entryFile: 'index.html' }} />);
    expect(screen.queryByRole('button', { name: 'Foldy runtime' })).toBeNull();
    view.rerender(<FoldyRuntimeMount projectId="project-1" metadata={{ foldy: true, entryFile: 'index.html' }} />);
    expect(screen.getByRole('button', { name: 'Foldy runtime' })).not.toBeNull();
  });

  it('shows working, saved, published, review and exact CAS state', async () => {
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    expect(await screen.findByText('Working copy')).not.toBeNull();
    expect(screen.getAllByText('rev-2').length).toBeGreaterThan(0);
    expect(screen.getByText(/Expected publication generation: 4/)).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Publish update' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('heading', { name: 'Review request' })).not.toBeNull();
  });

  it('sends exact revision and CAS payloads', async () => {
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    await screen.findByText('Working copy');
    fireEvent.click(screen.getByRole('button', { name: 'Save revision' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/revisions', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ entryFile: 'index.html', expectedLatestRevisionId: 'rev-2' }),
    })));
    fireEvent.click(screen.getByRole('button', { name: 'Publish update' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/publication/publish', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ revisionId: 'rev-2', expectedPublishedGeneration: 4 }),
    })));
  });

  it('refreshes once instead of retrying a conflicting mutation', async () => {
    let publicationReads = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes('/foldy-access/status')) return response({ enabled: false, authenticated: true });
      if (url.endsWith('/publication')) { publicationReads += 1; return response(publication); }
      if (url.endsWith('/revisions') && init?.method === 'POST') return response({ error: { message: 'changed' } }, 409);
      if (url.includes('/mcp/grants')) return response({ grants: [] });
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    await screen.findByText('Working copy');
    fireEvent.click(screen.getByRole('button', { name: 'Save revision' }));
    expect(await screen.findByText(/changed.*refreshed/i)).not.toBeNull();
    expect(publicationReads).toBe(2);
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith('/revisions') && init?.method === 'POST')).toHaveLength(1);
  });

  it('shows the issued token once while keeping display placeholders out of executable client env', async () => {
    const issued = {
      grant: { grantId: 'grant-1', projectId: 'project-1', scopes: ['read'], createdAt: '2026-09-10T10:00:00Z', revokedAt: null },
      token: 'synthetic-issued-token',
      installInfo: {
        tokenHandling: { env: 'OD_FOLDY_MCP_TOKEN', displayPlaceholder: '<FOLDY_MCP_TOKEN_SECRET_REF>', note: 'Store securely.' },
        clients: {
          gpt: { supported: false, reason: 'Remote connector.' },
          claudeDesktop: { mcpServers: { 'open-design-foldy': { command: 'od', args: ['mcp', 'foldy'], env: { OD_DAEMON_URL: 'http://127.0.0.1:3000' } } } },
          claudeCode: { mcpServers: { 'open-design-foldy': { command: 'od', args: ['mcp', 'foldy'], env: { OD_DAEMON_URL: 'http://127.0.0.1:3000' } } } },
          generic: { command: 'od', args: ['mcp', 'foldy'], env: { OD_DAEMON_URL: 'http://127.0.0.1:3000' } },
        },
        safeTestPrompt: 'Read only.',
        revoke: { method: 'DELETE', path: '/revoke', note: 'Revoke.' },
      },
    };
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes('/foldy-access/status')) return response({ enabled: false, authenticated: true });
      if (url.endsWith('/publication')) return response(publication);
      if (url.includes('/mcp/grants') && init?.method === 'POST') return response(issued, 201);
      if (url.includes('/mcp/grants')) return response({ grants: [] });
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    await screen.findByText('Working copy');
    fireEvent.click(screen.getByRole('button', { name: 'Create grant' }));
    expect(await screen.findByDisplayValue('synthetic-issued-token')).not.toBeNull();
    const panel = screen.getByRole('dialog');
    expect(panel.textContent).toContain('<FOLDY_MCP_TOKEN_SECRET_REF>');
    expect(screen.getByRole('tabpanel').textContent).not.toContain('<FOLDY_MCP_TOKEN_SECRET_REF>');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss token' }));
    expect(screen.queryByDisplayValue('synthetic-issued-token')).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('supports keyboard client tabs and returns focus after backdrop dismissal', async () => {
    const installInfo = {
      tokenHandling: { env: 'OD_FOLDY_MCP_TOKEN', displayPlaceholder: '<FOLDY_MCP_TOKEN_SECRET_REF>', note: 'Store securely.' },
      clients: { gpt: { supported: false, reason: 'Remote.' }, claudeDesktop: {}, claudeCode: {}, generic: {} },
      safeTestPrompt: 'Read only.', revoke: { method: 'DELETE', path: '/revoke', note: 'Revoke.' },
    };
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes('/foldy-access/status')) return response({ enabled: false, authenticated: true });
      if (url.endsWith('/publication')) return response(publication);
      if (url.includes('/mcp/grants?') && !init?.method) return response({ grants: [{ grantId: 'grant-1', projectId: 'project-1', scopes: ['read'], createdAt: '', revokedAt: null }] });
      if (url.endsWith('/install')) return response(installInfo);
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" />);
    const trigger = screen.getByRole('button', { name: 'Foldy runtime' });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByText('Working copy');
    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    const gpt = await screen.findByRole('tab', { name: 'GPT' });
    gpt.focus();
    fireEvent.keyDown(gpt, { key: 'ArrowRight' });
    expect((screen.getByRole('tab', { name: 'Claude Desktop' }) as HTMLElement).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Claude Desktop' }));
    fireEvent.mouseDown(screen.getByTestId('foldy-runtime-backdrop'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('offers an unlock form when the protected browser session is locked', async () => {
    mockBootstrap({ enabled: true, authenticated: false });
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    expect(await screen.findByRole('heading', { name: 'Unlock browser' })).not.toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/publication'))).toBe(false);
    fireEvent.change(screen.getByLabelText('Shared password'), { target: { value: 'long-enough-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/foldy-access/unlock', expect.objectContaining({ method: 'POST' })));
  });

  it('distinguishes local daemon protection from deployed access', async () => {
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    expect(await screen.findByText('Local admin access')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Protect this OpenDesign daemon' })).not.toBeNull();
    expect(screen.getByText(/does not set deployed Foldy access/i)).not.toBeNull();
  });

  it('labels all grants without presenting pending provider revocation as complete', async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/foldy-access/status')) return response({ enabled: false, authenticated: true });
      if (url.endsWith('/publication')) return response(publication);
      if (url.includes('/native-deployments/availability')) return response({ available: false });
      if (url.includes('/mcp/grants?')) return response({ grants: [
        { ...deployerGrant, grantId: 'active', revocationStatus: null },
        { ...deployerGrant, grantId: 'pending', revokedAt: '2026-09-11T00:00:00Z', revocationStatus: 'pending' },
        { ...deployerGrant, grantId: 'complete', revokedAt: '2026-09-11T00:00:00Z', revocationStatus: 'complete' },
      ] });
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    expect(await screen.findByRole('heading', { name: 'Grants' })).not.toBeNull();
    expect(screen.getByText('Revoke pending')).not.toBeNull();
    expect(screen.getByText('Revoked')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Revoke' })).not.toBeNull();
  });
});
