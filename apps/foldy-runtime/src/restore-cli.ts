import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, mkdirSync, lstatSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBundle, digest } from './bundle.js';
import { Domain } from './domain.js';
import { protectedAncestry } from './owner-authority.js';

const deny = (): never => { throw Error('RESTORE_DENIED'); };
function readPrivate(path: string, limit: number): Buffer {
  protectedAncestry(dirname(path), true);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.size > limit) deny();
    const bytes = readFileSync(fd);
    if (bytes.length > limit) deny();
    return bytes;
  } finally { closeSync(fd); }
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function absent(path: string) {
  try { lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  deny();
}
/** Offline OS deploying-principal custody, not a signature verifier or public API.
 * The private custody directory is bound into the authorization so moving a copy
 * cannot relocate the nonce journal. Its owner is the trusted deployment operator.
 */
export function restoreCli(argv: string[]) {
  const args = new Map<string, string>();
  const flags = ['--backup-file', '--bundle-dir', '--bundle-digest', '--authorization-file', '--target-dir'];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json' && !json) { json = true; continue; }
    if (!flags.includes(flag) || args.has(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) deny();
    args.set(flag, argv[++i]);
  }
  if (args.size !== flags.length || !/^[a-f0-9]{64}$/.test(args.get('--bundle-digest')!)) deny();
  const authorizationFile = resolve(args.get('--authorization-file')!);
  const custody = dirname(authorizationFile);
  const target = resolve(args.get('--target-dir')!);
  const bundleDir = resolve(args.get('--bundle-dir')!);
  const a = JSON.parse(readPrivate(authorizationFile, 16384).toString('utf8'));
  const fields = ['schemaVersion', 'instanceId', 'projectId', 'workbookId', 'bundleDigest', 'backupDigest', 'expiresAt', 'nonce', 'custodyDirectory', 'targetDirectory'];
  if (!a || Array.isArray(a) || Object.keys(a).length !== fields.length || fields.some(k => !Object.hasOwn(a, k)) || a.schemaVersion !== 'foldy-restore-authorization.v1' || a.custodyDirectory !== custody || a.targetDirectory !== target || !/^[a-f0-9]{64}$/.test(a.nonce) || !/^[a-f0-9]{64}$/.test(a.backupDigest) || !Number.isSafeInteger(a.expiresAt) || a.expiresAt <= Date.now() || a.expiresAt > Date.now() + 900000) deny();
  // Never restore inside the served bundle or authorization custody, or vice versa.
  for (const p of [bundleDir, custody]) if (target === p || target.startsWith(p + sep) || p.startsWith(target + sep)) deny();
  protectedAncestry(dirname(target), true);
  absent(target);
  const bundle = loadBundle(bundleDir, args.get('--bundle-digest')!);
  if (a.bundleDigest !== bundle.bundleDigest || ['instanceId', 'projectId', 'workbookId'].some(k => a[k] !== bundle.manifest[k as 'instanceId' | 'projectId' | 'workbookId'])) deny();
  const backup = readPrivate(resolve(args.get('--backup-file')!), 64 * 1024 * 1024);
  if (digest(backup) !== a.backupDigest) deny();
  const journal = join(custody, 'restore-used');
  try { mkdirSync(journal, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  protectedAncestry(journal, true);
  syncDirectory(custody);
  // Exclusive creation is the cross-process consume point. Never remove/retry a
  // marker, including on partial write, crash, failed restore or unknown outcome.
  if (a.expiresAt <= Date.now()) deny();
  const marker = openSync(join(journal, a.nonce + '.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(marker, JSON.stringify({ state: 'consumed-outcome-unknown', backupDigest: a.backupDigest, bundleDigest: a.bundleDigest })); fsyncSync(marker); } finally { closeSync(marker); }
  syncDirectory(journal);
  // Fresh mkdir excludes concurrent runtime/restore writers; no existing state is touched.
  mkdirSync(target, { mode: 0o700 });
  syncDirectory(dirname(target));
  const result = Domain.restore(join(target, 'content.sqlite'), backup.toString('utf8'), { id: 'deploying-principal', owner: true, scopes: [] }, bundle.manifest);
  // Restore hashes are not policy authority: reopen against the verified seed.
  const domain = new Domain(join(target, 'content.sqlite'), bundle);
  try { if (!domain.requiresAccessConfiguration()) deny(); } finally { domain.close(); }
  syncDirectory(target);
  return { ...result, bundleDigest: bundle.bundleDigest, backupDigest: a.backupDigest };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(restoreCli(process.argv.slice(2)))); }
  catch { console.error(JSON.stringify({ code: 'RESTORE_DENIED', outcome: 'inspect-private-journal-and-target' })); process.exitCode = 1; }
}
