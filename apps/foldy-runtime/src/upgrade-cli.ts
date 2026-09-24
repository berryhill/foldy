import { readFileSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { protectedAncestry } from './owner-authority.js';
import { executeUpgrade } from './upgrade.js';
// Explicit private request file is local OS-operator authorization, not a remote owner API.
try {
 if(process.argv.length!==3)throw Error();
 const path=resolve(process.argv[2]);protectedAncestry(dirname(path),true);
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 let input;
 try{const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid?.()||(s.mode&0o077)||s.size>16384)throw Error();input=JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
 const fields=['stateDirectory','incumbent','candidate','expectedGeneration','operationId','confirmation','dataCompatibility','kind'];
 if(!input||Object.keys(input).length!==fields.length||fields.some(k=>!Object.hasOwn(input,k)))throw Error();
 const a=executeUpgrade(input);console.log(JSON.stringify({status:'activated-offline-release',generation:a.generation,bundleDigest:a.current.digest,operationId:a.operationId,snapshotDigest:a.snapshotDigest,providerImageReplaced:false}));
}catch{console.error(JSON.stringify({code:'UPGRADE_DENIED',remediation:'Inspect current activation and lock; never blindly retry or remove a live lock.'}));process.exitCode=1;}