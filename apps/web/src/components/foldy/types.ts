import type {
  CreateFoldyMcpGrantResponse,
  DeployFoldyRevisionRequest,
  FoldyCynderDeploymentResponse,
  FoldyCynderStatusResponse,
  FoldyDeploymentAccessMode,
  FoldyDeploymentBinding,
  FoldyMcpGrant,
  FoldyMcpInstallInfo,
  FoldyPublicationProjectState,
  FoldyRemoteMcpInstallInfo,
  FoldyReviewDecision,
  FoldyRuntimeScope,
  RecoverFoldyCynderDeploymentRequest,
  RecoverFoldyCynderDeploymentResponse,
  RevokeFoldyMcpGrantResponse,
  RollbackFoldyRevisionRequest,
} from '@open-design/contracts';

export type {
  CreateFoldyMcpGrantResponse,
  DeployFoldyRevisionRequest,
  FoldyCynderDeploymentResponse,
  FoldyCynderStatusResponse,
  FoldyDeploymentAccessMode,
  FoldyDeploymentBinding,
  FoldyMcpGrant,
  FoldyMcpInstallInfo,
  FoldyPublicationProjectState,
  FoldyRemoteMcpInstallInfo,
  FoldyReviewDecision,
  FoldyRuntimeScope,
  RecoverFoldyCynderDeploymentRequest,
  RecoverFoldyCynderDeploymentResponse,
  RevokeFoldyMcpGrantResponse,
  RollbackFoldyRevisionRequest,
};

export interface FoldyBrowserAccessStatus {
  enabled: boolean;
  authenticated: boolean;
}

export type CynderDeploymentBinding = FoldyDeploymentBinding;
export type CynderDeploymentReceipt = FoldyCynderDeploymentResponse;
