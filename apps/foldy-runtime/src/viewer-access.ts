import * as crypto from 'node:crypto';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
// Node 24.15 provides this API; repository @types/node predates its addition.
const { argon2 } = crypto as unknown as { argon2: (algorithm: 'argon2id', options: { message: Buffer; nonce: Buffer; memory: number; passes: number; parallelism: number; tagLength: number }, callback: (error: Error | null, result: Buffer) => void) => void };
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';

export interface ViewerIdentity { instanceId: string; workbookId: string }
export interface ViewerAccessOptions extends ViewerIdentity {
  /** Dedicated private directory under the host-resolved durable data root. Never serve/export it. */
  directory: string;
  clock?: () => number;
  /** Must verify an independent OWNER session, never a viewer cookie/password. */
  authorizeOwner: (context: unknown, identity: ViewerIdentity) => Promise<{ actorRef: string } | null>;
  /** Must actually purge/disable every provider cache; false/errors keep the gate sealed. */
  invalidateCaches: (identity: ViewerIdentity & { protectionVersion: number }) => Promise<boolean>;
  /** Required shared ingress limiter, keyed by trusted source across instances. */
  allowSource: (source: string) => Promise<boolean>;
}
export type AccessChange = { mode: 'password_required'; password: string } | { mode: 'public'; confirmDisable?: boolean };
export interface AccessReceipt extends ViewerIdentity {
  operation: 'enable' | 'replace' | 'disable'; mode: 'public' | 'password_required';
  protectionVersion: number; actorRef: string; occurredAt: number;
  grantsRevoked: true; cacheInvalidated: true;
}
export type UnlockResult = { ok: true; token: string; role: 'VIEWER'; absoluteExpiresAt: number; code?: never; retryAfterMs?: never }
  | { ok: false; code: 'AUTH_INVALID' | 'RATE_LIMITED' | 'ACCESS_UNAVAILABLE'; retryAfterMs?: number };
type Session = ViewerIdentity & { protectionVersion: number; issuedAt: number; lastSeen: number };
type Failure = { attempts: number[]; blockedUntil: number };
type State = ViewerIdentity & { schema: 1; mode: 'public' | 'password_required'; protectionVersion: number; cacheReady: boolean;
  verifier: null | { algorithm: 'argon2id'; salt: string; hash: string };
  sessions: Record<string, Session>; failures: Record<string, Failure> };
const IDLE = 30 * 60000, ABSOLUTE = 12 * 60 * 60000, WINDOW = 15 * 60000;
// Bounds leave ample headroom for refreshing existing grants and owner changes.
const MAX_BYTES = 8 * 1024 * 1024, ADMISSION_BYTES = 7 * 1024 * 1024;
const MAX_FAILURES = 1024, MAX_SESSIONS = 1024, MAX_ATTEMPTS = 32;
// Shared across gate instances in this process; the ingress limiter also spans hosts.
let viewerDerivations = 0, ownerDerivations = 0;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const hex = (s: unknown, bytes: number) => typeof s === 'string' && new RegExp(`^[a-f0-9]{${bytes * 2}}$`).test(s);
const validPassword = (p: unknown): p is string => typeof p === 'string' && Buffer.from(p, 'utf8').toString('utf8') === p && Array.from(p).length >= 12 && Array.from(p).length <= 128;
const derive = (password: string, salt: string): Promise<Buffer> => new Promise((accept, reject) => {
  argon2('argon2id', { message: Buffer.from(password, 'utf8'), nonce: Buffer.from(salt, 'hex'), memory: 65536, passes: 3, parallelism: 1, tagLength: 32 }, (error, result) => error ? reject(new Error('VERIFIER_UNAVAILABLE')) : accept(result));
});

/** Server-only boundary. All returned grants are VIEWER/public-read only.
 * Handler obligations: TLS, redacted bounded POST bodies, CSRF/origin checks for
 * mutations, trusted proxy source resolution, no-store and authorization before
 * all workbook bytes. Put token ONLY in Secure HttpOnly SameSite=Strict cookie,
 * host-only, narrow path, no remember-device; clear cookie after durable logout.
 * Never log unlock result. Never use this gate for owner/MCP authorization.
 * One dedicated custody directory per instance. Locks fail closed (no unsafe
 * stale-lock takeover); crashed locks require operator reconciliation.
 */
export class ViewerAccess {
  #options: ViewerAccessOptions;
  #directory: string;
  #file: string;
  constructor(options: ViewerAccessOptions) {
    if (!options.instanceId || !options.workbookId || typeof options.authorizeOwner !== 'function' || typeof options.invalidateCaches !== 'function' || typeof options.allowSource !== 'function') throw new Error('INVALID_CONFIGURATION');
    this.#options = options; this.#directory = resolve(options.directory); this.#file = join(this.#directory, 'viewer-access.json');
    try {
      this.#checkAncestors(dirname(this.#directory));
      // Only a newly created dedicated directory gets the public default. Missing
      // state in an existing directory is corruption, never a public reset.
      let created = false;
      try { mkdirSync(this.#directory, { mode: 0o700 }); created = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      this.#checkDirectory();
      if (created) this.#save({ ...this.#identity(), schema: 1, mode: 'public', protectionVersion: 0, cacheReady: true, verifier: null, sessions: {}, failures: {} });
    } catch { throw new Error('STORE_UNAVAILABLE'); }
  }
  #identity(): ViewerIdentity { return { instanceId: this.#options.instanceId, workbookId: this.#options.workbookId }; }
  #now(): number { const n = (this.#options.clock ?? Date.now)(); if (!Number.isSafeInteger(n) || n < 0) throw new Error('CLOCK_UNAVAILABLE'); return n; }
  #checkAncestors(path: string) {
    let current = parse(path).root;
    for (const part of path.slice(current.length).split('/').filter(Boolean)) {
      current = join(current, part); const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('STORE_UNAVAILABLE');
    }
  }
  #checkDirectory() {
    this.#checkAncestors(this.#directory);
    const stat = lstatSync(this.#directory);
    if ((stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) throw new Error('STORE_UNAVAILABLE');
  }
  #load(): State {
    this.#checkDirectory();
    const fd = openSync(this.#file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let s: State;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()) || stat.size > MAX_BYTES) throw new Error();
      s = JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
    if (s.schema !== 1 || s.instanceId !== this.#options.instanceId || s.workbookId !== this.#options.workbookId || !Number.isSafeInteger(s.protectionVersion) || s.protectionVersion < 0 || typeof s.cacheReady !== 'boolean' || !['public', 'password_required'].includes(s.mode)) throw new Error('STORE_UNAVAILABLE');
    if (s.mode === 'public' ? s.verifier !== null : !s.verifier || s.verifier.algorithm !== 'argon2id' || !hex(s.verifier.salt, 16) || !hex(s.verifier.hash, 32)) throw new Error('STORE_UNAVAILABLE');
    if (!s.sessions || !s.failures || typeof s.sessions !== 'object' || typeof s.failures !== 'object' || Array.isArray(s.sessions) || Array.isArray(s.failures)) throw new Error('STORE_UNAVAILABLE');
    for (const [key, v] of Object.entries(s.sessions)) if (!hex(key, 32) || !v || v.instanceId !== s.instanceId || v.workbookId !== s.workbookId || v.protectionVersion !== s.protectionVersion || !Number.isSafeInteger(v.issuedAt) || !Number.isSafeInteger(v.lastSeen) || v.issuedAt < 0 || v.lastSeen < v.issuedAt) throw new Error('STORE_UNAVAILABLE');
    for (const [key, v] of Object.entries(s.failures)) if (!hex(key, 32) || !v || !Array.isArray(v.attempts) || !v.attempts.every(n => Number.isSafeInteger(n) && n >= 0) || !Number.isSafeInteger(v.blockedUntil)) throw new Error('STORE_UNAVAILABLE');
    return s;
  }
  #prune(state: State) {
    const now = this.#now();
    for (const [key, session] of Object.entries(state.sessions)) {
      if (now - session.lastSeen >= IDLE || now - session.issuedAt >= ABSOLUTE) delete state.sessions[key];
    }
    for (const [key, failure] of Object.entries(state.failures)) {
      failure.attempts = failure.attempts.filter(n => n > now - WINDOW);
      if (failure.blockedUntil <= now && failure.attempts.length === 0) delete state.failures[key];
    }
  }
  #fits(state: State, bytes = MAX_BYTES): boolean {
    return Object.keys(state.failures).length <= MAX_FAILURES && Object.keys(state.sessions).length <= MAX_SESSIONS
      && Object.values(state.failures).every(f => f.attempts.length <= MAX_ATTEMPTS)
      && Buffer.byteLength(JSON.stringify(state), 'utf8') <= bytes;
  }
  #save(state: State) {
    this.#prune(state);
    if (!this.#fits(state)) throw new Error('STORE_CAPACITY');
    const serialized = JSON.stringify(state);
    this.#checkDirectory();
    if (existsSync(this.#file)) { const s = lstatSync(this.#file); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new Error('STORE_UNAVAILABLE'); }
    const temp = join(this.#directory, `.write-${randomBytes(16).toString('hex')}`);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, serialized); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      this.#checkDirectory(); renameSync(temp, this.#file);
      const dir = openSync(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  async #transaction<T>(fn: (s: State) => Promise<T>): Promise<T> {
    this.#checkDirectory();
    const lock = join(this.#directory, '.viewer-access.lock');
    let fd: number;
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); } catch { throw new Error('STORE_UNAVAILABLE'); }
    try { return await fn(this.#load()); } finally { closeSync(fd); unlinkSync(lock); }
  }
  async status(): Promise<{ mode: 'public' | 'password_required' | 'unavailable'; protectionVersion?: number }> {
    try { return await this.#transaction(async s => s.cacheReady ? { mode: s.mode, protectionVersion: s.protectionVersion } : { mode: 'unavailable' }); } catch { return { mode: 'unavailable' }; }
  }
  async configure(context: unknown, change: AccessChange): Promise<AccessReceipt> {
    const actor = await this.#options.authorizeOwner(context, this.#identity());
    if (!actor || typeof actor.actorRef !== 'string' || !actor.actorRef) throw new Error('OWNER_REQUIRED');
    if (change.mode !== 'public' && change.mode !== 'password_required') throw new Error('INVALID_CONFIGURATION');
    if (change.mode === 'public' && change.confirmDisable !== true) throw new Error('CONFIRM_REQUIRED');
    if (change.mode === 'password_required' && !validPassword(change.password)) throw new Error('PASSWORD_POLICY');
    // Owner work has a separate bounded slot so anonymous work cannot starve recovery.
    let verifier: State['verifier'] = null;
    if (change.mode === 'password_required') {
      if (ownerDerivations >= 1) throw new Error('VERIFIER_UNAVAILABLE');
      ownerDerivations++;
      try {
        const salt = randomBytes(16).toString('hex');
        verifier = { algorithm: 'argon2id', salt, hash: (await derive(change.password, salt)).toString('hex') };
      } finally { ownerDerivations--; }
    }
    return this.#transaction(async s => {
      const operation = change.mode === 'public' ? 'disable' : s.mode === 'public' ? 'enable' : 'replace';
      s.mode = change.mode; s.protectionVersion++; s.verifier = verifier; s.sessions = {}; s.cacheReady = false;
      this.#save(s); // Persist sealed state before cache invalidation; restart cannot bypass it.
      let purged = false;
      try { purged = await this.#options.invalidateCaches({ ...this.#identity(), protectionVersion: s.protectionVersion }); } catch { /* sealed until owner retries */ }
      if (purged !== true) throw new Error('CACHE_UNAVAILABLE');
      s.cacheReady = true; this.#save(s);
      return { ...this.#identity(), operation, mode: s.mode, protectionVersion: s.protectionVersion, actorRef: actor.actorRef, occurredAt: this.#now(), grantsRevoked: true, cacheInvalidated: true };
    });
  }
  async unlock(password: unknown, source: string): Promise<UnlockResult> {
    let slot = false;
    try {
      if (typeof source !== 'string' || !source || source.length > 512) return { ok: false, code: 'AUTH_INVALID' };
      if (await this.#options.allowSource(source) !== true) return { ok: false, code: 'RATE_LIMITED' };
      const snapshot = await this.#transaction<UnlockResult | { version: number; verifier: NonNullable<State['verifier']>; key: string; delay: number }>(async s => {
        if (!s.cacheReady) return { ok: false, code: 'ACCESS_UNAVAILABLE' };
        if (s.mode !== 'password_required' || !s.verifier) return { ok: false, code: 'AUTH_INVALID' };
        this.#prune(s);
        const now = this.#now(), key = digest(JSON.stringify([s.instanceId, source]));
        const failure = s.failures[key] ?? { attempts: [], blockedUntil: 0 };
        if (failure.blockedUntil > now) return { ok: false, code: 'RATE_LIMITED', retryAfterMs: failure.blockedUntil - now };
        if (validPassword(password) && viewerDerivations >= 2) return { ok: false, code: 'RATE_LIMITED' };
        // Reserve the attempt before releasing the lock, including concurrent guesses.
        if (failure.attempts.length >= MAX_ATTEMPTS) return { ok: false, code: 'RATE_LIMITED' };
        failure.attempts.push(now);
        const delay = failure.attempts.length >= 5 ? Math.min(WINDOW, 1000 * 2 ** Math.min(20, failure.attempts.length - 5)) : 0;
        failure.blockedUntil = now + delay; s.failures[key] = failure;
        if (!this.#fits(s, ADMISSION_BYTES)) return { ok: false, code: 'RATE_LIMITED' };
        this.#save(s);
        if (!validPassword(password)) return { ok: false, code: 'AUTH_INVALID', ...(delay ? { retryAfterMs: delay } : {}) };
        viewerDerivations++; slot = true;
        return { version: s.protectionVersion, verifier: { ...s.verifier }, key, delay };
      });
      if ('ok' in snapshot) return snapshot;
      if (!validPassword(password)) return { ok: false, code: 'AUTH_INVALID' };
      const valid = timingSafeEqual(await derive(password, snapshot.verifier.salt), Buffer.from(snapshot.verifier.hash, 'hex'));
      return await this.#transaction<UnlockResult>(async s => {
        // Never apply a result obtained against a previous protection epoch.
        if (!s.cacheReady || s.mode !== 'password_required' || s.protectionVersion !== snapshot.version
          || s.verifier?.salt !== snapshot.verifier.salt || s.verifier?.hash !== snapshot.verifier.hash) return { ok: false, code: 'ACCESS_UNAVAILABLE' };
        this.#prune(s);
        if (!valid) return { ok: false, code: 'AUTH_INVALID', ...(snapshot.delay ? { retryAfterMs: snapshot.delay } : {}) };
        const now = this.#now();
        const token = randomBytes(32).toString('base64url');
        s.sessions[digest(token)] = { ...this.#identity(), protectionVersion: s.protectionVersion, issuedAt: now, lastSeen: now };
        if (!this.#fits(s, ADMISSION_BYTES)) return { ok: false, code: 'RATE_LIMITED' };
        delete s.failures[snapshot.key];
        this.#save(s);
        return { ok: true, token, role: 'VIEWER', absoluteExpiresAt: now + ABSOLUTE };
      });
    } catch { return { ok: false, code: 'ACCESS_UNAVAILABLE' }; }
    finally { if (slot) viewerDerivations--; }
  }
  async authorize(token?: string, capability: string = 'public_read'): Promise<{ allowed: true; role: 'VIEWER' } | { allowed: false }> {
    if (capability !== 'public_read') return { allowed: false };
    try { return await this.#transaction(async s => {
      if (!s.cacheReady) return { allowed: false };
      if (s.mode === 'public') return { allowed: true, role: 'VIEWER' };
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return { allowed: false };
      const key = digest(token), session = s.sessions[key], now = this.#now();
      if (!session) return { allowed: false };
      if (now < session.lastSeen || now - session.lastSeen >= IDLE || now - session.issuedAt >= ABSOLUTE) { delete s.sessions[key]; this.#save(s); return { allowed: false }; }
      session.lastSeen = now; this.#save(s); return { allowed: true, role: 'VIEWER' };
    }); } catch { return { allowed: false }; }
  }
  async logout(token: string): Promise<{ revoked: true }> {
    try { return await this.#transaction(async s => { if (typeof token === 'string') delete s.sessions[digest(token)]; this.#save(s); return { revoked: true }; }); }
    catch { throw new Error('STORE_UNAVAILABLE'); }
  }
}
