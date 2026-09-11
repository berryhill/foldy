import type {
  CreateFoldyMcpGrantResponse,
  CynderDeploymentReceipt,
  FoldyBrowserAccessStatus,
  FoldyMcpGrant,
  FoldyMcpInstallInfo,
  FoldyPublicationProjectState,
  FoldyReviewDecision,
  FoldyRuntimeScope,
} from './types';

export class FoldyApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'FoldyApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: init?.body === undefined
      ? init?.headers
      : { 'content-type': 'application/json', ...init.headers },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new FoldyApiError(
      response.status,
      payload?.error?.code ?? 'FOLDY_REQUEST_FAILED',
      payload?.error?.message ?? `Foldy request failed (${response.status})`,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const projectBase = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;
const revisionBase = (projectId: string, revisionId: string) =>
  `${projectBase(projectId)}/revisions/${encodeURIComponent(revisionId)}`;

export const foldyApi = {
  publication(projectId: string) {
    return request<FoldyPublicationProjectState>(`${projectBase(projectId)}/publication`);
  },
  saveRevision(projectId: string, input: { entryFile: string; expectedLatestRevisionId: string | null }) {
    return request(`${projectBase(projectId)}/revisions`, { method: 'POST', body: JSON.stringify(input) });
  },
  requestReview(projectId: string, revisionId: string, expectedLatestRevisionId: string) {
    return request(`${revisionBase(projectId, revisionId)}/review`, {
      method: 'POST', body: JSON.stringify({ expectedLatestRevisionId }),
    });
  },
  addComment(projectId: string, revisionId: string, reviewId: string, input: { body: string; expectedReviewVersion: number }) {
    return request(`${revisionBase(projectId, revisionId)}/reviews/${encodeURIComponent(reviewId)}/comments`, {
      method: 'POST', body: JSON.stringify(input),
    });
  },
  decideReview(projectId: string, revisionId: string, reviewId: string, decision: FoldyReviewDecision, expectedReviewVersion: number) {
    return request(`${revisionBase(projectId, revisionId)}/reviews/${encodeURIComponent(reviewId)}/decision`, {
      method: 'POST', body: JSON.stringify({ decision, expectedReviewVersion }),
    });
  },
  publish(projectId: string, revisionId: string, expectedPublishedGeneration: number) {
    return request(`${projectBase(projectId)}/publication/publish`, {
      method: 'POST', body: JSON.stringify({ revisionId, expectedPublishedGeneration }),
    });
  },
  restore(projectId: string, targetRevisionId: string, expectedPublishedGeneration: number) {
    return request(`${projectBase(projectId)}/publication/rollback`, {
      method: 'POST', body: JSON.stringify({ targetRevisionId, expectedPublishedGeneration }),
    });
  },
  grants(projectId: string) {
    return request<{ grants: FoldyMcpGrant[] }>(`/api/foldy/mcp/grants?projectId=${encodeURIComponent(projectId)}`);
  },
  createGrant(projectId: string, scopes: FoldyRuntimeScope[]) {
    return request<CreateFoldyMcpGrantResponse>('/api/foldy/mcp/grants', {
      method: 'POST', body: JSON.stringify({ projectId, scopes }),
    });
  },
  revokeGrant(grantId: string) {
    return request<{ grant: FoldyMcpGrant }>(`/api/foldy/mcp/grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' });
  },
  installInfo(grantId: string) {
    return request<FoldyMcpInstallInfo>(`/api/foldy/mcp/grants/${encodeURIComponent(grantId)}/install`);
  },
  accessStatus() {
    return request<FoldyBrowserAccessStatus>('/api/foldy-access/status');
  },
  unlock(password: string) {
    return request<void>('/api/foldy-access/unlock', { method: 'POST', body: JSON.stringify({ password }) });
  },
  setPassword(password: string) {
    return request<void>('/api/foldy-access/password', { method: 'PUT', body: JSON.stringify({ password }) });
  },
  disablePassword() {
    return request<void>('/api/foldy-access/password', { method: 'DELETE' });
  },
  logout() {
    return request<void>('/api/foldy-access/logout', { method: 'POST' });
  },
  cynder(projectId: string, revisionId: string, kind: 'deploy' | 'rollback', input: {
    environment: string;
    idempotencyKey: string;
    expectedActiveProviderRevisionId: string | null;
  }) {
    return request<CynderDeploymentReceipt>(`${revisionBase(projectId, revisionId)}/cynder/${kind}`, {
      method: 'POST', body: JSON.stringify(input),
    });
  },
};
