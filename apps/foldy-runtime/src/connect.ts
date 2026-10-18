import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { protectedAncestry, type Grant } from './owner-authority.js';

export type TunnelBinding = { tunnelId: string; credentialFile: string };

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
  if (Object.keys(binding).sort().join(',') !== 'credentialFile,schemaVersion,tunnelId' || binding.schemaVersion !== 'foldy-secure-mcp-tunnel.v1'
   || typeof binding.tunnelId !== 'string' || !/^tunnel_[a-f0-9]{32}$/.test(binding.tunnelId)
   || typeof binding.credentialFile !== 'string' || !isAbsolute(binding.credentialFile) || resolve(binding.credentialFile) !== binding.credentialFile) throw Error('CONNECT_CONFIG_INVALID');
  // Never open, stat, or return the credential file. The tunnel operator owns it.
  return { tunnelId: binding.tunnelId, credentialFile: binding.credentialFile };
 } catch { throw Error('CONNECT_CONFIG_INVALID'); } finally { closeSync(fd); }
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
