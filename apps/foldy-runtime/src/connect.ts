import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { protectedAncestry, type Grant } from './owner-authority.js';
import { validObservation, liveTransportProcess, type ProcessProbe } from './transport-observation.js';

export type TunnelBinding = { tunnelId: string; credentialFile: string; evidenceFile?: string; alias?: string };

/** A protected operator configuration reference, not tunnel credential custody or online proof. */
export function tunnelBinding(reference: string | undefined): TunnelBinding | null {
 if (reference === undefined) return null;
 if (!isAbsolute(reference) || resolve(reference) !== reference) throw Error('CONNECT_CONFIG_INVALID');
 protectedAncestry(dirname(reference), true);
 const fd = openSync(reference, constants.O_RDONLY | constants.O_NOFOLLOW);
 try {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 4096) throw Error('CONNECT_CONFIG_INVALID');
  const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('CONNECT_CONFIG_INVALID');
  const binding = value as Record<string, unknown>;
  const v1 = binding.schemaVersion === 'foldy-secure-mcp-tunnel.v1' && Object.keys(binding).sort().join(',') === 'credentialFile,schemaVersion,tunnelId';
  const v2 = binding.schemaVersion === 'foldy-secure-mcp-tunnel.v2' && Object.keys(binding).sort().join(',') === 'alias,credentialFile,evidenceFile,schemaVersion,tunnelId';
  if ((!v1 && !v2)
   || typeof binding.tunnelId !== 'string' || !/^tunnel_[a-f0-9]{32}$/.test(binding.tunnelId)
   || typeof binding.credentialFile !== 'string' || !isAbsolute(binding.credentialFile) || resolve(binding.credentialFile) !== binding.credentialFile) throw Error('CONNECT_CONFIG_INVALID');
  if (v2 && (typeof binding.alias !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(binding.alias) || typeof binding.evidenceFile !== 'string' || !isAbsolute(binding.evidenceFile) || resolve(binding.evidenceFile) !== binding.evidenceFile || binding.evidenceFile === reference || binding.evidenceFile === binding.credentialFile)) throw Error('CONNECT_CONFIG_INVALID');
  // Never open, stat, or return the credential file. The tunnel operator owns it.
  return v2 ? { tunnelId: binding.tunnelId, credentialFile: binding.credentialFile, alias:binding.alias as string, evidenceFile:binding.evidenceFile as string } : { tunnelId: binding.tunnelId, credentialFile: binding.credentialFile };
 } catch { throw Error('CONNECT_CONFIG_INVALID'); } finally { closeSync(fd); }
}

/** The runtime consumes only a fresh, matching, private normalized observation. */
export function transportStatus(binding: TunnelBinding | null, now = Date.now(), probe:ProcessProbe=liveTransportProcess) {
 const fallback = {state:binding?'configured-not-verified':'unconfigured',observedAt:null as number|null,errorCode:binding?'TRANSPORT_UNVERIFIED':null as string|null};
 if (!binding?.evidenceFile || !binding.alias) return fallback;
 try {
  const path = binding.evidenceFile;
  protectedAncestry(dirname(path), true);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
   const stat = fstatSync(fd);
   if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size < 1 || stat.size > 4096) return fallback;
   const value: unknown = JSON.parse(readFileSync(fd,'utf8'));
   if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
   const evidence=validObservation(value,binding.tunnelId,binding.alias,now,probe);
   if(!evidence)return fallback;
   return {state:evidence.state,observedAt:evidence.observedAt,errorCode:evidence.state==='healthy'?'TRANSPORT_POLL_PENDING':null};
  } finally { closeSync(fd); }
 } catch { return fallback; }
}

export function grantEvidence(grant: Grant, now = Date.now()) {
 const active = grant.expiresAt > now;
 return {
  grantId: grant.grantId,
  kind: grant.grantId.startsWith('oauth:') ? 'oauth' : 'opaque',
  scopes: grant.scopes || ['foldy:read'],
  expiresAt: grant.expiresAt,
  active,
  verified: active && !!grant.lastSuccessfulReadAt,
  lastSuccessfulReadAt: active ? grant.lastSuccessfulReadAt || null : null,
  lastSuccessfulDraftAt: active ? grant.lastSuccessfulDraftAt || null : null,
 };
}
