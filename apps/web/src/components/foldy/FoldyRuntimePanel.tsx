'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { foldyApi, FoldyApiError } from './api';
import type {
  CreateFoldyMcpGrantResponse,
  FoldyCynderStatusResponse,
  FoldyDeploymentAccessMode,
  FoldyBrowserAccessStatus,
  FoldyMcpGrant,
  FoldyMcpInstallInfo,
  FoldyPublicationProjectState,
  FoldyRemoteMcpInstallInfo,
  FoldyReviewDecision,
  FoldyRuntimeScope,
} from './types';

export interface FoldyRuntimePanelProps {
  projectId: string;
  entryFile: string;
  defaultOpen?: boolean;
}

export function FoldyRuntimeMount({ projectId, metadata }: { projectId: string; metadata: unknown }) {
  if (!isFoldyProjectMetadata(metadata)) return null;
  return <FoldyRuntimePanel projectId={projectId} entryFile={metadata.entryFile} />;
}

export function isFoldyProjectMetadata(metadata: unknown): metadata is { foldy: true; entryFile: string } {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const value = metadata as Record<string, unknown>;
  return value.foldy === true && typeof value.entryFile === 'string' && value.entryFile.length > 0;
}

function isApprovedRevision(
  state: FoldyPublicationProjectState,
  revisionId: string | null,
): boolean {
  if (!revisionId) return false;
  return state.reviews.some(
    (review) => review.revisionId === revisionId && review.status === 'approved',
  );
}

export function createDeploymentReviewKey(input: {
  revision: string | null;
  environment: string;
  expected: string | null;
  accessMode: FoldyDeploymentAccessMode;
  mcpGrantId: string;
  formRevision: number;
}): string {
  return JSON.stringify(input);
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return <div className="foldy-detail"><dt>{label}</dt><dd>{children}</dd></div>;
}

function Context({ revision, cas }: { revision: string | null; cas: string }) {
  return <div className="foldy-cas" aria-label="Action concurrency state">
    <span>Exact revision: <code>{revision ?? 'None'}</code></span><span>{cas}</span>
  </div>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="foldy-empty">{children}</p>;
}

interface ActionContext {
  busy: string | null;
  act(name: string, task: () => Promise<unknown>, refresh: () => Promise<void>): Promise<boolean>;
}

function PublicationPanel({ projectId, entryFile, state, refresh, actions }: {
  projectId: string;
  entryFile: string;
  state: FoldyPublicationProjectState;
  refresh: () => Promise<void>;
  actions: ActionContext;
}) {
  const latest = state.latestRevisionId;
  const approved = isApprovedRevision(state, latest);
  return <section className="foldy-card" aria-labelledby="foldy-publication-title">
    <div className="foldy-card-heading"><div><p className="foldy-eyebrow">Publication</p><h3 id="foldy-publication-title">Publish update</h3></div><button type="button" className="foldy-button subtle" onClick={() => void refresh()}>Refresh</button></div>
    <dl className="foldy-state-grid">
      <Detail label="Working copy"><code>{entryFile}</code></Detail>
      <Detail label="Saved revision"><code>{latest ?? 'None'}</code></Detail>
      <Detail label="Current revision"><code>{state.publishedRevisionId ?? 'None'}</code></Detail>
      <Detail label="Status">{latest === state.publishedRevisionId ? 'Published' : 'Changes'}</Detail>
    </dl>
    <Context revision={latest} cas={`Expected publication generation: ${state.publishedGeneration}`} />
    <div className="foldy-actions">
      <button type="button" className="foldy-button" disabled={actions.busy !== null} onClick={() => void actions.act('save', () => foldyApi.saveRevision(projectId, { entryFile, expectedLatestRevisionId: latest }), refresh)}>{actions.busy === 'save' ? 'Saving…' : 'Save revision'}</button>
      <button type="button" className="foldy-button primary" disabled={!latest || !approved || actions.busy !== null} onClick={() => latest && void actions.act('publish', () => foldyApi.publish(projectId, latest, state.publishedGeneration), refresh)}>{actions.busy === 'publish' ? 'Publishing…' : 'Publish update'}</button>
    </div>
    {!approved && latest ? <p className="foldy-hint">An approved review request for <code>{latest}</code> is required to publish.</p> : null}
    <div className="foldy-subsection"><h4>Revision history</h4>
      {state.revisions.length === 0 ? <Empty>No saved revisions yet.</Empty> : <ol className="foldy-list">{state.revisions.map((revision) => {
        const current = revision.revisionId === state.publishedRevisionId;
        return <li key={revision.revisionId}><div><strong><code>{revision.revisionId}</code></strong><span>{revision.fileCount} files · {revision.byteCount} bytes</span></div><div className="foldy-row-actions">{current ? <span className="foldy-badge">Current revision</span> : null}<button type="button" className="foldy-button small" disabled={current || actions.busy !== null} aria-label={`Restore ${revision.revisionId}`} onClick={() => void actions.act(`restore:${revision.revisionId}`, () => foldyApi.restore(projectId, revision.revisionId, state.publishedGeneration), refresh)}>Restore</button></div>{!current ? <small>Expected generation {state.publishedGeneration}</small> : null}</li>;
      })}</ol>}
    </div>
    {state.transitions.length ? <div className="foldy-subsection"><h4>Publication history</h4><ol className="foldy-list compact">{state.transitions.map((transition) => <li key={transition.transitionId}><span>{transition.kind === 'rollback' ? 'Restored' : 'Published'} <code>{transition.revisionId}</code></span><span>Generation {transition.generation}</span></li>)}</ol></div> : null}
  </section>;
}

function ReviewPanel({ projectId, state, refresh, actions }: { projectId: string; state: FoldyPublicationProjectState; refresh: () => Promise<void>; actions: ActionContext }) {
  const [comment, setComment] = useState('');
  const commentId = useId();
  const review = state.activeReview;
  const revision = state.latestRevisionId;
  const decide = (decision: FoldyReviewDecision) => review && void actions.act(`decision:${decision}`, () => foldyApi.decideReview(projectId, review.revisionId, review.reviewId, decision, review.version), refresh);
  return <section className="foldy-card" aria-labelledby="foldy-review-title">
    <p className="foldy-eyebrow">Review</p><h3 id="foldy-review-title">Review request</h3>
    <Context revision={review?.revisionId ?? revision} cas={review ? `Expected review version: ${review.version}` : `Expected latest revision: ${revision ?? 'None'}`} />
    {!review ? <div className="foldy-actions"><button type="button" className="foldy-button primary" disabled={!revision || actions.busy !== null} onClick={() => revision && void actions.act('review', () => foldyApi.requestReview(projectId, revision, revision), refresh)}>Request review</button></div> : <>
      <p className="foldy-status-line">Decision: <span className={`foldy-badge ${review.status}`}>{review.status.replace('_', ' ')}</span></p>
      {review.comments.length ? <ol className="foldy-comments">{review.comments.map((item) => <li key={item.commentId}><p>{item.body}</p><small>{item.createdBy}</small></li>)}</ol> : <Empty>No review comments yet.</Empty>}
      <form onSubmit={(event) => { event.preventDefault(); const body = comment.trim(); if (body) void actions.act('comment', () => foldyApi.addComment(projectId, review.revisionId, review.reviewId, { body, expectedReviewVersion: review.version }), refresh).then((ok) => { if (ok) setComment(''); }); }}><label htmlFor={commentId}>Add review comment</label><textarea id={commentId} value={comment} onChange={(event) => setComment(event.target.value)} rows={3} /><div className="foldy-actions"><button type="submit" className="foldy-button" disabled={!comment.trim() || actions.busy !== null}>Add comment</button></div></form>
      <div className="foldy-actions"><button type="button" className="foldy-button" disabled={actions.busy !== null || review.status !== 'requested'} onClick={() => decide('changes_requested')}>Request changes</button><button type="button" className="foldy-button primary" disabled={actions.busy !== null || review.status !== 'requested'} onClick={() => decide('approved')}>Approve exact revision</button></div>
    </>}
  </section>;
}

const scopes: FoldyRuntimeScope[] = ['read', 'editor', 'reviewer', 'publisher', 'deployer'];
type ClientName = 'gpt' | 'claudeDesktop' | 'claudeCode' | 'generic';
const clients: ClientName[] = ['gpt', 'claudeDesktop', 'claudeCode', 'generic'];
const clientLabels: Record<ClientName, string> = { gpt: 'GPT', claudeDesktop: 'Claude Desktop', claudeCode: 'Claude Code', generic: 'Generic' };

type InstallInstructionsInfo = FoldyMcpInstallInfo | FoldyRemoteMcpInstallInfo;
function InstallInstructions({ info, title = 'Client instructions' }: { info: InstallInstructionsInfo; title?: string }) {
  const [client, setClient] = useState<ClientName>('gpt');
  const tabsId = useId();
  const clientText = JSON.stringify(info.clients[client], null, 2);
  const selectClient = (name: ClientName, focus = false) => {
    setClient(name);
    if (focus) document.getElementById(`${tabsId}-tab-${name}`)?.focus();
  };
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, name: ClientName) => {
    const index = clients.indexOf(name);
    let next: ClientName | null = null;
    if (event.key === 'ArrowRight') next = clients[(index + 1) % clients.length]!;
    if (event.key === 'ArrowLeft') next = clients[(index - 1 + clients.length) % clients.length]!;
    if (event.key === 'Home') next = clients[0]!;
    if (event.key === 'End') next = clients.at(-1)!;
    if (next) { event.preventDefault(); selectClient(next, true); }
  };
  return <div className="foldy-subsection"><h4>{title}</h4><div className="foldy-tabs" role="tablist" aria-label="Assistant client">{clients.map((name) => <button id={`${tabsId}-tab-${name}`} type="button" role="tab" aria-selected={client === name} aria-controls={`${tabsId}-panel`} tabIndex={client === name ? 0 : -1} key={name} onClick={() => selectClient(name)} onKeyDown={(event) => onTabKeyDown(event, name)}>{clientLabels[name]}</button>)}</div><pre id={`${tabsId}-panel`} className="foldy-code" role="tabpanel" aria-labelledby={`${tabsId}-tab-${client}`} tabIndex={0}><code>{clientText}</code></pre><div className="foldy-actions"><button type="button" className="foldy-button small" onClick={() => void navigator.clipboard?.writeText(clientText)}>Copy instructions</button></div><p className="foldy-hint">Set <code>{info.tokenHandling.env}</code> in the client process environment; tokens are never embedded in these instructions.{'displayPlaceholder' in info.tokenHandling ? <> Display reference: <code>{info.tokenHandling.displayPlaceholder}</code>.</> : null}</p><p className="foldy-hint">Safe test prompt: <span>{info.safeTestPrompt}</span></p></div>;
}

function McpPanel({ projectId, revision, grants, issued, installInfo, refresh, setIssued, setInstallInfo, actions }: {
  projectId: string; revision: string | null; grants: FoldyMcpGrant[]; issued: CreateFoldyMcpGrantResponse | null; installInfo: FoldyMcpInstallInfo | null;
  refresh: () => Promise<void>; setIssued: (value: CreateFoldyMcpGrantResponse | null) => void; setInstallInfo: (value: FoldyMcpInstallInfo | null) => void; actions: ActionContext;
}) {
  const [selectedScopes, setSelectedScopes] = useState<FoldyRuntimeScope[]>(['read']);
  const activeInfo = issued?.installInfo ?? installInfo;
  const mint = () => actions.act('grant', async () => {
    const result = await foldyApi.createGrant(projectId, selectedScopes);
    setIssued(result);
    setInstallInfo(result.installInfo);
  }, refresh);
  return <section className="foldy-card" aria-labelledby="foldy-mcp-title">
    <p className="foldy-eyebrow">MCP access</p><h3 id="foldy-mcp-title">Connect an assistant</h3>
    <Context revision={revision} cas={`Grant is fixed to project: ${projectId}`} />
    <fieldset><legend>Allowed actions</legend><div className="foldy-checks">{scopes.map((scope) => <label key={scope}><input type="checkbox" checked={selectedScopes.includes(scope)} onChange={() => setSelectedScopes((current) => current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope])} /> {scope}</label>)}</div></fieldset>
    <div className="foldy-actions"><button type="button" className="foldy-button primary" disabled={!selectedScopes.length || actions.busy !== null} onClick={() => void mint()}>Create grant</button></div>
    {issued ? <div className="foldy-secret" role="status"><strong>Copy this token now. It is shown once.</strong><input aria-label="One-time MCP token" readOnly value={issued.token} /><div className="foldy-actions"><button type="button" className="foldy-button" onClick={() => void navigator.clipboard?.writeText(issued.token)}>Copy token</button><button type="button" className="foldy-button" onClick={() => setIssued(null)}>Dismiss token</button></div></div> : null}
    <div className="foldy-subsection"><h4>Grants</h4>{grants.length ? <ol className="foldy-list">{grants.map((grant) => {
      const pending = grant.revocationStatus === 'pending';
      const complete = grant.revocationStatus === 'complete';
      return <li key={grant.grantId}><div><code>{grant.grantId}</code><span>{grant.scopes.join(', ')}</span></div><div className="foldy-row-actions">{pending ? <span className="foldy-badge">Revoke pending</span> : complete ? <span className="foldy-badge">Revoked</span> : <><button type="button" className="foldy-button small" onClick={() => void foldyApi.installInfo(grant.grantId).then(setInstallInfo)}>Instructions</button><button type="button" className="foldy-button small danger" disabled={actions.busy !== null} onClick={() => void actions.act(`revoke:${grant.grantId}`, () => foldyApi.revokeGrant(grant.grantId), refresh)}>Revoke</button></>}</div></li>;
    })}</ol> : <Empty>No grants.</Empty>}</div>
    {activeInfo ? <InstallInstructions info={activeInfo} /> : null}
  </section>;
}

function PasswordPanel({ access, refreshAll, refreshAccess, actions }: { access: FoldyBrowserAccessStatus; refreshAll: () => Promise<void>; refreshAccess: () => Promise<void>; actions: ActionContext }) {
  const [password, setPassword] = useState('');
  const passwordId = useId();
  const locked = access.enabled && !access.authenticated;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password.length < 8) return;
    const operation = locked ? foldyApi.unlock(password) : foldyApi.setPassword(password);
    void actions.act(locked ? 'unlock' : 'password', () => operation, locked ? refreshAll : refreshAccess).then((ok) => { if (ok) setPassword(''); });
  };
  return <section className={`foldy-card${locked ? ' foldy-card-prominent' : ''}`} aria-labelledby="foldy-password-title"><p className="foldy-eyebrow">Local admin access</p><h3 id="foldy-password-title">{locked ? 'Unlock browser' : 'Protect this OpenDesign daemon'}</h3><p className="foldy-hint">This controls local daemon administration only. It does not set deployed Foldy access.</p><p className="foldy-status-line">Protection: <span className="foldy-badge">{access.enabled ? 'Enabled' : 'Disabled'}</span> · Session: {access.authenticated ? 'Authenticated' : 'Locked'}</p><form onSubmit={submit}><label htmlFor={passwordId}>{locked ? 'Shared password' : access.enabled ? 'New shared password' : 'Shared password'}</label><input id={passwordId} type="password" autoComplete={locked ? 'current-password' : 'new-password'} minLength={8} maxLength={1024} value={password} onChange={(event) => setPassword(event.target.value)} /><p className="foldy-hint">{locked ? 'Enter the shared password to restore this browser session.' : 'Use 8–1024 characters. Saving rotates all existing browser sessions.'}</p><div className="foldy-actions"><button type="submit" className="foldy-button primary" disabled={password.length < 8 || actions.busy !== null}>{locked ? 'Unlock' : access.enabled ? 'Rotate password' : 'Enable password'}</button>{!locked && access.enabled ? <button type="button" className="foldy-button danger" disabled={actions.busy !== null} onClick={() => void actions.act('disable-password', () => foldyApi.disablePassword(), refreshAccess)}>Disable protection</button> : null}{!locked && access.authenticated ? <button type="button" className="foldy-button" disabled={actions.busy !== null} onClick={() => void actions.act('logout', () => foldyApi.logout(), refreshAccess)}>Log out browser</button> : null}</div></form></section>;
}

function CynderLifecyclePanel({ projectId, state, grants, refreshPublication, actions }: { projectId: string; state: FoldyPublicationProjectState; grants: FoldyMcpGrant[]; refreshPublication: () => Promise<void>; actions: ActionContext }) {
  const [environment, setEnvironment] = useState('production');
  const [expected, setExpected] = useState('');
  const [accessMode, setAccessMode] = useState<FoldyDeploymentAccessMode>('public');
  const [password, setPassword] = useState('');
  const [mcpGrantId, setMcpGrantId] = useState('');
  const [formRevision, setFormRevision] = useState(0);
  const [reviewedKey, setReviewedKey] = useState<string | null>(null);
  const [status, setStatus] = useState<FoldyCynderStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const statusRequestRevision = useRef(0);
  const revision = state.latestRevisionId;
  const deployerGrants = grants.filter((grant) => !grant.revokedAt && grant.scopes.includes('read') && grant.scopes.includes('deployer'));
  const selectedGrant = deployerGrants.find((grant) => grant.grantId === mcpGrantId) ?? null;
  const normalizedEnvironment = environment.trim();
  const normalizedExpected = expected.trim() || null;
  const passwordReady = accessMode === 'public' || password.length >= 8;
  const reviewKey = JSON.stringify({ revision, environment: normalizedEnvironment, expected: normalizedExpected, accessMode, mcpGrantId, formRevision });
  const invalidateReview = () => { setFormRevision((current) => current + 1); setReviewedKey(null); };
  const clearSensitiveForm = () => { setPassword(''); invalidateReview(); };
  const checks = [
    { label: 'Saved revision exists', ok: Boolean(revision) },
    { label: 'Exact revision approval is current', ok: isApprovedRevision(state, revision) },
    { label: 'Environment is named', ok: Boolean(normalizedEnvironment) },
    { label: 'Deployed access is ready', ok: passwordReady },
    { label: selectedGrant ? `MCP read + deployer grant selected: ${selectedGrant.grantId}` : 'Deployment requires both read and deployer scopes. Read is required to serve the deployed MCP project context; deployer authorizes the release.', ok: Boolean(selectedGrant) },
  ];
  const ready = checks.every((check) => check.ok);
  const refreshStatus = useCallback(async () => {
    const requestRevision = ++statusRequestRevision.current;
    if (!normalizedEnvironment) { setStatus(null); setStatusError(null); return; }
    try {
      const next = await foldyApi.status(projectId, normalizedEnvironment);
      if (requestRevision !== statusRequestRevision.current) return;
      setStatus(next); setStatusError(null);
    } catch (error) {
      if (requestRevision !== statusRequestRevision.current) return;
      setStatus(null); setStatusError(error instanceof Error ? error.message : String(error));
    }
  }, [normalizedEnvironment, projectId]);

  useEffect(() => {
    if (mcpGrantId && !selectedGrant) setMcpGrantId('');
  }, [mcpGrantId, selectedGrant]);
  useEffect(() => { setStatus(null); setStatusError(null); void refreshStatus(); }, [refreshStatus]);
  useEffect(() => { clearSensitiveForm(); }, [projectId]);

  const deploy = () => {
    if (!revision || !selectedGrant || !ready) return;
    void actions.act('cynder:deploy', () => foldyApi.deploy(projectId, revision, {
      environment: normalizedEnvironment,
      idempotencyKey: `deploy-${revision}-${Date.now()}`,
      expectedActiveProviderRevisionId: normalizedExpected,
      accessMode,
      ...(accessMode === 'password_required' ? { password } : {}),
      mcpGrantId: selectedGrant.grantId,
    }), async () => { await Promise.all([refreshPublication(), refreshStatus()]); }).finally(clearSensitiveForm);
  };
  const rollback = (targetRevisionId: string) => {
    if (!normalizedEnvironment || !status || status.projectId !== projectId || status.environment !== normalizedEnvironment) return;
    void actions.act(`cynder:rollback:${targetRevisionId}`, () => foldyApi.rollback(projectId, targetRevisionId, {
      environment: normalizedEnvironment,
      idempotencyKey: `rollback-${targetRevisionId}-${Date.now()}`,
      expectedActiveProviderRevisionId: status.binding?.providerRevisionId ?? null,
    }), async () => { await Promise.all([refreshPublication(), refreshStatus()]); });
  };
  const recover = (receiptId: string) => void actions.act(`recover:${receiptId}`, () => foldyApi.recover(projectId, { environment: normalizedEnvironment, receiptId }), refreshStatus);
  const receipts = [...(status?.completed ?? []), ...(status?.staged ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.receiptId.localeCompare(left.receiptId));
  const currentHealth = status?.completed.find((receipt) => receipt.binding?.providerRevisionId === status.binding?.providerRevisionId)?.health ?? null;
  const remoteInfo = status?.remoteMcpInstallInfo;

  return <section className="foldy-card foldy-card-wide" aria-labelledby="foldy-cynder-title">
    <div className="foldy-card-heading"><div><p className="foldy-eyebrow">Deployment</p><h3 id="foldy-cynder-title">Deploy to Cynder</h3></div><button type="button" className="foldy-button subtle" onClick={() => void refreshStatus()}>Refresh status</button></div>
    <Context revision={revision} cas={`Expected active provider revision: ${normalizedExpected ?? 'None'}`} />
    <div className="foldy-two-fields"><label>Environment<input value={environment} onChange={(event) => { setEnvironment(event.target.value); invalidateReview(); }} /></label><label>Expected provider revision<input value={expected} placeholder="None" onChange={(event) => { setExpected(event.target.value); invalidateReview(); }} /></label></div>
    <fieldset><legend>Deployed access</legend><div className="foldy-checks"><label><input type="radio" name="foldy-deployed-access" checked={accessMode === 'public'} onChange={() => { setAccessMode('public'); setPassword(''); invalidateReview(); }} /> Public</label><label><input type="radio" name="foldy-deployed-access" checked={accessMode === 'password_required'} onChange={() => { setAccessMode('password_required'); invalidateReview(); }} /> Shared password</label></div>{accessMode === 'password_required' ? <label>Deployed shared password<input aria-label="Deployed shared password" type="password" minLength={8} maxLength={1024} autoComplete="new-password" value={password} onChange={(event) => { setPassword(event.target.value); invalidateReview(); }} /><span className="foldy-hint">Use at least 8 characters. This password protects the deployed Foldy.</span></label> : null}</fieldset>
    <label>MCP grant<select value={mcpGrantId} onChange={(event) => { setMcpGrantId(event.target.value); invalidateReview(); }}><option value="">Select a read + deployer grant</option>{deployerGrants.map((grant) => <option key={grant.grantId} value={grant.grantId}>{grant.grantId} · {grant.scopes.join(', ')}</option>)}</select></label>
    <div className="foldy-subsection"><h4>Readiness checks</h4><ul className="foldy-readiness">{checks.map((check) => <li key={check.label} className={check.ok ? 'ok' : 'blocked'}><span aria-hidden="true">{check.ok ? '✓' : '!'}</span>{check.label}</li>)}</ul></div>
    <div className="foldy-actions"><button type="button" className="foldy-button" disabled={!ready || actions.busy !== null} onClick={() => setReviewedKey(reviewKey)}>Review deployment</button><button type="button" className="foldy-button primary" disabled={!ready || reviewedKey !== reviewKey || actions.busy !== null} onClick={deploy}>Deploy exact revision</button></div>
    {reviewedKey === reviewKey ? <div className="foldy-subsection" role="status"><h4>Deployment review</h4><dl className="foldy-state-grid"><Detail label="Exact revision"><code>{revision}</code></Detail><Detail label="Environment">{normalizedEnvironment}</Detail><Detail label="Access">{accessMode === 'public' ? 'Public' : 'Shared password'}</Detail><Detail label="MCP grant"><code>{mcpGrantId}</code></Detail><Detail label="Expected provider state"><code>{normalizedExpected ?? 'None'}</code></Detail></dl><p className="foldy-hint">Deploy remains enabled only while this exact reviewed state and revision approval remain unchanged. The server repeats authoritative checks.</p></div> : null}
    <div className="foldy-subsection"><h4>Authoritative deployment status</h4>{statusError ? <p className="foldy-hint" role="alert">{statusError}</p> : !status ? <p className="foldy-empty">Loading deployment status…</p> : status.binding ? <><dl className="foldy-state-grid"><Detail label="Revision"><code>{status.binding.revisionId}</code></Detail><Detail label="Provider revision"><code>{status.binding.providerRevisionId}</code></Detail><Detail label="Access">{status.binding.accessMode === 'public' ? 'Public' : 'Shared password'}</Detail><Detail label="Stable URL"><a href={status.binding.url} target="_blank" rel="noreferrer">{status.binding.url}</a></Detail><Detail label="MCP URL"><code>{status.binding.mcpUrl}</code></Detail></dl><div className="foldy-actions"><a className="foldy-button" href={status.binding.url} target="_blank" rel="noreferrer">Open live Foldy</a></div>{currentHealth ? <ul className="foldy-readiness">{currentHealth.checks.map((check) => <li key={check.name} className={check.ok ? 'ok' : 'blocked'}><span aria-hidden="true">{check.ok ? '✓' : '!'}</span>{check.name} · {check.ok ? 'Healthy' : 'Unhealthy'}{check.status === undefined ? '' : ` · HTTP ${check.status}`}</li>)}</ul> : <Empty>No semantic health checks recorded.</Empty>}</> : <Empty>No active deployment binding for this environment.</Empty>}</div>
    <div className="foldy-subsection"><h4>Durable deployment receipts</h4>{receipts.length ? <ol className="foldy-list" aria-label="Durable deployment receipt history">{receipts.map((receipt) => {
      const terminalLabel = receipt.status === 'failed' ? 'failed · terminal' : receipt.status === 'rollback_failed' ? 'rollback failed · terminal' : receipt.status.replace('_', ' ');
      const rollbackReady = Boolean(status && status.projectId === projectId && status.environment === normalizedEnvironment && receipt.status !== 'staged');
      return <li key={receipt.receiptId}><div><strong>{receipt.kind} · {terminalLabel}</strong><span><code>{receipt.receiptId}</code> · <code>{receipt.revisionId}</code> · {receipt.accessMode} · grant <code>{receipt.mcpGrantId}</code></span></div><div className="foldy-row-actions">{receipt.binding?.url ? <a href={receipt.binding.url} target="_blank" rel="noreferrer">Open</a> : null}{receipt.recoverable === true ? <button type="button" className="foldy-button small" disabled={actions.busy !== null} aria-label={`Recover ${receipt.receiptId}`} onClick={() => recover(receipt.receiptId)}>Recover</button> : null}{receipt.status !== 'staged' ? <button type="button" className="foldy-button small" disabled={!rollbackReady || actions.busy !== null} aria-label={`Rollback ${receipt.revisionId} on ${receipt.environment}`} onClick={() => rollback(receipt.revisionId)}>Rollback</button> : null}</div></li>;
    })}</ol> : <Empty>No durable deployment receipts.</Empty>}</div>
    {remoteInfo ? <InstallInstructions info={remoteInfo} title="Remote MCP instructions" /> : null}
  </section>;
}

const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function FoldyRuntimePanel({ projectId, entryFile, defaultOpen = false }: FoldyRuntimePanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [state, setState] = useState<FoldyPublicationProjectState | null>(null);
  const [grants, setGrants] = useState<FoldyMcpGrant[]>([]);
  const [access, setAccess] = useState<FoldyBrowserAccessStatus | null>(null);
  const [issued, setIssued] = useState<CreateFoldyMcpGrantResponse | null>(null);
  const [installInfo, setInstallInfo] = useState<FoldyMcpInstallInfo | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const titleId = useId();

  const refreshPublication = useCallback(async () => { setState(await foldyApi.publication(projectId)); }, [projectId]);
  const refreshGrants = useCallback(async () => { setGrants((await foldyApi.grants(projectId)).grants); }, [projectId]);
  const refreshAccess = useCallback(async () => { setAccess(await foldyApi.accessStatus()); }, []);
  const refreshAll = useCallback(async () => {
    const nextAccess = await foldyApi.accessStatus();
    setAccess(nextAccess);
    if (nextAccess.enabled && !nextAccess.authenticated) { setState(null); setGrants([]); return; }
    await Promise.all([refreshPublication(), refreshGrants()]);
  }, [refreshGrants, refreshPublication]);
  const close = useCallback(() => { setOpen(false); triggerRef.current?.focus(); }, []);

  useEffect(() => {
    setIssued(null); setInstallInfo(null); setNotice(null);
    if (open) void refreshAll().catch((error) => setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) }));
  }, [open, projectId, refreshAll]);
  useEffect(() => { if (open) closeRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(focusableSelector)).filter((item) => item.offsetParent !== null || item === document.activeElement);
      if (!items.length) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', onKey); };
  }, [close, open]);

  const act = useCallback(async (name: string, task: () => Promise<unknown>, refresh: () => Promise<void>): Promise<boolean> => {
    if (busy) return false;
    setBusy(name); setNotice(null);
    try {
      await task(); await refresh();
      setNotice({ tone: 'success', text: 'Action completed with the exact state shown.' });
      return true;
    } catch (error) {
      if (error instanceof FoldyApiError && error.status === 409) {
        await refresh().catch(() => undefined);
        setNotice({ tone: 'error', text: `${error.message}. State refreshed; the action was not retried.` });
      } else setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      return false;
    } finally { setBusy(null); }
  }, [busy]);
  const actions = { busy, act };
  const locked = Boolean(access?.enabled && !access.authenticated);

  return <>
    <button ref={triggerRef} type="button" className="foldy-runtime-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>Foldy runtime</button>
    {open ? <div className="foldy-runtime-backdrop" data-testid="foldy-runtime-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><aside ref={panelRef} className="foldy-runtime-panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="foldy-runtime-header"><div><p className="foldy-eyebrow">Project operations</p><h2 id={titleId}>Foldy runtime</h2><p>Publish, review, connect, protect, and deploy outside the rendered artifact.</p></div><button ref={closeRef} type="button" className="foldy-close" aria-label="Close Foldy runtime" onClick={close}>×</button></header>
      {notice ? <div className={`foldy-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</div> : null}
      {!access ? <div className="foldy-loading" role="status">Loading Foldy state…</div> : locked ? <div className="foldy-runtime-grid foldy-runtime-grid-locked"><PasswordPanel access={access} refreshAll={refreshAll} refreshAccess={refreshAccess} actions={actions} /></div> : !state ? <div className="foldy-loading" role="status">Loading Foldy state…</div> : <div className="foldy-runtime-grid">
        <PublicationPanel projectId={projectId} entryFile={entryFile} state={state} refresh={refreshPublication} actions={actions} />
        <ReviewPanel projectId={projectId} state={state} refresh={refreshPublication} actions={actions} />
        <McpPanel projectId={projectId} revision={state.latestRevisionId} grants={grants} issued={issued} installInfo={installInfo} refresh={refreshGrants} setIssued={setIssued} setInstallInfo={setInstallInfo} actions={actions} />
        <PasswordPanel access={access} refreshAll={refreshAll} refreshAccess={refreshAccess} actions={actions} />
        <CynderLifecyclePanel projectId={projectId} state={state} grants={grants} refreshPublication={refreshPublication} actions={actions} />
      </div>}
    </aside></div> : null}
  </>;
}
