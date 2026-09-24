export interface NativeCynderBudget { budgetId: string; perActionCap: number; totalCap: number }
export interface NativeCynderQuote {
  quoteId: string; actionId: string; amountAtomic: number;
  network: string; asset: string; payee: string;
  budgetId: string; totalCapAtomic: number;
}
export interface NativeCynderReview {
  operationId: string; requestDigest: string; reviewedStateDigest: string;
  actionId?: string; actionDigest?: string; quote?: NativeCynderQuote;
  phase: 'preparing' | 'prepared' | 'quoted' | 'execution_unknown' | 'observed';
  observation?: NativeCynderObservation;
}
export interface NativeCynderObservation {
  actionId: string; status: string; paymentStatus: string;
  /** Payment/receipt evidence is not deployment health or activation proof. */
  settledEvidence: boolean;
}
export interface NativeCynderDeployment {
  deploymentId: string; deployActionId: string; status: string; deleted: boolean; deletePending: boolean;
  activeVersionId?: string; activeActivationId?: string;
}
export interface NativeCynderVersion {
  deploymentId: string; versionId: string; actionId: string; imageDigest: string; createdAt: string; tupleDigest?: string;
}
/** v1 application contract, NOT a provider endpoint or a claim of MVI activation. */
export interface FoldyReleaseIdentity {
  instanceId: string; projectId: string; workbookId: string; revisionId: string;
  releaseBundleDigest: string; imageDigest: string;
}
export interface NativeDeploymentRequest {
  schemaVersion: 'foldy-native-deployment.v1'; release: FoldyReleaseIdentity;
  idempotencyKey: string; hostingAdmissionRef: string; budget: NativeCynderBudget;
}
export interface NativeDeploymentApproval {
  operationId: string; reviewedStateDigest: string; requestDigest: string; approvedQuote: NativeCynderQuote;
}
export interface NativeDeploymentResponse {
  schemaVersion: 'foldy-native-deployment-result.v1'; operationId: string;
  release: FoldyReleaseIdentity;
  state: 'preparing' | 'quoted' | 'execution_unknown' | 'observed' | 'deployment_observed';
  review?: NativeCynderReview; originalDeployActionId?: string;
  deployment?: NativeCynderDeployment;
  /** Owner readback is not Foldy claim/readiness/CAS activation proof. */
  foldyActivation: 'not_verified';
}

export interface NativeDeploymentExecuteRequest { approvalReceipt: string; csrf: string }
export interface NativeDeploymentPrepareResponse { result: NativeDeploymentResponse; approvalReceipt?: string; csrf?: string; expiresAt?: number }
