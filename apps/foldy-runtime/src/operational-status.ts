import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, fstatSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { protectedAncestry } from './owner-authority.js';
export interface BackupEvidence { reference: string; revisionId: string; bytes: number; createdAt: string }
export interface FailureEvidence { requestId: string; operation: 'backup' | 'owner-request'; occurredAt: string }
interface StatusRecord { schemaVersion: 'foldy-operations.v1'; lastBackup: BackupEvidence | null; latestFailure: FailureEvidence | null }
const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
/** Bounded, content-free operational evidence. Never accepts error messages, request
 * bodies, cookies, grants or provider payloads. A prepared backup is not proof that
 * a browser downloaded it, or that a fresh-runtime restore has succeeded. */
export class OperationalStatus {
  private value: StatusRecord = { schemaVersion: 'foldy-operations.v1', lastBackup: null, latestFailure: null };
  private readonly file: string;
  constructor(private readonly directory: string) {
    protectedAncestry(directory); this.file = join(directory, 'operational-status.json');
    let fd: number;
    try { fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw Error('OPERATIONS_STATE_INVALID'); }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o077) || st.size > 8192) throw Error();
      const v = JSON.parse(readFileSync(fd, 'utf8')) as StatusRecord;
      if (!v || Object.keys(v).sort().join() !== 'lastBackup,latestFailure,schemaVersion' || v.schemaVersion !== 'foldy-operations.v1') throw Error();
      const b = v.lastBackup, f = v.latestFailure;
      if (b !== null && (!b || Object.keys(b).sort().join() !== 'bytes,createdAt,reference,revisionId' || !token(b.reference) || !token(b.revisionId) || !Number.isSafeInteger(b.bytes) || b.bytes < 0 || !date(b.createdAt))) throw Error();
      if (f !== null && (!f || Object.keys(f).sort().join() !== 'occurredAt,operation,requestId' || !token(f.requestId) || !['backup','owner-request'].includes(f.operation) || !date(f.occurredAt))) throw Error();
      this.value = v;
    } catch { throw Error('OPERATIONS_STATE_INVALID'); } finally { closeSync(fd); }
  }
  private save(next: StatusRecord) {
    protectedAncestry(this.directory);
    const temporary = this.file + '.' + randomUUID();
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.file);
    const dir = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(dir); } finally { closeSync(dir); }
    this.value = next;
  }
  backupPrepared(revisionId: string, bytes: number): BackupEvidence {
    if (!token(revisionId) || !Number.isSafeInteger(bytes) || bytes < 0) throw Error('OPERATIONS_INPUT_INVALID');
    const backup = { reference: randomUUID(), revisionId, bytes, createdAt: new Date().toISOString() };
    this.save({ ...this.value, lastBackup: backup }); return structuredClone(backup);
  }
  failure(requestId: string, operation: FailureEvidence['operation']) {
    if (!token(requestId) || !['backup','owner-request'].includes(operation)) throw Error('OPERATIONS_INPUT_INVALID');
    this.save({ ...this.value, latestFailure: { requestId, operation, occurredAt: new Date().toISOString() } });
  }
  snapshot(): StatusRecord { return structuredClone(this.value); }
}
