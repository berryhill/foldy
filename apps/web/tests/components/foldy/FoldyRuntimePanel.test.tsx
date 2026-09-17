// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDeploymentReviewKey,
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
    if (url.includes('/cynder/status')) return response(emptyStatus);
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
  it('serializes deployment review identity without plaintext password material', () => {
    const serialized = createDeploymentReviewKey({
      revision: 'rev-2', environment: 'production', expected: null,
      accessMode: 'password_required', mcpGrantId: 'grant-deployer', formRevision: 7,
    });
    expect(serialized).not.toContain('sensitive-password-value');
    expect(JSON.parse(serialized)).toEqual({
      revision: 'rev-2', environment: 'production', expected: null,
      accessMode: 'password_required', mcpGrantId: 'grant-deployer', formRevision: 7,
    });
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

  it('requires access and an explicit deployer grant before exact review', async () => {
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    await screen.findByText('Working copy');
    expect(screen.getByText(/requires both read and deployer scopes/i)).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Review deployment' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends public deployed access and explicit MCP grant only after unchanged review', async () => {
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes('/foldy-access/status')) return response({ enabled: false, authenticated: true });
      if (url.endsWith('/publication')) return response(publication);
      if (url.includes('/cynder/status')) return response(emptyStatus);
      if (url.includes('/mcp/grants?')) return response({ grants: [deployerGrant] });
      if (url.includes('/cynder/deploy') && init?.method === 'POST') return response(activeReceipt, 201);
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    await screen.findByText('Working copy');
    fireEvent.change(screen.getByLabelText('MCP grant'), { target: { value: 'grant-deployer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review deployment' }));
    fireEvent.change(screen.getByLabelText('Expected provider revision'), { target: { value: 'changed' } });
    expect((screen.getByRole('button', { name: 'Deploy exact revision' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Expected provider revision'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review deployment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deploy exact revision' }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes('/cynder/deploy'));
      const body = JSON.parse(String(call?.[1]?.body));
      expect(body).toMatchObject({ environment: 'production', accessMode: 'public', mcpGrantId: 'grant-deployer' });
      expect(body).not.toHaveProperty('password');
    });
  });

  it('shows deployment password only when required and enforces eight characters', async () => {
    let deployBody: Record<string, unknown> | null = null;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes('/foldy-access/status')) return response({ enabled: false, authenticated: true });
      if (url.endsWith('/publication')) return response(publication);
      if (url.includes('/cynder/status')) return response(emptyStatus);
      if (url.includes('/mcp/grants?')) return response({ grants: [deployerGrant] });
      if (url.includes('/cynder/deploy') && init?.method === 'POST') { deployBody = JSON.parse(String(init.body)); return response({ ...activeReceipt, accessMode: 'password_required', binding: { ...activeReceipt.binding, accessMode: 'password_required' } }, 201); }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    await screen.findByText('Working copy');
    expect(screen.queryByLabelText('Deployed shared password')).toBeNull();
    fireEvent.click(screen.getByLabelText('Shared password', { selector: 'input[type="radio"]' }));
    fireEvent.change(screen.getByLabelText('MCP grant'), { target: { value: 'grant-deployer' } });
    fireEvent.change(screen.getByLabelText('Deployed shared password'), { target: { value: 'short' } });
    expect((screen.getByRole('button', { name: 'Review deployment' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Deployed shared password'), { target: { value: 'long-enough' } });
    expect((screen.getByRole('button', { name: 'Review deployment' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Review deployment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deploy exact revision' }));
    await waitFor(() => expect(deployBody).toMatchObject({ accessMode: 'password_required', password: 'long-enough', mcpGrantId: 'grant-deployer' }));
  });

  it('loads durable binding, health, newest-first history, and safe remote instructions', async () => {
    const older = { ...activeReceipt, receiptId: 'receipt-old', status: 'rolled_back' as const, createdAt: '2026-09-11T10:00:00Z' };
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/foldy-access/status')) return response({ enabled: false, authenticated: true });
      if (url.endsWith('/publication')) return response(publication);
      if (url.includes('/cynder/status')) return response({ projectId: 'project-1', environment: 'production', binding: activeReceipt.binding, completed: [older, activeReceipt], staged: [], remoteMcpInstallInfo: remoteInstallInfo });
      if (url.includes('/mcp/grants?')) return response({ grants: [deployerGrant] });
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    expect((await screen.findByRole('link', { name: 'Open live Foldy' })).getAttribute('href')).toBe('https://foldy.example/live');
    expect(screen.getByText('artifact · Healthy · HTTP 200')).not.toBeNull();
    const history = screen.getByRole('list', { name: 'Durable deployment receipt history' });
    expect(history.children[0]?.textContent).toContain('receipt-active');
    expect(screen.getByText('List the project without changing it.')).not.toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Generic' }));
    expect(screen.getByRole('tabpanel').textContent).toContain('OD_FOLDY_MCP_TOKEN');
    expect(screen.getByRole('dialog').textContent).not.toMatch(/passwordScryptVerifier|tokenSha256|digest/i);
  });

  it('recovers a staged durable receipt then refreshes status', async () => {
    const staged = { ...activeReceipt, receiptId: 'receipt-staged', status: 'staged' as const, recoverable: true, binding: null, completedAt: null };
    let statusReads = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes('/foldy-access/status')) return response({ enabled: false, authenticated: true });
      if (url.endsWith('/publication')) return response(publication);
      if (url.includes('/mcp/grants?')) return response({ grants: [deployerGrant] });
      if (url.includes('/cynder/status')) { statusReads += 1; return response(statusReads === 1 ? { ...emptyStatus, staged: [staged] } : { ...emptyStatus, completed: [{ ...staged, status: 'failed' }] }); }
      if (url.endsWith('/cynder/recover') && init?.method === 'POST') return response({ ...staged, status: 'failed' });
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Recover receipt-staged' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/cynder/recover', expect.objectContaining({ body: JSON.stringify({ environment: 'production', receiptId: 'receipt-staged' }) })));
    expect(statusReads).toBeGreaterThan(1);
  });

  it('excludes deployer-only grants because deployment needs both read and deployer scopes', async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/foldy-access/status')) return response({ enabled: false, authenticated: true });
      if (url.endsWith('/publication')) return response(publication);
      if (url.includes('/cynder/status')) return response(emptyStatus);
      if (url.includes('/mcp/grants?')) return response({ grants: [{ ...deployerGrant, grantId: 'deployer-only', scopes: ['deployer'] }] });
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    await screen.findByText('Working copy');
    expect(screen.queryByRole('option', { name: /deployer-only/ })).toBeNull();
    expect(screen.getByText(/read is required to serve the deployed MCP project context/i)).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Review deployment' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('rolls back durable history despite an unapproved latest revision and no current grant', async () => {
    const unapprovedPublication = { ...publication, reviews: [] };
    const historical = { ...activeReceipt, receiptId: 'receipt-history', revisionId: 'rev-1', status: 'rolled_back' as const, binding: { ...activeReceipt.binding, revisionId: 'rev-1', providerRevisionId: 'provider-rev-1' } };
    let rollbackBody: Record<string, unknown> | null = null;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes('/foldy-access/status')) return response({ enabled: false, authenticated: true });
      if (url.endsWith('/publication')) return response(unapprovedPublication);
      if (url.includes('/mcp/grants?')) return response({ grants: [] });
      if (url.includes('/cynder/status')) return response({ ...emptyStatus, binding: activeReceipt.binding, completed: [activeReceipt, historical] });
      if (url.includes('/revisions/rev-1/cynder/rollback') && init?.method === 'POST') {
        rollbackBody = JSON.parse(String(init.body));
        return response({ ...historical, kind: 'rollback', status: 'active' });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    const rollback = await screen.findByRole('button', { name: 'Rollback rev-1 on production' });
    expect((rollback as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(rollback);
    await waitFor(() => expect(rollbackBody).toEqual({
      environment: 'production',
      expectedActiveProviderRevisionId: 'provider-rev-2',
      idempotencyKey: expect.stringMatching(/^rollback-rev-1-/),
    }));
  });

  it('offers Recover only for explicitly recoverable receipts and labels terminal failures', async () => {
    const failed = { ...activeReceipt, receiptId: 'receipt-failed', status: 'failed' as const, recoverable: false, binding: null };
    const rollbackFailed = { ...failed, receiptId: 'receipt-rollback-failed', status: 'rollback_failed' as const };
    const staged = { ...failed, receiptId: 'receipt-staged', status: 'staged' as const, recoverable: true };
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/foldy-access/status')) return response({ enabled: false, authenticated: true });
      if (url.endsWith('/publication')) return response(publication);
      if (url.includes('/mcp/grants?')) return response({ grants: [] });
      if (url.includes('/cynder/status')) return response({ ...emptyStatus, completed: [failed, rollbackFailed], staged: [staged] });
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    expect(await screen.findByRole('button', { name: 'Recover receipt-staged' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Recover receipt-failed' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recover receipt-rollback-failed' })).toBeNull();
    expect(screen.getByText(/^deploy · failed · terminal$/i)).not.toBeNull();
    expect(screen.getByText(/^deploy · rollback failed · terminal$/i)).not.toBeNull();
  });

  it.each(['success', 'error'] as const)('clears password and reviewed state after deploy %s', async (outcome) => {
    const password = 'sensitive-password-value';
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes('/foldy-access/status')) return response({ enabled: false, authenticated: true });
      if (url.endsWith('/publication')) return response(publication);
      if (url.includes('/cynder/status')) return response(emptyStatus);
      if (url.includes('/mcp/grants?')) return response({ grants: [deployerGrant] });
      if (url.includes('/cynder/deploy') && init?.method === 'POST') return outcome === 'success' ? response(activeReceipt, 201) : response({ error: { message: 'deployment rejected' } }, 400);
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    await screen.findByText('Working copy');
    fireEvent.click(screen.getByLabelText('Shared password', { selector: 'input[type="radio"]' }));
    fireEvent.change(screen.getByLabelText('MCP grant'), { target: { value: 'grant-deployer' } });
    fireEvent.change(screen.getByLabelText('Deployed shared password'), { target: { value: password } });
    fireEvent.click(screen.getByRole('button', { name: 'Review deployment' }));
    expect(screen.getByRole('dialog').textContent).not.toContain(password);
    fireEvent.click(screen.getByRole('button', { name: 'Deploy exact revision' }));
    await screen.findByText(outcome === 'success' ? /Action completed/ : /deployment rejected/);
    expect((screen.getByLabelText('Deployed shared password') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('heading', { name: 'Deployment review' })).toBeNull();
    expect(screen.getByRole('dialog').textContent).not.toContain(password);
  });

  it('discards password and review state on close and contains no obsolete deployment copy', async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/foldy-access/status')) return response({ enabled: false, authenticated: true });
      if (url.endsWith('/publication')) return response(publication);
      if (url.includes('/cynder/status')) return response(emptyStatus);
      if (url.includes('/mcp/grants?')) return response({ grants: [deployerGrant] });
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    await screen.findByText('Working copy');
    expect(screen.queryByText(/session receipts/i)).toBeNull();
    expect(screen.queryByText(/deployment receipts from this session/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run preflight' })).toBeNull();
    fireEvent.click(screen.getByLabelText('Shared password', { selector: 'input[type="radio"]' }));
    fireEvent.change(screen.getByLabelText('MCP grant'), { target: { value: 'grant-deployer' } });
    fireEvent.change(screen.getByLabelText('Deployed shared password'), { target: { value: 'sensitive-password-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review deployment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close Foldy runtime' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Foldy runtime' }));
    await screen.findByText('Working copy');
    expect(screen.queryByLabelText('Deployed shared password')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Deployment review' })).toBeNull();
    expect(screen.getByRole('dialog').textContent).not.toContain('sensitive-password-value');
  });

  it('removes stale remote instructions as soon as the environment changes', async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/foldy-access/status')) return response({ enabled: false, authenticated: true });
      if (url.endsWith('/publication')) return response(publication);
      if (url.includes('/mcp/grants?')) return response({ grants: [deployerGrant] });
      if (url.includes('environment=production')) return response({ ...emptyStatus, binding: activeReceipt.binding, completed: [activeReceipt], remoteMcpInstallInfo: remoteInstallInfo });
      if (url.includes('environment=staging')) return response({ ...emptyStatus, environment: 'staging' });
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);
    expect(await screen.findByText('List the project without changing it.')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Environment'), { target: { value: 'staging' } });
    expect(screen.queryByText('List the project without changing it.')).toBeNull();
    await screen.findByText('No active deployment binding for this environment.');
    expect(screen.queryByText('List the project without changing it.')).toBeNull();
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
      if (url.includes('/cynder/status')) return response(emptyStatus);
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
