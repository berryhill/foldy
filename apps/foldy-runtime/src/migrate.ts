import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, safePath, type Member } from './bundle.js';
import { staticHtmlInspection } from './static-html.js';
import { buildReleaseBundle, prepareReleaseBundle, type ApprovedRevision, type ReleaseAdapter } from './release-bundle.js';

/** The plan is an assertion by a trusted local deployment principal, NOT an
 * authorization token. The operator must separately inspect the archive for
 * sensitive content, approve its immutable inventory and control its source.
 * Never expose this command as a public JSON/API approval endpoint. */
export interface MigrationPlan {
  schemaVersion: 'foldy-preserved-copy-plan.v1';
  sourceProjectUrl: string;
  provenance: string;
  revision: ApprovedRevision;
}
export interface MigrationReason { code: string; path?: string }
export interface MigrationReport {
  schemaVersion: 'foldy-preserved-copy-report.v1';
  ok: boolean;
  sourceProjectUrl?: string;
  provenance?: string;
  projectId?: string;
  revisionId?: string;
  sourceMembers?: Member[];
  bundleDigest?: string;
  reasons: MigrationReason[];
}
export interface MigrationOptions { sourceDir: string; planFile: string; dryRun?: boolean; outputDir?: string }
const reason = (code: string, path?: string): MigrationReason => path === undefined ? { code } : { code, path };
const inside = (a: string, b: string) => a === b || a.startsWith(b + sep);
function entryExists(path:string){try{lstatSync(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
const exact = (o: object, keys: readonly string[]) => Object.keys(o).every(k => keys.includes(k));
const base = (): MigrationReport => ({ schemaVersion: 'foldy-preserved-copy-report.v1', ok: false, reasons: [] });
function readPlan(file: string): MigrationPlan {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error('PLAN_INVALID');
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !exact(parsed, ['schemaVersion','sourceProjectUrl','provenance','revision'])) throw Error('PLAN_INVALID');
  const plan = parsed as MigrationPlan;
  if (plan.schemaVersion !== 'foldy-preserved-copy-plan.v1' || typeof plan.sourceProjectUrl !== 'string' || typeof plan.provenance !== 'string' || !plan.provenance.trim() || plan.provenance.length > 2048 || !plan.revision || typeof plan.revision !== 'object' || Array.isArray(plan.revision)) throw Error('PLAN_INVALID');
  const url = new URL(plan.sourceProjectUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || !/^\/(?:api\/)?projects\/[A-Za-z0-9_-]{1,128}\/?$/.test(url.pathname)) throw Error('PROJECT_IDENTITY_MISMATCH');
  if (url.pathname.split('/').filter(Boolean).at(-1) !== plan.revision.projectId) throw Error('PROJECT_IDENTITY_MISMATCH');
  return plan;
}
function sourceInventory(root: string, revision: ApprovedRevision): MigrationReason[] {
  const issues: MigrationReason[] = [];
  if (!Array.isArray(revision.members)) return [reason('PLAN_INVALID')];
  const declared = new Map<string, Member>();
  if (revision.members.length > 1022) return [reason('SOURCE_LIMIT_EXCEEDED')];
  let total = 0, entries = 0;
  for (const member of revision.members) {
    if (!member || typeof member !== 'object' || !safePath(member.path) || declared.has(member.path)) return [reason('PLAN_INVALID')];
    declared.set(member.path, member);
    if (/\.(?:js|mjs|cjs|wasm|svg|html?)$/i.test(member.path) && /\.(?:js|mjs|cjs|wasm|svg)$/i.test(member.path)) issues.push(reason('UNSUPPORTED_ACTIVE_CONTENT', member.path));
    if (member.mediaType === 'text/html' || member.mediaType === 'text/css') {
      // Structural hints only. The release validator is authoritative; no
      // regex inspection substitutes for independent human content review.
    }
  }
  function walk(dir: string, prefix = ''): void {
    for (const name of readdirSync(dir).sort()) {
      const rel = prefix + name, disk = join(dir, name), stat = lstatSync(disk);
      if (++entries > 4096 || rel.split('/').length > 64) throw Error('SOURCE_LIMIT_EXCEEDED');
      if (!safePath(rel) || stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) { issues.push(reason('UNSAFE_SOURCE_PATH')); continue; }
      if (stat.isDirectory()) { walk(disk, rel + '/'); continue; }
      const member = declared.get(rel);
      if (!member) { issues.push(reason('UNDECLARED_ASSET', rel)); continue; }
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o111)) { issues.push(reason('UNSAFE_SOURCE_PATH', rel)); continue; }
      total += stat.size;
      if (stat.size > 8*1024*1024 || total > 32*1024*1024) { issues.push(reason('SOURCE_LIMIT_EXCEEDED', rel)); continue; }
      const fd = openSync(disk, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try { bytes = readFileSync(fd); if (fstatSync(fd).size !== bytes.length) { issues.push(reason('SOURCE_CHANGED', rel)); continue; } } finally { closeSync(fd); }
      if (bytes.length !== member.bytes) issues.push(reason('SIZE_MISMATCH', rel));
      if (digest(bytes) !== member.sha256) issues.push(reason('HASH_MISMATCH', rel));
      if (member.mediaType === 'text/html' || member.mediaType === 'text/css') {
        let text = bytes.toString('utf8');
        if (member.mediaType === 'text/html') {
          try { text = staticHtmlInspection(text); }
          catch { issues.push(reason('UNSUPPORTED_ACTIVE_CONTENT', rel)); continue; }
        }
        if (/<script\b|\bon\w+\s*=|<iframe\b|<object\b|<embed\b|<form\b|<base\b|\bsrcset\s*=/i.test(text)) issues.push(reason('UNSUPPORTED_ACTIVE_CONTENT', rel));
        if (/\b(?:src|href|poster|data)\s*=\s*["'](?:https?:|\/\/|data:|javascript:)|url\(\s*["']?(?:https?:|\/\/|data:)/i.test(text)) issues.push(reason('UNSUPPORTED_DEPENDENCY', rel));
        const refs = [...text.matchAll(/\b(?:src|href|poster|data)\s*=\s*["']([^"']*)["']/gi), ...text.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi), ...text.matchAll(/@import\s*["']([^"']+)["']/gi)];
        for (const match of refs) {
          const ref = match[1]; if (!ref || ref.startsWith('#')) continue;
          if (!safePath(ref)) { issues.push(reason('UNSUPPORTED_DEPENDENCY', rel)); continue; }
          const target = dirname(rel) === '.' ? ref : `${dirname(rel)}/${ref}`;
          if (!declared.has(target)) issues.push(reason('MISSING_DEPENDENCY', rel));
        }
      }
    }
  }
  walk(root);
  for (const path of declared.keys()) if (!existsSync(join(root, path))) issues.push(reason('MISSING_ASSET', path));
  return issues;
}
/** Fails closed with codes and inventory metadata only; never returns source bytes. */
export function migrate(options: MigrationOptions): MigrationReport {
  const report = base();
  try {
    if (!options.sourceDir || !options.planFile || Boolean(options.dryRun) === (options.outputDir !== undefined)) throw Error('ARGUMENTS_INVALID');
    const source = resolve(options.sourceDir), planFile = resolve(options.planFile);
    if (!isAbsolute(options.sourceDir) || !isAbsolute(options.planFile) || !lstatSync(source).isDirectory() || realpathSync(source) !== source) throw Error('SOURCE_INVALID');
    if (inside(planFile, source)) throw Error('PLAN_INSIDE_SOURCE');
    const plan = readPlan(planFile);
    report.sourceProjectUrl = plan.sourceProjectUrl; report.provenance = plan.provenance;
    report.projectId = plan.revision.projectId; report.revisionId = plan.revision.revisionId;
    if (options.outputDir !== undefined) {
      if (!isAbsolute(options.outputDir)) throw Error('ARGUMENTS_INVALID');
      const output = resolve(options.outputDir), reportFile = output + '.migration-report.json';
      if (inside(output, source) || inside(source, output) || inside(reportFile, source)) throw Error('OVERLAPPING_PATHS');
      if (entryExists(output) || entryExists(reportFile)) throw Error('OUTPUT_EXISTS');
      // Neither target may alias the source through an existing parent symlink.
      const parent = realpathSync(dirname(output));
      if (parent !== dirname(output) || inside(join(parent, output.slice(dirname(output).length + 1)), source)) throw Error('OVERLAPPING_PATHS');
    }
    const adapter: ReleaseAdapter = { snapshot: () => ({ revision: plan.revision, directory: source }), assertContentOnly: () => {} };
    report.reasons = sourceInventory(source, plan.revision);
    if (report.reasons.length) return report;
    const sourceMembers=plan.revision.members.map(m=>({path:m.path,mediaType:m.mediaType,bytes:m.bytes,sha256:m.sha256,executableMode:m.executableMode})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    const preservedCopy={sourceProjectUrl:plan.sourceProjectUrl,sourceMembersDigest:digest(JSON.stringify(sourceMembers))};
    const prepared = prepareReleaseBundle(adapter,preservedCopy);
    report.sourceMembers = sourceMembers;
    report.bundleDigest = prepared.bundleDigest;
    if (options.outputDir !== undefined) {
      const built = buildReleaseBundle(adapter, options.outputDir,preservedCopy);
      if (built.bundleDigest !== prepared.bundleDigest) throw Error('SOURCE_CHANGED');
      report.ok = true;
      // External sidecar; never add undeclared metadata to the bundle.
      writeFileSync(resolve(options.outputDir) + '.migration-report.json', JSON.stringify(report) + '\n', { flag: 'wx', mode: 0o600 });
    } else report.ok = true;
    return report;
  } catch (error) {
    // Do not emit thrown path, source bytes, or parser details.
    report.ok = false;
    report.bundleDigest = undefined;
    const code = error instanceof Error && /^(?:PLAN_INVALID|PROJECT_IDENTITY_MISMATCH|ARGUMENTS_INVALID|SOURCE_INVALID|PLAN_INSIDE_SOURCE|OVERLAPPING_PATHS|OUTPUT_EXISTS|SOURCE_CHANGED|SOURCE_LIMIT_EXCEEDED)$/.test(error.message) ? error.message : 'RELEASE_INCOMPATIBLE';
    report.reasons = [reason(code)];
    return report;
  }
}

function cli(args: string[]): void {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--source-dir','--plan-file','--output-dir','--dry-run'].includes(key) || flags.has(key)) { process.stdout.write(JSON.stringify({ ...base(), reasons: [reason('ARGUMENTS_INVALID')] }) + '\n'); process.exitCode = 1; return; }
    flags.set(key, key === '--dry-run' ? 'true' : args[++i]);
  }
  const result = migrate({ sourceDir: flags.get('--source-dir') ?? '', planFile: flags.get('--plan-file') ?? '', dryRun: flags.has('--dry-run'), outputDir: flags.get('--output-dir') });
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) cli(process.argv.slice(2));
