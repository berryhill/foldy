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
});
