export type FoldyRuntimeScope = 'read' | 'editor' | 'reviewer' | 'publisher' | 'deployer';

export interface FoldyMcpGrant {
  grantId: string;
  projectId: string;
  scopes: FoldyRuntimeScope[];
  createdAt: string;
  revokedAt: string | null;
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
