import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { constants, lstatSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, existsSync, fstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type Grant = { grantId: string; verifier: string; expiresAt: number; scopes?: string[] };
export type AuthorityState = { instanceId: string; bundleDigest: string; ownerVerifier: string; ownerExpiresAt: number; generation: number; grants: Grant[] };
const MAX_AUTHORITY_BYTES = 1024 * 1024;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const verifier = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const time = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, any>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const invalid = (): never => { throw Error('AUTHORITY_INVALID'); };

// No writable or symlinked ancestry. A root-owned sticky temporary root is
// permitted, but the custody file's immediate parent must be private.
export function protectedAncestry(path: string, privateParent = false) {
  let p = resolve(path);
  const immediate = p;
  for (;;) {
    const s = lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink() || (s.uid !== process.getuid?.() && s.uid !== 0)) invalid();
    if ((s.mode & 0o022) && !(p !== immediate && s.uid === 0 && (s.mode & 0o1000))) invalid();
    if (p === immediate && privateParent && (s.mode & 0o077)) invalid();
    if (dirname(p) === p) break;
    p = dirname(p);
  }
}
function readProtected(path: string): any {
  protectedAncestry(dirname(path), true);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) || s.uid !== process.getuid?.() || s.size > MAX_AUTHORITY_BYTES) invalid();
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
export class OwnerAuthority {
  private current?: AuthorityState;
  private bootstrap?: { instanceId: string; verifier: string; expiresAt: number };
  private readonly path: string;
  constructor(private readonly options: { directory: string; instanceId: string; bundleDigest: string; bootstrapFile?: string; recoveryFile?: string; now?: () => number; rejectBundleVerifier?: (value: string) => boolean }) {
    protectedAncestry(options.directory);
    this.path = join(options.directory, 'authority.json');
    if (existsSync(this.path) || (() => { try { lstatSync(this.path); return true; } catch { return false; } })()) {
      // Legacy state has no generation. Validate before migrating on next write.
      const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const s = fstatSync(fd);
        if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.size > MAX_AUTHORITY_BYTES) invalid();
        const value = JSON.parse(readFileSync(fd, 'utf8'));
        this.current = this.validate({ ...value, generation: value.generation === undefined ? 0 : value.generation });
      } finally { closeSync(fd); }
    } else {
      if (!options.bootstrapFile) invalid();
      const b = readProtected(resolve(options.bootstrapFile!));
      if (!record(b) || !exact(b, ['instanceId', 'verifier', 'expiresAt']) || b.instanceId !== options.instanceId || !verifier(b.verifier) || !time(b.expiresAt) || b.expiresAt > this.now() + 900000 || options.rejectBundleVerifier?.(b.verifier)) invalid();
      this.bootstrap = b as typeof this.bootstrap;
    }
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  get state() { return this.current ? structuredClone(this.current) : undefined; }
  private validate(v: any): AuthorityState {
    if (!record(v) || !exact(v, ['instanceId','bundleDigest','ownerVerifier','ownerExpiresAt','generation','grants']) || v.instanceId !== this.options.instanceId || v.bundleDigest !== this.options.bundleDigest || !verifier(v.ownerVerifier) || !time(v.ownerExpiresAt) || !time(v.generation) || !Array.isArray(v.grants) || v.grants.length > 10000) invalid();
    const ids = new Set<string>();
    for (const g of v.grants) {
      if (!record(g) || !exact(g,['grantId','verifier','expiresAt','scopes']) || typeof g.grantId !== 'string' || !g.grantId || ids.has(g.grantId) || !verifier(g.verifier) || !time(g.expiresAt) || (g.scopes !== undefined && (!Array.isArray(g.scopes) || !g.scopes.includes('foldy:read') || g.scopes.some((s: unknown) => s !== 'foldy:read' && s !== 'foldy:draft:write')))) invalid();
      ids.add(g.grantId);
    }
    return v as AuthorityState;
  }
  persist(next: AuthorityState) {
    this.validate(next);
    const now = this.now();
    next = { ...next, grants: next.grants.filter(g => g.expiresAt > now) };
    // Cardinality alone cannot bound variable-length IDs or repeated scopes.
    // Check the exact UTF-8 payload against the startup limit before any write;
    // never evict active grants to make an issuance fit.
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_AUTHORITY_BYTES) throw Error('AUTHORITY_CAPACITY');
    const committed = structuredClone(next);
    protectedAncestry(this.options.directory);
    const tmp = join(this.options.directory, `.authority-${randomUUID()}`);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { writeFileSync(fd, serialized); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, this.path);
      // Never continue serving old authority after a successful rename, even if
      // the subsequent durability barrier fails.
      this.current = committed;
      const dir = openSync(this.options.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally { if (existsSync(tmp)) unlinkSync(tmp); }
  }
  ownerCookie(cookie?: string) {
    const token = cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('__Host-foldy-owner='))?.slice('__Host-foldy-owner='.length);
    return !!(token && token.length <= 256 && this.current && this.current.ownerExpiresAt > this.now() && hash(token) === this.current.ownerVerifier);
  }
  private rotate() {
    const token = randomBytes(32).toString('base64url');
    const generation = (this.current?.generation ?? 0) + 1;
    this.persist({ instanceId: this.options.instanceId, bundleDigest: this.options.bundleDigest, generation, ownerVerifier: hash(token), ownerExpiresAt: this.now() + 12 * 3600000, grants: [] });
    this.bootstrap = undefined;
    return token;
  }
  claim(input: unknown) {
    if (this.current) throw Error('ALREADY_CLAIMED');
    if (!this.assertion(input) || !this.bootstrap || this.now() >= this.bootstrap.expiresAt || hash(input.assertion) !== this.bootstrap.verifier) throw Error('AUTH_INVALID');
    return this.rotate();
  }
  private assertion(v: unknown): v is { assertion: string } {
    return record(v) && exact(v, ['assertion']) && typeof v.assertion === 'string' && v.assertion.length >= 32 && v.assertion.length <= 256;
  }
  recover(input: unknown) {
    if (!this.current || !this.options.recoveryFile || !this.assertion(input)) throw Error('AUTH_INVALID');
    // Only the deploying principal can install this authorization. The runtime
    // does not issue it from public metadata, the old assertion, or a password.
    const r = readProtected(resolve(this.options.recoveryFile));
    if (!record(r) || !exact(r, ['schemaVersion','instanceId','bundleDigest','generation','nonce','verifier','expiresAt']) || r.schemaVersion !== 'foldy-owner-recovery.v1' || r.instanceId !== this.options.instanceId || r.bundleDigest !== this.options.bundleDigest || r.generation !== this.current.generation || typeof r.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(r.nonce) || !verifier(r.verifier) || !time(r.expiresAt) || r.expiresAt <= this.now() || r.expiresAt > this.now() + 900000 || this.options.rejectBundleVerifier?.(r.verifier) || hash(input.assertion) !== r.verifier) throw Error('AUTH_INVALID');
    // A single fsynced state replacement both consumes the expected generation
    // and revokes all owner/MCP authority. File deletion is not replay custody.
    return this.rotate();
  }
  logout() {
    if (!this.current) throw Error('AUTH_INVALID');
    this.persist({ ...this.current, ownerExpiresAt: 0 });
  }
}
