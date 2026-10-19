import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { basename } from 'node:path';

export type TransportProcess = { pid:number; startTime:string; executable:string };
export type ProcessProbe = (pid:number)=>TransportProcess|null;
export const observationAgeMs=90_000;
export const futureSkewMs=5_000;

/** Kernel identity, not a recorded PID alone. Unsupported hosts remain unverified. */
export const liveTransportProcess:ProcessProbe=(pid)=>{
 try{
  if(process.platform!=='linux'||!Number.isSafeInteger(pid)||pid<=0)return null;
  process.kill(pid,0);
  const directory=`/proc/${pid}`;
  if(lstatSync(directory).uid!==process.getuid?.())return null;
  const executable=readlinkSync(directory+'/exe');
  if(!/^tunnel-client(?:-runtime(?:-cloudflared)?)?$/.test(basename(executable)))return null;
  const raw=readFileSync(directory+'/stat','utf8');
  if(raw.length>8192)return null;
  const end=raw.lastIndexOf(')');
  if(end<0)return null;
  const fields=raw.slice(end+2).trim().split(/\s+/);
  const startTime=fields[22-3];
  if(fields[0]==='Z'||!startTime||!/^\d+$/.test(startTime))return null;
  return {pid,startTime,executable};
 }catch{return null;}
};

export type TransportObservation={
 schemaVersion:'foldy-transport-evidence.v2';tunnelId:string;alias:string;
 pid:number;startTime:string;executable:string;observedAt:number;pollAt:number;
 state:'healthy'|'ready-poll-confirmed';
};

export function validObservation(value:unknown,tunnelId:string,alias:string,now=Date.now(),probe:ProcessProbe=liveTransportProcess):TransportObservation|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const e=value as Record<string,unknown>;
 if(Object.keys(e).sort().join(',')!=='alias,executable,observedAt,pid,pollAt,schemaVersion,startTime,state,tunnelId'||e.schemaVersion!=='foldy-transport-evidence.v2'||e.tunnelId!==tunnelId||e.alias!==alias||!['healthy','ready-poll-confirmed'].includes(String(e.state)))return null;
 if(!Number.isSafeInteger(e.pid)||Number(e.pid)<=0||typeof e.startTime!=='string'||!/^\d+$/.test(e.startTime)||typeof e.executable!=='string'||!e.executable.startsWith('/'))return null;
 if(!Number.isSafeInteger(e.observedAt)||!Number.isSafeInteger(e.pollAt))return null;
 const observedAt=Number(e.observedAt),pollAt=Number(e.pollAt);
 if(observedAt<1||pollAt<0||observedAt>now+futureSkewMs||pollAt>observedAt+futureSkewMs||now-observedAt>observationAgeMs)return null;
 if(e.state==='ready-poll-confirmed'&&(pollAt<1||now-pollAt>observationAgeMs))return null;
 const live=probe(Number(e.pid));
 if(!live||live.pid!==e.pid||live.startTime!==e.startTime||live.executable!==e.executable)return null;
 return e as TransportObservation;
}
