#!/usr/bin/env node
// Run after package-scoped build and production dependency staging (see docs).
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildReleaseBundle } from '../dist/release-bundle.js';
import { digest } from '../dist/bundle.js';
const base = process.env.NODE_IMAGE;
if (!base || !/^node@sha256:[a-f0-9]{64}$/.test(base)) throw Error('PINNED_NODE_IMAGE_REQUIRED');
const dependencies = process.argv[2];
if (!dependencies) throw Error('PRODUCTION_DEPENDENCY_STAGE_REQUIRED');
const scratch = mkdtempSync(join(tmpdir(),'foldy-image-proof-'));
const app = resolve(import.meta.dirname,'..');
const tag = `foldy-local-proof:${process.pid}`;
try {
 const context = join(scratch,'context'); mkdirSync(context);
 const source = join(scratch,'source'); mkdirSync(source);
 const bytes = Buffer.from('<h1>Image packaging proof</h1>'); writeFileSync(join(source,'index.html'),bytes);
 const release = buildReleaseBundle({snapshot:()=>({directory:source,revision:{instanceId:'image_proof',projectId:'project_proof',workbookId:'workbook_proof',revisionId:'revision_proof',approvedRevisionId:'revision_proof',frozen:true,runtimeVersion:'0.1.0',runtimeImageDigest:base.slice(base.indexOf('@')+1),members:[{path:'index.html',mediaType:'text/html',bytes:bytes.length,sha256:digest(bytes),executableMode:0}]}}),assertContentOnly:()=>{}},join(context,'bundle'));
 cpSync(join(app,'dist'),join(context,'dist'),{recursive:true});
 cpSync(join(resolve(dependencies),'node_modules'),join(context,'node_modules'),{recursive:true,verbatimSymlinks:true});
 cpSync(join(app,'Dockerfile'),join(context,'Dockerfile'));
 cpSync(join(app,'Dockerfile.dockerignore'),join(context,'Dockerfile.dockerignore'));
 const config = join(scratch,'docker-config');mkdirSync(config);
 const docker=(args:string[])=>execFileSync('docker',['--config',config,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000});
 console.log(docker(['build','--build-arg',`NODE_IMAGE=${base}`,'-t',tag,context]));
 console.log(docker(['image','inspect',tag,'--format','{{.Id}} user={{.Config.User}}']));
 // Execute the real loader and dependency import, with no network or live service.
 const proof=`import {loadBundle} from './dist/bundle.js'; await import('@modelcontextprotocol/sdk/server/index.js'); const b=loadBundle('/opt/foldy/bundle','${release.bundleDigest}'); if(b.manifest.instanceId!=='image_proof'||process.getuid()!==1000)throw Error('PROOF_FAILED'); console.log('IMAGE_LOADER_NONROOT_PASS');`;
 console.log(docker(['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint','node',tag,'--input-type=module','-e',proof]));
 console.log(docker(['image','rm',tag]));
} finally { rmSync(scratch,{recursive:true,force:true}); }
