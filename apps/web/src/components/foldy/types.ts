import type {
  CreateFoldyMcpGrantResponse,
  FoldyMcpGrant,
  FoldyMcpInstallInfo,
  FoldyPublicationProjectState,
  FoldyReviewDecision,
  FoldyRuntimeScope,
} from '@open-design/contracts';

export type {
  CreateFoldyMcpGrantResponse,
  FoldyMcpGrant,
  FoldyMcpInstallInfo,
  FoldyPublicationProjectState,
  FoldyReviewDecision,
  FoldyRuntimeScope,
};

export interface FoldyBrowserAccessStatus {
  enabled: boolean;
  authenticated: boolean;
}

export interface CynderDeploymentBinding {
  providerDeploymentId: string;
  providerRevisionId: string;
  projectId: string;
  revisionId: string;
  bundleSha256: string;
  environment: string;
  url: string;
}

export interface CynderDeploymentReceipt {
  schemaVersion: 1;
  receiptId: string;
  kind: 'deploy' | 'rollback';
  status: 'staged' | 'active' | 'rolled_back' | 'failed' | 'rollback_failed';
  projectId: string;
  revisionId: string;
  bundleSha256: string;
  environment: string;
  idempotencyKey: string;
  expectedActiveProviderRevisionId: string | null;
  priorActive: CynderDeploymentBinding | null;
  binding: CynderDeploymentBinding | null;
  health: { checks: { name: string; ok: boolean; status?: number }[] } | null;
  createdAt: string;
  completedAt: string | null;
  errorCode?: string;
  rollbackError?: string;
}
