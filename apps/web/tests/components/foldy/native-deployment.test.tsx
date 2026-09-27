// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FoldyRuntimePanel } from '../../../src/components/foldy/FoldyRuntimePanel';

const hex = 'a'.repeat(64);
const release = { instanceId: 'instance-1', projectId: 'project-1', workbookId: 'book-1', revisionId: 'rev-1', releaseBundleDigest: `sha256:${hex}`, imageDigest: `registry.example/foldy@sha256:${hex}` };
const request = { schemaVersion: 'foldy-native-deployment.v1', release, idempotencyKey: 'operator-1', hostingAdmissionRef: 'admission-1', budget: { budgetId: 'budget-1', perActionCap: 100, totalCap: 500 } };
const quote = { quoteId: 'quote-1', actionId: 'act-1', amountAtomic: 50, network: 'eip155:8453', asset: 'USDC', payee: '0xrecipient', budgetId: 'budget-1', totalCapAtomic: 500 };
const result = { schemaVersion: 'foldy-native-deployment-result.v1', operationId: hex, release, state: 'quoted', foldyActivation: 'not_verified', review: { operationId: hex, requestDigest: hex, reviewedStateDigest: hex, phase: 'quoted', quote } };
const publication = { schemaVersion: 1, projectId: 'project-1', latestRevisionId: null, publishedRevisionId: null, publishedGeneration: 0, revisions: [], reviews: [], activeReview: null, transitions: [] };
const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
let available = false;
let prepareCount = 0;
let executeCount = 0;
let inspectCount = 0;
let reconcileCount = 0;
beforeEach(() => {
  available = false; prepareCount = 0; executeCount = 0; inspectCount = 0; reconcileCount = 0;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/foldy-access/status')) return reply({ enabled: false, authenticated: true });
    if (url.endsWith('/publication')) return reply(publication);
    if (url.includes('/mcp/grants?')) return reply({ grants: [] });
    if (url.endsWith('/native-deployments/availability')) return reply({ available });
    if (url.endsWith('/native-deployments/prepare')) { prepareCount++; return reply({ result, approvalReceipt: 'server-receipt', csrf: 'server-csrf', expiresAt: Date.now() + 300000 }); }
    if (url.endsWith('/native-deployments/execute')) { executeCount++; return reply({ ...result, state: 'execution_unknown' }); }
    if (url.endsWith(`/native-deployments/${hex}`)) { inspectCount++; return reply({ ...result, state: 'execution_unknown' }); }
    if (url.endsWith(`/native-deployments/${hex}/reconcile`)) { reconcileCount++; return reply({ ...result, state: 'observed', review: { ...result.review, observation: { actionId: quote.actionId, status: 'SUCCEEDED', paymentStatus: 'SETTLED', settledEvidence: true } } }); }
    throw new Error(`Unexpected request ${url} ${init?.method}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = () => render(<FoldyRuntimePanel projectId="project-1" entryFile="index.html" defaultOpen />);

describe('native Foldy operator deployment', () => {
  it('gates unavailable service without exposing legacy deploy or accepting a paid action', async () => {
    mount();
    expect(await screen.findByText(/Native hosting is unavailable on this daemon/)).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Deploy exact revision|Approve quoted payment/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Deploy to Cynder' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save revision' })).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Connect an assistant' })).not.toBeNull();
    expect(prepareCount + executeCount).toBe(0);
  });
  it('reviews provider quote and uses only server receipt and csrf to execute once', async () => {
    available = true; mount();
    const field = await screen.findByLabelText('Native deployment request (non-secret JSON)');
    fireEvent.change(field, { target: { value: JSON.stringify(request) } });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare and review quote' }));
    await screen.findByRole('heading', { name: 'Server-bound quote review' });
    expect(screen.getByText(/does not establish hosting lease expiry/)).not.toBeNull();
    expect(prepareCount).toBe(1);
    const execute = screen.getByRole('button', { name: 'Approve quoted payment and execute once' }) as HTMLButtonElement;
    expect(execute.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I reviewed the admitted hosting contract/));
    expect(execute.disabled).toBe(false);
    fireEvent.click(execute);
    await waitFor(() => expect(executeCount).toBe(1));
    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/native-deployments/execute'))!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ approvalReceipt: 'server-receipt', csrf: 'server-csrf' });
    expect(screen.queryByRole('button', { name: 'Approve quoted payment and execute once' })).toBeNull();
    expect(screen.getByText('Not verified')).not.toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/cynder/deploy'))).toBe(false);
  });
  it('invalidates approval on request edit and exposes same-operation inspect/reconcile parity with CLI', async () => {
    available = true; mount();
    const field = await screen.findByLabelText('Native deployment request (non-secret JSON)');
    fireEvent.change(field, { target: { value: JSON.stringify(request) } });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare and review quote' }));
    await screen.findByRole('heading', { name: 'Server-bound quote review' });
    fireEvent.change(field, { target: { value: JSON.stringify({ ...request, idempotencyKey: 'other' }) } });
    expect(screen.queryByRole('button', { name: 'Approve quoted payment and execute once' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Operation ID'), { target: { value: hex } });
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    await waitFor(() => expect(inspectCount).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile same operation' }));
    await waitFor(() => expect(reconcileCount).toBe(1));
    expect(screen.getByText(/SUCCEEDED · SETTLED/)).not.toBeNull();
    expect(executeCount).toBe(0);
  });
});
