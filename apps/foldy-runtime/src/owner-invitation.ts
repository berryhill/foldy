import { randomBytes, createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, fsyncSync, writeFileSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { activeBundle } from './upgrade.js';
import { OwnerAuthority, protectedAncestry } from './owner-authority.js';

const deny = (): never => { throw Error('INVITATION_DENIED'); };
export interface InvitationInput {
  stateDirectory: string; bundleDirectory: string; bundleDigest: string;
  recoveryFile: string; keyFile: string; setupOrigin: string;
}
function absent(path: string) {
  try { lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  deny();
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Offline deploying-principal operation. The recipient key never enters argv, stdout or a URL.
 * Run while the runtime is quiescent; its generation check rejects a stale authorization.
 */
export function issueOwnerInvitation(input: InvitationInput) {
  for (const path of [input.stateDirectory,input.bundleDirectory,input.recoveryFile,input.keyFile]) {
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) deny();
  }
  for (const path of [input.recoveryFile,input.keyFile]) {
    if (path === input.bundleDirectory || path.startsWith(input.bundleDirectory + sep)) deny();
  }
  protectedAncestry(input.stateDirectory, true);
  const lockPath=join(input.stateDirectory,'runtime.lock');
  const lock=openSync(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  closeSync(lock);
  try { return issueLockedInvitation(input); }
  finally { unlinkSync(lockPath);syncDirectory(input.stateDirectory); }
}

function issueLockedInvitation(input: InvitationInput) {
  const stateDirectory = resolve(input.stateDirectory), recoveryFile = resolve(input.recoveryFile), keyFile = resolve(input.keyFile);
  const origin = new URL(input.setupOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.origin !== input.setupOrigin.replace(/\/$/, '') || recoveryFile === keyFile) deny();
  protectedAncestry(stateDirectory, true);
  protectedAncestry(dirname(recoveryFile), true);
  protectedAncestry(dirname(keyFile), true);
  absent(recoveryFile);absent(keyFile);
  const { bundle, authorityBundleDigest } = activeBundle(stateDirectory, { directory: input.bundleDirectory, digest: input.bundleDigest });
  const authority = new OwnerAuthority({ directory: stateDirectory, instanceId: bundle.manifest.instanceId, bundleDigest: authorityBundleDigest, recoveryFile });
  const state = authority.state;
  if (!state) throw Error('INVITATION_DENIED');
  if (!state.ownerPassword || !Number.isSafeInteger(state.generation) || state.generation < 1) deny();
  const assertion = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 15 * 60000;
  const authorization = JSON.stringify({ schemaVersion: 'foldy-owner-recovery.v1', instanceId: state.instanceId,
    bundleDigest: state.bundleDigest, generation: state.generation, nonce: randomBytes(32).toString('hex'),
    verifier: createHash('sha256').update(assertion).digest('hex'), expiresAt });
  // Both destinations are create-only. Close and remove only our newly created output
  // if the other cannot be created; never replace an existing authorization or key.
  let keyFd: number | undefined, recoveryFd: number | undefined;
  try {
    keyFd = openSync(keyFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    recoveryFd = openSync(recoveryFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    for (const [fd, bytes] of [[keyFd, assertion + '\n'], [recoveryFd, authorization]] as const) {
      const s = fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o077)) deny();
      writeFileSync(fd, bytes);fsyncSync(fd);
    }
    syncDirectory(dirname(keyFile));
    if (dirname(recoveryFile) !== dirname(keyFile)) syncDirectory(dirname(recoveryFile));
  } catch (error) {
    if (keyFd !== undefined) { closeSync(keyFd);keyFd = undefined;unlinkSync(keyFile); }
    if (recoveryFd !== undefined) { closeSync(recoveryFd);recoveryFd = undefined;unlinkSync(recoveryFile); }
    throw error;
  } finally {
    if (keyFd !== undefined) closeSync(keyFd);
    if (recoveryFd !== undefined) closeSync(recoveryFd);
  }
  return { setupUrl: origin.origin + '/owner/setup', recoveryFile, keyFile, expiresAt };
}
export function ownerInvitationCli(argv: string[]) {
  const flags = ['--state-dir','--bundle-dir','--bundle-digest','--recovery-file','--key-file','--setup-origin'];
  const args = new Map<string,string>();
  for (let i = 0; i < argv.length; i++) {
    if (!flags.includes(argv[i]) || args.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) deny();
    args.set(argv[i], argv[++i]);
  }
  if (args.size !== flags.length) deny();
  return issueOwnerInvitation({stateDirectory: args.get('--state-dir')!, bundleDirectory: args.get('--bundle-dir')!,
    bundleDigest: args.get('--bundle-digest')!, recoveryFile: args.get('--recovery-file')!,
    keyFile: args.get('--key-file')!, setupOrigin: args.get('--setup-origin')!});
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(ownerInvitationCli(process.argv.slice(2)))); }
  catch { console.error('INVITATION_DENIED');process.exitCode = 1; }
}
