export type FoldyRuntimeScope = 'read' | 'editor' | 'reviewer' | 'publisher' | 'deployer';

export type FoldyDeploymentAccessMode = 'public' | 'password_required';

export type FoldyDeploymentAccessPolicy =
  | { mode: 'public' }
  | { mode: 'password_required'; passwordScryptVerifier: string };

/** Secret-free descriptor passed to a deployment provider. Raw MCP tokens never cross this boundary. */
export interface FoldyDeploymentMcpGrantDescriptor {
  grantId: string;
  scopes: readonly FoldyRuntimeScope[];
  tokenSha256: string;
}

export interface DeployFoldyRevisionRequest {
  environment: string;
  idempotencyKey: string;
  expectedActiveProviderRevisionId: string | null;
  accessMode?: FoldyDeploymentAccessMode;
  password?: string;
  mcpGrantId: string;
}

export interface RollbackFoldyRevisionRequest {
  environment: string;
  idempotencyKey: string;
  expectedActiveProviderRevisionId: string | null;
}

export interface FoldyDeploymentBinding {
  providerDeploymentId: string;
  providerRevisionId: string;
  projectId: string;
  revisionId: string;
  bundleSha256: string;
  environment: string;
  url: string;
  mcpUrl: string;
  accessMode: FoldyDeploymentAccessMode;
}

export interface FoldyRemoteMcpInstallInfo {
  server: {
    label: string;
    transport: 'streamable-http';
    url: string;
  };
  tokenHandling: {
    env: 'OD_FOLDY_MCP_TOKEN';
    authorizationScheme: 'Bearer';
    note: string;
  };
  clients: {
    gpt: {
      supported: true;
      target: 'openai-responses-api';
      tool: {
        type: 'mcp';
        server_label: string;
        server_url: string;
        require_approval: 'always';
        /** Instruction metadata: the copy-ready JavaScript resolves this field at runtime. */
        authorization: {
          source: 'environment';
          env: 'OD_FOLDY_MCP_TOKEN';
        };
      };
      javascript: string;
    };
    claudeCode: {
      configFile: '.mcp.json';
      mcpServers: Record<string, {
        type: 'http';
        url: string;
        headers: { Authorization: 'Bearer ${OD_FOLDY_MCP_TOKEN}' };
      }>;
    };
    claudeDesktop: {
      bridge: 'mcp-remote';
      version: '0.14.0';
      note: string;
      posix: {
        mcpServers: Record<string, {
          command: 'sh';
          args: ['-lc', string];
          env: { OD_FOLDY_MCP_URL: string };
        }>;
      };
      windows: {
        mcpServers: Record<string, {
          command: 'cmd';
          args: ['/d', '/s', '/c', string];
          env: { OD_FOLDY_MCP_URL: string };
        }>;
      };
    };
    generic: {
      label: string;
      transport: 'streamable-http';
      url: string;
      authorization: { type: 'bearer'; tokenEnv: 'OD_FOLDY_MCP_TOKEN' };
    };
  };
  safeTestPrompt: string;
}

/** Public, redacted deployment receipt. Provider custody fields are intentionally absent. */
export interface FoldyCynderDeploymentReceipt {
  schemaVersion: 1 | 2;
  receiptId: string;
  kind: 'deploy' | 'rollback';
  status: 'staged' | 'active' | 'rolled_back' | 'failed' | 'rollback_failed';
  /** True only for a durable v2 staged attempt which the recovery service may resume. */
  recoverable: boolean;
  projectId: string;
  revisionId: string;
  bundleSha256: string;
  environment: string;
  idempotencyKey: string;
  /** Null for legacy receipts which predate durable provisioning descriptors. */
  accessMode: FoldyDeploymentAccessMode | null;
  /** Null for legacy receipts which predate durable provisioning descriptors. */
  mcpGrantId: string | null;
  scopes: readonly FoldyRuntimeScope[];
  expectedActiveProviderRevisionId: string | null;
  priorActive: FoldyDeploymentBinding | null;
  binding: FoldyDeploymentBinding | null;
  health: { checks: { name: string; ok: boolean; status?: number }[] } | null;
  createdAt: string;
  completedAt: string | null;
  errorCode?: string;
  rollbackError?: string;
}

export type FoldyCynderDeploymentResponse = FoldyCynderDeploymentReceipt & {
  /** Present only when the receipt has a deployed remote MCP binding. */
  remoteMcpInstallInfo?: FoldyRemoteMcpInstallInfo;
};

export interface RecoverFoldyCynderDeploymentRequest {
  environment: string;
  receiptId?: string;
}

export interface FoldyCynderStatusResponse {
  projectId: string;
  environment: string;
  binding: FoldyDeploymentBinding | null;
  completed: readonly FoldyCynderDeploymentResponse[];
  staged: readonly FoldyCynderDeploymentResponse[];
  /** Present only when an active binding can be tied to its durable deployment receipt. */
  remoteMcpInstallInfo?: FoldyRemoteMcpInstallInfo;
}

export type RecoverFoldyCynderDeploymentResponse = FoldyCynderDeploymentResponse;

export interface FoldyMcpGrant {
  grantId: string;
  projectId: string;
  scopes: FoldyRuntimeScope[];
  createdAt: string;
  revokedAt: string | null;
  /** Local denial is immediate; pending means provider revocation still needs reconciliation. */
  revocationStatus: 'pending' | 'complete' | null;
}

export interface RevokeFoldyMcpGrantResponse {
  grant: FoldyMcpGrant;
}

/** Only the create response includes `token`; list/get responses use FoldyMcpGrant. */
export interface CreateFoldyMcpGrantResponse {
  grant: FoldyMcpGrant;
  token: string;
  installInfo: FoldyMcpInstallInfo;
}

export interface FoldyMcpInstallInfo {
  tokenHandling: {
    env: 'OD_FOLDY_MCP_TOKEN';
    /** Display-only guidance; executable client configuration must not contain this value. */
    displayPlaceholder: '<FOLDY_MCP_TOKEN_SECRET_REF>';
    note: string;
  };
  clients: Record<'gpt' | 'claudeDesktop' | 'claudeCode' | 'generic', unknown>;
  safeTestPrompt: string;
  revoke: { method: 'DELETE'; path: string; note: string };
}

export type FoldyReviewDecision = 'approved' | 'changes_requested';
export type FoldyReviewStatus = 'requested' | FoldyReviewDecision | 'stale';

export interface SaveFoldyRevisionRequest {
  entryFile: string;
  expectedLatestRevisionId: string | null;
}

export interface RequestFoldyReviewRequest {
  expectedLatestRevisionId: string;
}

export interface AddFoldyReviewCommentRequest {
  body: string;
  expectedReviewVersion: number;
}

export interface DecideFoldyReviewRequest {
  decision: FoldyReviewDecision;
  expectedReviewVersion: number;
}

export interface PublishFoldyRevisionRequest {
  revisionId: string;
  expectedPublishedGeneration: number;
}

export interface RollbackFoldyPublicationRequest {
  targetRevisionId: string;
  expectedPublishedGeneration: number;
}

export interface FoldyRevisionFile {
  path: string;
  sha256: string;
  size: number;
}

export interface FoldyRevisionSummary {
  revisionId: string;
  entryFile: string;
  createdAt: string;
  createdBy: string;
  fileCount: number;
  byteCount: number;
  bundleSha256: string;
}

export interface FoldyRevisionRecord extends FoldyRevisionSummary {
  files: readonly FoldyRevisionFile[];
}

export interface FoldyReviewComment {
  commentId: string;
  reviewId: string;
  revisionId: string;
  body: string;
  createdAt: string;
  createdBy: string;
}

export interface FoldyReviewRecord {
  reviewId: string;
  revisionId: string;
  status: FoldyReviewStatus;
  version: number;
  requestedAt: string;
  requestedBy: string;
  comments: readonly FoldyReviewComment[];
  decidedAt: string | null;
  decidedBy: string | null;
  staleAt: string | null;
  staleBecauseRevisionId: string | null;
}

export interface FoldyPublishedRevision {
  revisionId: string;
  generation: number;
  publishedAt: string;
  publishedBy: string;
  transitionId: string;
  kind: 'publish' | 'rollback';
  previousRevisionId: string | null;
}

export interface FoldyPublicationTransition extends FoldyPublishedRevision {}

export interface FoldyPublicationStatus {
  latestRevisionId: string | null;
  publishedRevisionId: string | null;
  publishedGeneration: number;
  revisions: readonly FoldyRevisionSummary[];
  activeReview: FoldyReviewRecord | null;
}

export interface FoldyPublicationProjectState extends FoldyPublicationStatus {
  schemaVersion: 1;
  projectId: string;
  reviews: readonly FoldyReviewRecord[];
  transitions: readonly FoldyPublicationTransition[];
}
