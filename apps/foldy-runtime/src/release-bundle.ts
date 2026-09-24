import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { digest, loadBundle, safePath, policyPath, policyBytes, parsePolicy, type Manifest, type Member } from './bundle.js';

export interface ApprovedRevision {
  instanceId: string; projectId: string; workbookId: string; revisionId: string;
  runtimeImageDigest: string; runtimeVersion: string;
  approvedRevisionId: string; frozen: true;
  members: Member[];
  protectedPaths?: readonly string[];
}
/** Trusted control-plane adapter: authenticate approval, freeze inventory, and
 * classify custody before returning a snapshot. Never implement this from a
 * browser-supplied approval flag. The root is an immutable content-only export. */
export interface ReleaseAdapter {
  snapshot(): { revision: ApprovedRevision; directory: string };
  assertContentOnly(path: string, bytes: Buffer): void;
}
const invalid = (): never => { throw Error('RELEASE_INVALID'); };
const metadataPath = 'runtime-release.json';
const media = new Set(['text/html','text/css','text/plain','application/json','image/png','image/jpeg','image/webp','font/woff2']);
const custody = /(?:^|[/_.-])(?:wallet|signer|payment|credential|credentials|secret|secrets|private|authority|bootstrap|recovery|session|sessions|grants|pepper|state)(?:$|[/_.-])|\.(?:sqlite|db|pem|key|p12)$/i;
const keyMaterial = /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:"|\b)(?:ownerVerifier|passwordVerifier|access_token|refresh_token|private_key|client_secret|seedPhrase|mnemonic)(?:"|\b)\s*[:=]/i;
function exact(value: object, keys: string[]) { if (Object.keys(value).some(k => !keys.includes(k))) invalid(); }
function contentPath(path: string) { if (!safePath(path) || path === 'manifest.json' || path === metadataPath || custody.test(path)) invalid(); }

/** Conservative static closure: dynamic/remote references must first be
 * materialized by the trusted adapter. JavaScript is not a v1 runtime media type. */
function verifyReferences(bytes: Buffer, type: string, path: string, paths: Set<string>) {
  if (type !== 'text/html' && type !== 'text/css') return;
  const text = bytes.toString('utf8');
  if (/<script\b|\bsrcset\s*=|\b(?:src|href)\s*=\s*[^\s"']|\\|&(?:#\d+|#x[\da-f]+|[a-z]+);/i.test(text)) invalid();
  const refs = [...text.matchAll(/\b(?:src|href|poster|data)\s*=\s*["']([^"']*)["']/gi)].map(m => m[1]);
  refs.push(...[...text.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi)].map(m => m[1]));
  refs.push(...[...text.matchAll(/@import\s*["']([^"']+)["']/gi)].map(m => m[1]));
  for (const ref of refs) {
    if (!ref || ref.startsWith('#')) continue;
    // No remote dependencies, encoded aliases, queries, or normalization escapes.
    const name = ref.split('#')[0];
    if (/[?:%\\]/.test(name) || name.startsWith('/') || !safePath(name)) invalid();
    const target = dirname(path) === '.' ? name : `${dirname(path)}/${name}`;
    if (!paths.has(target)) invalid();
  }
}

/** Deterministic bytes; no timestamps, live-state discovery, registry or payments.
 * Writes only to a fresh directory and verifies the result with the real loader.
 * Caller owns a non-adversarial output parent; immutable adapter snapshots are
 * required (filesystem directory mutation during export is not supported). */
export function buildReleaseBundle(adapter: ReleaseAdapter, outputDirectory: string) {
  const snapshot = adapter.snapshot();
  const revision = structuredClone(snapshot.revision);
  exact(revision, ['instanceId','projectId','workbookId','revisionId','runtimeImageDigest','runtimeVersion','approvedRevisionId','frozen','members','protectedPaths']);
  for (const key of ['instanceId','projectId','workbookId','revisionId'] as const)
    if (typeof revision[key] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(revision[key])) invalid();
  if (revision.frozen !== true || revision.approvedRevisionId !== revision.revisionId || !/^sha256:[a-f0-9]{64}$/.test(revision.runtimeImageDigest) || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(revision.runtimeVersion)) invalid();
  if (!Array.isArray(revision.members) || revision.members.length > 1022) invalid();
  const root = resolve(snapshot.directory);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) invalid();
  const declared = new Map<string, Member>();
  for (const member of revision.members) {
    exact(member, ['path','mediaType','bytes','sha256','executableMode']); contentPath(member.path);
    if (declared.has(member.path) || !media.has(member.mediaType) || member.executableMode !== 0 || !Number.isSafeInteger(member.bytes) || member.bytes < 0 || member.bytes > 8*1024*1024 || !/^[a-f0-9]{64}$/.test(member.sha256)) invalid();
    declared.set(member.path, member);
  }
  const files = new Map<string, Buffer>(); let total = 0;
  function walk(directory: string, prefix = '') {
    for (const name of readdirSync(directory).sort()) {
      const path = prefix + name, disk = join(directory, name), stat = lstatSync(disk);
      if (stat.isSymbolicLink()) invalid();
      if (stat.isDirectory()) { if (!safePath(path) || custody.test(path)) invalid(); walk(disk, path + '/'); continue; }
      const member = declared.get(path);
      if (!member) throw Error('RELEASE_INVALID');
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o111)) invalid();
      const fd = openSync(disk, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try { const s = fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || s.size !== member.bytes || (s.mode & 0o111)) invalid(); bytes = readFileSync(fd); } finally { closeSync(fd); }
      total += bytes.length;
      if (total > 32*1024*1024 || bytes.length !== member.bytes || digest(bytes) !== member.sha256 || keyMaterial.test(bytes.toString('utf8'))) invalid();
      // Callback receives a copy: custody inspection cannot change hashed bytes.
      adapter.assertContentOnly(path, Buffer.from(bytes)); files.set(path, bytes);
    }
  }
  walk(root);
  if (files.size !== declared.size || !files.has('index.html')) invalid();
  for (const [path, bytes] of files) verifyReferences(bytes, declared.get(path)!.mediaType, path, new Set(files.keys()));
  const existingPolicy=files.get(policyPath);
  if(existingPolicy){
    const approved=parsePolicy({bytes:existingPolicy,mediaType:declared.get(policyPath)!.mediaType});
    if(revision.protectedPaths!==undefined&&JSON.stringify(approved)!==JSON.stringify(parsePolicy({bytes:policyBytes(revision.protectedPaths),mediaType:'application/json'})))throw Error('POLICY_MISMATCH');
  }else{
    const bytes=policyBytes(revision.protectedPaths===undefined?[]:revision.protectedPaths);files.set(policyPath,bytes);
    declared.set(policyPath,{path:policyPath,mediaType:'application/json',bytes:bytes.length,sha256:digest(bytes),executableMode:0});
  }
  const runtime = Buffer.from(JSON.stringify({ schemaVersion: 'foldy-runtime-release.v1', runtimeVersion: revision.runtimeVersion, runtimeImageDigest: revision.runtimeImageDigest }) + '\n');
  files.set(metadataPath, runtime);
  declared.set(metadataPath, { path: metadataPath, mediaType: 'application/json', bytes: runtime.length, sha256: digest(runtime), executableMode: 0 });
  const members = [...declared.values()].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(m => ({ path:m.path, mediaType:m.mediaType, bytes:m.bytes, sha256:m.sha256, executableMode:0 }));
  const manifest: Manifest = { schemaVersion:'foldy-release-bundle.v1', instanceId:revision.instanceId, projectId:revision.projectId, workbookId:revision.workbookId, revisionId:revision.revisionId, runtimeImageDigest:revision.runtimeImageDigest, members };
  const manifestBytes = Buffer.from(JSON.stringify(manifest) + '\n');
  const bundleDigest = digest(manifestBytes), output = resolve(outputDirectory);
  if (output === root || output.startsWith(root + '/')) invalid();
  mkdirSync(output, { mode:0o755 });
  try {
    for (const member of members) { const path = join(output,member.path); mkdirSync(dirname(path),{recursive:true,mode:0o755}); writeFileSync(path,files.get(member.path)!,{flag:'wx',mode:0o444}); chmodSync(path,0o444); }
    writeFileSync(join(output,'manifest.json'),manifestBytes,{flag:'wx',mode:0o444});
    loadBundle(output,bundleDigest);
    return { manifest, manifestBytes, bundleDigest, directory:output };
  } catch (error) { rmSync(output,{recursive:true,force:true}); throw error; }
}
