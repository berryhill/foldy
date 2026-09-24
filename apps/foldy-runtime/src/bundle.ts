import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
export const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export interface Member { path:string; mediaType:string; bytes:number; sha256:string; executableMode:number }
export interface Manifest { schemaVersion:string; instanceId:string; projectId:string; workbookId:string; revisionId:string; runtimeImageDigest:string; members:Member[] }
export function safePath(p: string): boolean { return typeof p==='string' && /^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(p) && !p.split('/').some(s=>s==='..'||s==='.'||s==='') && !p.split('/').some(s=>s.startsWith('.')); }
export const policyPath = 'runtime-policy.json';
export function policyBytes(protectedPaths: readonly string[]): Buffer {
 const bytes=Buffer.from(JSON.stringify({schemaVersion:'foldy-runtime-policy.v1',protectedPaths})+'\n');
 parsePolicy({bytes,mediaType:'application/json'});return bytes;
}
export function parsePolicy(member?:{bytes:Buffer;mediaType:string}): readonly string[] {
 if(!member)return Object.freeze([]);
 try {
 const p=JSON.parse(member.bytes.toString('utf8'));
 if(member.mediaType!=='application/json'||!p||Array.isArray(p)||Object.keys(p).length!==2||p.schemaVersion!=='foldy-runtime-policy.v1'||!Array.isArray(p.protectedPaths)||p.protectedPaths.length>1024||p.protectedPaths.some((v:unknown)=>typeof v!=='string'||!safePath(v)||['__proto__','constructor','prototype','manifest.json'].includes(v))||new Set(p.protectedPaths).size!==p.protectedPaths.length)throw Error();
 return Object.freeze([...p.protectedPaths].sort());
 }catch{throw Error('POLICY_INVALID');}
}
/** Snapshot verified bytes, not mutable paths; nothing is read from disk while serving. */
export function loadBundle(directory:string,expected:string) {
 const root=resolve(directory); if(realpathSync(root)!==root||lstatSync(root).isSymbolicLink())throw Error('BUNDLE_INVALID');
 const diskFiles:string[]=[];
 function walk(dir:string,prefix=''){for(const name of readdirSync(dir)){const p=join(dir,name),rel=prefix+name,s=lstatSync(p);if(s.isSymbolicLink())throw Error('BUNDLE_INVALID');if(s.isDirectory())walk(p,rel+'/');else if(s.isFile())diskFiles.push(rel);else throw Error('BUNDLE_INVALID');}}
 walk(root);
 const raw=readFileSync(join(root,'manifest.json'));if(raw.length>1024*1024||digest(raw)!==expected)throw Error('BUNDLE_INVALID');
 const m=JSON.parse(raw.toString()) as Manifest;
 if(m.schemaVersion!=='foldy-release-bundle.v1'||!Array.isArray(m.members)||m.members.length>1024||!/^sha256:[a-f0-9]{64}$/.test(m.runtimeImageDigest))throw Error('BUNDLE_INVALID');
 for(const key of ['instanceId','projectId','workbookId','revisionId'] as const)if(typeof m[key]!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(m[key]))throw Error('BUNDLE_INVALID');
 if(Object.keys(m).some(k=>!['schemaVersion','instanceId','projectId','workbookId','revisionId','runtimeImageDigest','members'].includes(k)))throw Error('BUNDLE_INVALID');
 const files=new Map<string,{bytes:Buffer;mediaType:string}>();let total=0;
 for(const f of m.members){
 if(Object.keys(f).some(k=>!['path','mediaType','bytes','sha256','executableMode'].includes(k))||!safePath(f.path)||f.path==='manifest.json'||files.has(f.path)||f.executableMode!==0||!['text/html','text/css','text/plain','application/json','image/png','image/jpeg','image/webp','font/woff2'].includes(f.mediaType)||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>8*1024*1024)throw Error('BUNDLE_INVALID');
 const p=join(root,f.path),s=lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o111)!==0)throw Error('BUNDLE_INVALID');
 const b=readFileSync(p);total+=b.length;if(total>32*1024*1024||b.length!==f.bytes||digest(b)!==f.sha256)throw Error('BUNDLE_INVALID');files.set(f.path,{bytes:b,mediaType:f.mediaType});
 }
 if(!files.has('index.html')||diskFiles.some(p=>p!=='manifest.json'&&!files.has(p)))throw Error('BUNDLE_INVALID');
 return {manifest:m,files,bundleDigest:expected,protectedPaths:parsePolicy(files.get(policyPath))};
}
