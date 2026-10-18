import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, type MigrationPlan } from '../dist/migrate.js';
import { digest, loadBundle } from '../dist/bundle.js';
import { Domain } from '../dist/domain.js';

function fixture(fn: (f: { root: string; source: string; output: string; plan: MigrationPlan; save: () => void }) => void) {
  const root = mkdtempSync(join(tmpdir(), 'foldy-migrate-'));
  const source = join(root, 'source'), output = join(root, 'output');
  mkdirSync(source);
  const html = Buffer.from('<link rel="stylesheet" href="style.css"><h1>Original</h1>');
  const css = Buffer.from('h1 { color: navy; }');
  writeFileSync(join(source, 'index.html'), html); writeFileSync(join(source, 'style.css'), css);
  const plan: MigrationPlan = {
    schemaVersion: 'foldy-preserved-copy-plan.v1',
    sourceProjectUrl: 'https://example.invalid/projects/original_project',
    provenance: 'Owner-reviewed archive download, extracted to immutable content-only directory',
    revision: { instanceId: 'original_instance', projectId: 'original_project', workbookId: 'original_workbook', revisionId: 'frozen_revision', approvedRevisionId: 'frozen_revision', frozen: true, runtimeVersion: '0.1.0', runtimeImageDigest: 'sha256:' + 'a'.repeat(64), members: [
      { path: 'index.html', mediaType: 'text/html', bytes: html.length, sha256: digest(html), executableMode: 0 },
      { path: 'style.css', mediaType: 'text/css', bytes: css.length, sha256: digest(css), executableMode: 0 },
    ] },
  };
  const save = () => writeFileSync(join(root, 'plan.json'), JSON.stringify(plan));
  save();
  try { fn({ root, source, output, plan, save }); } finally { rmSync(root, { recursive: true, force: true }); }
}
function codes(f: {root:string;source:string;output:string}, dryRun = true) {
  return migrate({ sourceDir: f.source, planFile: join(f.root, 'plan.json'), dryRun, outputDir: dryRun ? undefined : f.output }).reasons.map(r => r.code);
}
test('dry run produces deterministic report and no output state; actual bundle has loader parity and external provenance', () => fixture(f => {
  const before = [readFileSync(join(f.source, 'index.html')), readFileSync(join(f.source, 'style.css'))];
  const a = migrate({ sourceDir: f.source, planFile: join(f.root, 'plan.json'), dryRun: true });
  const b = migrate({ sourceDir: f.source, planFile: join(f.root, 'plan.json'), dryRun: true });
  assert.deepEqual(a, b); assert.equal(a.ok, true); assert.equal(existsSync(f.output), false);
  const result = migrate({ sourceDir: f.source, planFile: join(f.root, 'plan.json'), outputDir: f.output });
  assert.equal(result.ok, true); assert.equal(result.bundleDigest, a.bundleDigest);
  const loaded=loadBundle(f.output,result.bundleDigest!);
  assert.ok(loaded.files.has('runtime-migration.json'));
  const domain=new Domain(join(f.root,'content.sqlite'),loaded);
  assert.equal(domain.requiresAccessConfiguration(),true,'migration must not implicitly publish private content after claim');
  assert.equal(new Domain(join(f.root,'content.sqlite'),loaded).requiresAccessConfiguration(),true);
  domain.confirmAccessConfiguration({id:'owner',owner:true,scopes:[]});
  assert.equal(new Domain(join(f.root,'content.sqlite'),loaded).requiresAccessConfiguration(),false,'restart does not reset explicitly chosen access');
  assert.equal(result.sourceProjectUrl, f.plan.sourceProjectUrl);
  assert.deepEqual(loadBundle(f.output, result.bundleDigest!).files.get('index.html')?.bytes, before[0]);
  assert.deepEqual(JSON.parse(readFileSync(f.output + '.migration-report.json', 'utf8')), result);
  assert.deepEqual(readFileSync(join(f.source, 'index.html')), before[0]);
  assert.deepEqual(readFileSync(join(f.source, 'style.css')), before[1]);
  assert.deepEqual(codes(f, false), ['OUTPUT_EXISTS']);
}));
const inertBlock = '<script type="application/json" id="discovery-render-state">\n{"projectId":"4eaa3bbc-793a-4ad8-b26b-b02f8775f618","text":"quoted \\"text\\"","reference":"url(https://example.invalid/inert)"}\n</script>';
test('legacy discovery JSON data block is preserved byte-for-byte through dry run and release loader', () => fixture(f => {
  const html = Buffer.from(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"></head><body><h1>Original</h1>` + inertBlock + '</body></html>');
  writeFileSync(join(f.source, 'index.html'), html);
  Object.assign(f.plan.revision.members[0], { bytes: html.length, sha256: digest(html) }); f.save();
  assert.deepEqual(codes(f), []);
  const result = migrate({ sourceDir: f.source, planFile: join(f.root, 'plan.json'), outputDir: f.output });
  assert.equal(result.ok, true);
  assert.deepEqual(loadBundle(f.output, result.bundleDigest!).files.get('index.html')!.bytes, html);
  assert.deepEqual(readFileSync(join(f.source, 'index.html')), html);
}));
for (const block of [
  '<script>alert(1)</script>',
  '<script type="application/json" src="local.json">{}</script>',
  '<script type="application/json" onclick="alert(1)">{}</script>',
  '<script type="application/json" nonce="x">{}</script>',
  '<script type="application/json" type="text/javascript">{}</script>',
  '<script type=application/json>{}</script>',
  '<script type="application/json">{broken}</script>',
  '<script type="application/json">{"x":"</script><script>alert(1)</script>"}</script>',
  '<script type="application/json">{"x":"<!--<script>"}</script>',
  '<script type="application/json">{}</script bogus>',
  '<script type="application/json"/>{}</script>',
  '<svg><script type="application/json">{}</script></svg>',
  '<textarea><script type="application/json">{}</script></textarea>',
  '<script type="application/json">{}</script><img src="missing.png">',
]) test('migration rejects unsafe/ambiguous JSON block: ' + block, () => fixture(f => {
  const html = Buffer.from(block); writeFileSync(join(f.source, 'index.html'), html);
  Object.assign(f.plan.revision.members[0], { bytes: html.length, sha256: digest(html) }); f.save();
  assert.equal(migrate({ sourceDir: f.source, planFile: join(f.root, 'plan.json'), outputDir: f.output }).ok, false);
  assert.equal(existsSync(f.output), false);
}));
test('unsupported script, missing asset, wrong hash and dependency are reported without creating output', () => fixture(f => {
  const html = Buffer.from('<script src="script.js"></script>');
  writeFileSync(join(f.source, 'index.html'), html); f.plan.revision.members[0].bytes = html.length; f.plan.revision.members[0].sha256 = digest(html); f.save();
  assert.ok(codes(f).includes('UNSUPPORTED_ACTIVE_CONTENT'));
  rmSync(join(f.source, 'style.css')); assert.ok(codes(f).includes('MISSING_ASSET'));
  writeFileSync(join(f.source, 'style.css'), 'wrong'); assert.ok(codes(f).includes('HASH_MISMATCH'));
  assert.equal(existsSync(f.output), false);
}));
test('overlapping target and plan identity mismatch fail closed', () => fixture(f => {
  assert.deepEqual(migrate({ sourceDir: f.source, planFile: join(f.root, 'plan.json'), outputDir: join(f.source, 'child') }).reasons.map(r => r.code), ['OVERLAPPING_PATHS']);
  f.plan.sourceProjectUrl = 'https://example.invalid/projects/other'; f.save();
  assert.ok(codes(f).includes('PROJECT_IDENTITY_MISMATCH'));
  assert.equal(existsSync(f.output), false);
}));
test('real CLI dry run, immutable inventory ordering and denied arguments never create target',()=>fixture(f=>{
  const cli=fileURLToPath(new URL('../dist/migrate.js',import.meta.url));
  const args=['--source-dir',f.source,'--plan-file',join(f.root,'plan.json'),'--dry-run'];
  const first=spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});assert.equal(first.status,0);const a=JSON.parse(first.stdout);assert.equal(a.ok,true);
  f.plan.revision.members.reverse();f.save();
  const second=spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});assert.equal(second.status,0);assert.deepEqual(JSON.parse(second.stdout),a);
  const denied=spawnSync(process.execPath,[cli,...args,'--output-dir',f.output],{encoding:'utf8'});assert.equal(denied.status,1);assert.equal(JSON.parse(denied.stdout).ok,false);
  assert.equal(migrate({sourceDir:f.source,planFile:join(f.root,'plan.json')}).ok,false);
  assert.equal(existsSync(f.output),false);
}));
test('dangling sidecar symlink and oversized source are denied before target creation',()=>fixture(f=>{
  symlinkSync(join(f.root,'absent'),f.output+'.migration-report.json');assert.deepEqual(codes(f,false),['OUTPUT_EXISTS']);assert.equal(existsSync(f.output),false);
  rmSync(f.output+'.migration-report.json');
  const huge=Buffer.alloc(8*1024*1024+1,32);writeFileSync(join(f.source,'style.css'),huge);f.plan.revision.members[1].bytes=huge.length;f.plan.revision.members[1].sha256=digest(huge);f.save();
  assert.ok(codes(f,false).includes('SOURCE_LIMIT_EXCEEDED'));assert.equal(existsSync(f.output),false);
}));
