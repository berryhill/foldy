import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, writeFileSync, readFileSync, fsyncSync, fstatSync, linkSync, mkdirSync, readdirSync, unlinkSync, realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { protectedAncestry } from './owner-authority.js';

export type LifecycleKind = 'stop' | 'resume' | 'delete' | 'upgrade';
export type LifecycleStep = 'traffic_off' | 'workload_stop' | 'workload_start' | 'readiness' | 'traffic_on' | 'credentials' | 'cache' | 'artifact' | 'volume';
export type Outcome = 'verified' | 'unsupported' | 'pending' | 'unknown' | 'failed';
export interface LifecycleIdentity { instanceId: string; projectId: string; workbookId: string; instanceName: string }
export interface LifecycleInput { operationId: string; kind: LifecycleKind; expectedGeneration: number; confirmation?: string; backup?: { kind: 'skip' } | { kind: 'verified'; reference: string } }
export interface StepResult { status: Outcome; instanceId?: string; dataRetained?: boolean; ready?: boolean }
export interface LifecycleOperation {
  operationId: string; inputDigest: string; actorRef: string; identity: LifecycleIdentity; input: LifecycleInput;
  status: 'pending' | 'blocked' | 'complete'; generation: number; steps: Partial<Record<LifecycleStep, StepResult>>;
  createdAt: string; updatedAt: string;
}
/** Trusted adapter, NOT a claim of Cynder support. Calls are synchronous and bounded by
 * the adapter; never return a Promise. An effect must be idempotent by operationId/step.
 * readback must independently observe the exact instance, not echo an accepted request.
 * Volume removal must preserve coordinator/control custody until final external receipt.
 * Credentials means owner AND MCP AND viewer sessions/verifiers, not logout alone.
 */
export interface LifecycleDriver {
  capability(step: LifecycleStep, identity: LifecycleIdentity): Outcome;
  apply(step: LifecycleStep, operation: LifecycleOperation): StepResult;
  readback(step: LifecycleStep, operation: LifecycleOperation): StepResult;
  verifyBackup(reference: string, identity: LifecycleIdentity): Outcome;
}
export interface LifecycleOptions {
  /** The SAME SQLite file used by Domain/publication/backup, already initialized. */
  databasePath: string;
  identity: LifecycleIdentity;
  /** Resolved volume/data boundary; tombstones must be outside it. */
  dataRoot: string;
  tombstoneDirectory: string;
  /** Active owner authentication from protected custody, never request owner:boolean. */
  authorizeOwner(context: unknown): { actorRef: string } | null;
  driver: LifecycleDriver;
}
const plans: Record<LifecycleKind, LifecycleStep[]> = {
  stop: ['traffic_off', 'workload_stop'], resume: ['workload_start', 'readiness', 'traffic_on'],
  delete: ['traffic_off', 'workload_stop', 'credentials', 'cache', 'artifact', 'volume'], upgrade: [],
};
const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
function reject(code: string): never { throw Error(code); }
const hash = (v: string) => createHash('sha256').update(v).digest('hex');

/** First coordinator slice. Transport wiring is deliberately external. Hosts MUST call
 * assertIdle inside their backup/restore BEGIN IMMEDIATE admission and gate traffic
 * from state(); SQL triggers additionally fence existing domain writes across restart.
 * A blocked operation is never automatically abandoned, nor is an unknown effect
 * blindly reissued. Reconciliation uses readback only. Upgrade is explicitly unsupported.
 */
export class LifecycleCoordinator {
  private db: DatabaseSync;
  private tombstones: string;
  constructor(private readonly options: LifecycleOptions) {
    const root = realpathSync(options.dataRoot);
    protectedAncestry(options.tombstoneDirectory, true);
    this.tombstones = realpathSync(options.tombstoneDirectory);
    const rel = relative(root, this.tombstones);
    if (!rel || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel))) reject('TOMBSTONE_MUST_BE_EXTERNAL');
    // No silent creation of an empty replacement after deletion.
    realpathSync(options.databasePath);
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;');
    try { this.transaction(() => {
      const ids = JSON.parse(this.db.prepare("SELECT value FROM meta WHERE key='identity'").get()!.value as string);
      if (ids[0] !== options.identity.instanceId || ids[1] !== options.identity.projectId || ids[2] !== options.identity.workbookId) reject('IDENTITY_MISMATCH');
      this.db.exec(`CREATE TABLE IF NOT EXISTS lifecycle_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL, mode TEXT NOT NULL, active TEXT);
        INSERT OR IGNORE INTO lifecycle_state VALUES(1,0,'unknown',NULL);
        CREATE TABLE IF NOT EXISTS lifecycle_operations(id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      for (const table of ['revisions', 'updates', 'receipts']) for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS lifecycle_${table}_${action} BEFORE ${action} ON ${table}
          WHEN (SELECT active IS NOT NULL OR mode IN ('stopped','deleted') FROM lifecycle_state WHERE singleton=1)
          BEGIN SELECT RAISE(ABORT,'LIFECYCLE_INTERLOCK'); END;`);
      }
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS lifecycle_current BEFORE UPDATE ON meta
        WHEN OLD.key='current' AND (SELECT active IS NOT NULL OR mode IN ('stopped','deleted') FROM lifecycle_state WHERE singleton=1)
        BEGIN SELECT RAISE(ABORT,'LIFECYCLE_INTERLOCK'); END;`);
    }); } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  state() { return this.db.prepare('SELECT generation,mode,active FROM lifecycle_state WHERE singleton=1').get() as { generation: number; mode: string; active: string | null }; }
  /** Call on the Domain/backup connection while its BEGIN IMMEDIATE is held. */
  static assertIdle(db: DatabaseSync) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lifecycle_state'").get()) return;
    if (db.prepare('SELECT 1 FROM lifecycle_state WHERE active IS NOT NULL OR mode=\'deleted\'').get()) reject('LIFECYCLE_INTERLOCK');
  }
  get(operationId: string): LifecycleOperation | undefined {
    const row = this.db.prepare('SELECT value FROM lifecycle_operations WHERE id=?').get(operationId);
    return row ? JSON.parse(row.value as string) : undefined;
  }
  private save(op: LifecycleOperation) {
    op.updatedAt = new Date().toISOString();
    this.db.prepare('INSERT INTO lifecycle_operations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(op.operationId, JSON.stringify(op));
  }
  private external(op: LifecycleOperation) {
    writeLifecycleTombstone(this.tombstones, op);
  }

  private result(value: StepResult, step: LifecycleStep): StepResult {
    // Copy only protocol fields. Driver error strings/evidence may contain credentials.
    if (!value || !['verified','unsupported','pending','unknown','failed'].includes(value.status)) return { status: 'unknown' };
    if (value.status !== 'verified') return { status: value.status };
    if (value.instanceId !== this.options.identity.instanceId) return { status: 'unknown' };
    if (['workload_stop','workload_start'].includes(step) && value.dataRetained !== true) return { status: 'unknown' };
    if (step === 'readiness' && value.ready !== true) return { status: 'unknown' };
    return { status: 'verified', instanceId: value.instanceId, ...(['workload_stop','workload_start'].includes(step) ? { dataRetained: true } : {}), ...(step === 'readiness' ? { ready: true } : {}) };
  }
  execute(context: unknown, input: LifecycleInput): LifecycleOperation {
    const actor = this.options.authorizeOwner(context);
    if (!actor || !token(actor.actorRef)) reject('OWNER_REQUIRED');
    if (!input || !token(input.operationId) || !Object.hasOwn(plans,input.kind) || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0 || Object.keys(input).some(k => !['operationId','kind','expectedGeneration','confirmation','backup'].includes(k))) reject('REQUEST_INVALID');
    if (input.kind !== 'delete' && (input.backup !== undefined || input.confirmation !== undefined)) reject('REQUEST_INVALID');
    if (input.kind === 'delete') {
      if (input.confirmation !== this.options.identity.instanceName) reject('CONFIRM_REQUIRED');
      if (!input.backup || !['skip','verified'].includes(input.backup.kind) || Object.keys(input.backup).some(k => !['kind',...(input.backup?.kind === 'verified' ? ['reference'] : [])].includes(k))) reject('BACKUP_DECISION_REQUIRED');
      if (input.backup.kind === 'verified' && !token(input.backup.reference)) reject('BACKUP_DECISION_REQUIRED');
    }
    const canonical: LifecycleInput = { operationId: input.operationId, kind: input.kind, expectedGeneration: input.expectedGeneration,
      ...(input.kind === 'delete' ? { confirmation: input.confirmation, backup: input.backup!.kind === 'skip' ? { kind: 'skip' as const } : { kind: 'verified' as const, reference: input.backup!.reference } } : {}) };
    const inputDigest = hash(JSON.stringify([this.options.identity, actor.actorRef, canonical]));
    let op = this.transaction(() => {
      const old = this.get(input.operationId);
      if (old) { if (old.inputDigest !== inputDigest) reject('IDEMPOTENCY_CONFLICT'); return old; }
      const state = this.state();
      if (state.active) reject('LIFECYCLE_INTERLOCK');
      if (state.generation !== input.expectedGeneration) reject('GENERATION_CONFLICT');
      if (state.mode === 'deleted') reject('INSTANCE_DELETED');
      if (input.kind === 'upgrade') reject('UPGRADE_UNSUPPORTED');
      if (input.kind === 'resume' && state.mode !== 'stopped') reject('STOP_REQUIRED');
      if (canonical.backup?.kind === 'verified' && this.options.driver.verifyBackup(canonical.backup.reference, this.options.identity) !== 'verified') reject('BACKUP_UNVERIFIED');
      const now = new Date().toISOString();
      const created: LifecycleOperation = { operationId: input.operationId, inputDigest, actorRef: actor.actorRef, identity: { ...this.options.identity }, input: canonical, status: 'pending', generation: state.generation, steps: {}, createdAt: now, updatedAt: now };
      this.save(created); this.db.prepare('UPDATE lifecycle_state SET active=? WHERE singleton=1').run(input.operationId); return created;
    });
    if (op.status === 'complete') { if (op.input.kind === 'delete') this.external(op); return op; }
    for (const step of plans[op.input.kind]) {
      const attempted = this.transaction(() => {
        op = this.get(input.operationId)!;
        const prior = op.steps[step] !== undefined;
        if (!prior) op.steps[step] = { status: 'pending' };
        this.save(op); return prior;
      });
      if (op.steps[step]?.status === 'verified') continue;
      // Durable external journal BEFORE any destructive call, including credentials.
      if (op.input.kind === 'delete') this.external(op);
      this.transaction(() => {
        op = this.get(input.operationId)!;
        if (op.steps[step]?.status === 'verified' || op.status === 'complete') return;
        try {
          const capability = this.options.driver.capability(step, this.options.identity);
          if (capability !== 'verified') op.steps[step] = { status: ['unsupported','pending','unknown','failed'].includes(capability) ? capability : 'unknown' };
          else {
            if (!attempted) {
              const accepted = this.result(this.options.driver.apply(step, op), step);
              op.steps[step] = accepted;
              if (accepted.status === 'unsupported' || accepted.status === 'failed') { op.status = 'blocked'; this.save(op); return; }
            }
            op.steps[step] = this.result(this.options.driver.readback(step, op), step);
          }
        } catch { op.steps[step] = { status: 'unknown' }; }
        op.status = op.steps[step]!.status === 'verified' ? 'pending' : 'blocked'; this.save(op);
      });
      if (op.input.kind === 'delete') this.external(op);
      if (op.status === 'blocked') return op;
    }
    this.transaction(() => {
      op = this.get(input.operationId)!;
      if (op.status === 'complete') return;
      if (plans[op.input.kind].some(step => op.steps[step]?.status !== 'verified')) reject('LIFECYCLE_INTERLOCK');
      const changed = this.db.prepare('UPDATE lifecycle_state SET generation=generation+1,mode=?,active=NULL WHERE singleton=1 AND generation=? AND active=?').run(op.input.kind === 'delete' ? 'deleted' : op.input.kind === 'stop' ? 'stopped' : 'running', op.generation, op.operationId);
      if (changed.changes !== 1) reject('GENERATION_CONFLICT');
      op.generation++; op.status = 'complete'; this.save(op);
    });
    if (op.input.kind === 'delete') this.external(op);
    return op;
  }
}

/** Immutable journal: hard-link publication never replaces an existing receipt.
 * Operation binding and each progress slot are compare-or-create, across processes.
 * No lock files to strand on crash; stale replay cannot regress the latest receipt.
 */
function syncDirectory(directory: string) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function readProtectedReceipt(path: string): LifecycleOperation {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    // A second link can exist briefly while the publishing process removes its temp.
    if (!stat.isFile() || stat.nlink < 1 || stat.nlink > 2 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 65536) reject('TOMBSTONE_INVALID');
    return JSON.parse(readFileSync(fd, 'utf8')) as LifecycleOperation;
  } finally { closeSync(fd); }
}
function rank(op: LifecycleOperation): number {
  if (!op || !token(op.operationId) || op.input?.kind !== 'delete' || op.input.operationId !== op.operationId ||
      !['pending','blocked','complete'].includes(op.status) || !op.steps ||
      op.inputDigest !== hash(JSON.stringify([op.identity, op.actorRef, op.input]))) reject('TOMBSTONE_INVALID');
  let verified = 0, seenGap = false;
  for (const step of plans.delete) {
    const result = op.steps[step];
    if (result?.status === 'verified') {
      if (seenGap || result.instanceId !== op.identity.instanceId || (step === 'workload_stop' && result.dataRetained !== true)) reject('TOMBSTONE_INVALID');
      verified++;
    } else { seenGap = true; if (result && !['pending','unknown','failed','unsupported'].includes(result.status)) reject('TOMBSTONE_INVALID'); }
  }
  if (op.status === 'complete') { if (verified !== plans.delete.length) reject('TOMBSTONE_INVALID'); return 100; }
  return verified * 4 + (op.status === 'blocked' ? 3 : op.steps[plans.delete[verified]] ? 2 : 1);
}
const comparable = (op: LifecycleOperation) => JSON.stringify({ ...op, createdAt: '', updatedAt: '' });
function publishReceipt(directory: string, name: string, op: LifecycleOperation, binding = false) {
  const path = join(directory, name), temp = join(directory, `.pending-${randomUUID()}`);
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(op)); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temp, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const old = readProtectedReceipt(path); rank(old);
      if (binding ? old.inputDigest !== op.inputDigest : comparable(old) !== comparable(op)) reject('TOMBSTONE_CONFLICT');
    }
  } finally { unlinkSync(temp); }
  syncDirectory(directory);
}
export function writeLifecycleTombstone(directory: string, op: LifecycleOperation) {
  const progress = rank(op); protectedAncestry(directory, true);
  publishReceipt(directory, `${op.operationId}.json`, op, true);
  const journal = join(directory, `${op.operationId}.journal`);
  try { mkdirSync(journal, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  protectedAncestry(journal, true); syncDirectory(directory);
  publishReceipt(journal, `${progress}-${hash(comparable(op))}.json`, op);
}
/** External receipt survives data-volume removal. No provider effects or authentication. */
export function readLifecycleTombstone(directory: string, operationId: string): LifecycleOperation {
  if (!token(operationId)) reject('REQUEST_INVALID');
  protectedAncestry(directory, true);
  let op = readProtectedReceipt(join(directory, `${operationId}.json`)); let progress = rank(op);
  if (op.operationId !== operationId) reject('TOMBSTONE_INVALID');
  const journal = join(directory, `${operationId}.journal`);
  try { protectedAncestry(journal, true); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return op; throw error; }
  for (const name of readdirSync(journal)) {
    if (!/^\d+-[a-f0-9]{64}\.json$/.test(name)) continue;
    const next = readProtectedReceipt(join(journal, name)), nextRank = rank(next);
    if (next.operationId !== operationId || next.inputDigest !== op.inputDigest || name !== `${nextRank}-${hash(comparable(next))}.json`) reject('TOMBSTONE_INVALID');
    if (nextRank > progress || (nextRank === progress && next.updatedAt > op.updatedAt)) { op = next; progress = nextRank; }
  }
  return op;
}
