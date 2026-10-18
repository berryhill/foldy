import { ingressConfig } from '../src/ingress.js';

/** Example deployment-principal inputs; never put passwords or assertions here. */
export type ManualHostConfig = {
 publicOrigin: string;
 upstreamPort: number;
 bundleDirectory: string;
 bundleDigest: string;
 stateDirectory: string;
 bootstrapFile: string;
};

export function validateManualHostConfig(config: ManualHostConfig): void {
 const ingress=ingressConfig({FOLDY_PROXY_PUBLIC_ORIGIN:config.publicOrigin});
 if(ingress.mode!=='proxy'||!Number.isInteger(config.upstreamPort)||config.upstreamPort<1||config.upstreamPort>65535)throw Error('CONFIG_INVALID');
 if(!/^[0-9a-f]{64}$/.test(config.bundleDigest))throw Error('CONFIG_INVALID');
 for(const path of [config.bundleDirectory,config.stateDirectory,config.bootstrapFile]){
  if(!path.startsWith('/')||path.includes('\n')||path.includes('\r')||path.includes('\0'))throw Error('CONFIG_INVALID');
 }
 if(config.bundleDirectory===config.stateDirectory||config.stateDirectory.startsWith(config.bundleDirectory+'/')||config.bootstrapFile.startsWith(config.bundleDirectory+'/'))throw Error('CONFIG_INVALID');
}

// The deployment principal must separately validate ownership, file permissions,
// exact manifest bytes, bundle members, state persistence and bootstrap custody.
// This shape check does not create a service or attest that a proxy is safe.
