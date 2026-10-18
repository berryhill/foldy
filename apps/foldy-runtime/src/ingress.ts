export type Ingress =
 | {mode:'dev';bind:'127.0.0.1'}
 | {mode:'proxy';origin:string;host:string;bind:'127.0.0.1'}
 | {mode:'direct';origin:string;host:string;bind:'0.0.0.0'};

/** Public identity is deployment configuration, never inferred from proxy headers. */
export function ingressConfig(env: NodeJS.ProcessEnv): Ingress {
 const proxy=env.FOLDY_PROXY_PUBLIC_ORIGIN;
 const rawDev=env.FOLDY_DEV_LOOPBACK;
 const dev=rawDev==='1';
 const key=env.FOLDY_TLS_KEY_FILE,cert=env.FOLDY_TLS_CERT_FILE,publicHost=env.FOLDY_PUBLIC_HOST;
 if(rawDev && rawDev!=='1' && rawDev!=='0')throw Error('CONFIG_INVALID');
 if(proxy!==undefined){
  if(!proxy||dev||key||cert)throw Error('CONFIG_INVALID');
  let url:URL;
  try{url=new URL(proxy);}catch{throw Error('CONFIG_INVALID');}
  if(url.protocol!=='https:'||url.origin!==proxy||url.href!==proxy+'/'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!validHost(url.hostname)||['localhost','127.0.0.1'].includes(url.hostname))throw Error('CONFIG_INVALID');
  if(publicHost && publicHost!==url.host)throw Error('CONFIG_INVALID');
  return {mode:'proxy',origin:proxy,host:url.host,bind:'127.0.0.1'};
 }
 if(dev){if(publicHost||key||cert)throw Error('CONFIG_INVALID');return {mode:'dev',bind:'127.0.0.1'};}
 if(!publicHost||!key||!cert)throw Error('CONFIG_REQUIRED');
 let url:URL;
 try{url=new URL('https://'+publicHost);}catch{throw Error('CONFIG_INVALID');}
 if(url.host!==publicHost||url.pathname!=='/'||url.search||url.hash||url.username||url.password||!validHost(url.hostname))throw Error('CONFIG_INVALID');
 return {mode:'direct',origin:url.origin,host:publicHost,bind:'0.0.0.0'};
}

function validHost(hostname:string):boolean {
 return hostname.length<=253 && hostname.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export function requestOrigin(ingress:Ingress,host:string|undefined):string|undefined {
 if(ingress.mode==='dev')return host&&/^127\.0\.0\.1:\d+$/.test(host)?'http://'+host:undefined;
 return host===ingress.host?ingress.origin:undefined;
}
