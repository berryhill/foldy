import { operatorTransport } from './operator-transport.js';

const [operation, request] = process.argv.slice(2);
if (!['dry-run','configure','start','status','watch'].includes(operation || '') || !request || process.argv.length !== 4) {
 process.stderr.write('TRANSPORT_USAGE_INVALID\n'); process.exitCode = 2;
} else {
 try {
  let running=true,last='';
  process.once('SIGTERM',()=>{running=false;});process.once('SIGINT',()=>{running=false;});
  do{
   try{
    const result=await operatorTransport(operation==='watch'?'status':operation as 'dry-run'|'configure'|'start'|'status',request);
    const summary={state:result?.state||(operation==='dry-run'?'validated':'configured'),observedAt:result?.observedAt||null};
    if(operation!=='watch'||summary.state!==last)process.stdout.write(JSON.stringify(summary)+'\n');
    last=summary.state;
   }catch(error){
    if(operation!=='watch')throw error;
    const code=error instanceof Error&&/^TRANSPORT_[A-Z_]+$/.test(error.message)?error.message:'TRANSPORT_UNREADY';
    if(last!==code)process.stderr.write(code+'\n');last=code;
   }
   if(operation==='watch'&&running)await new Promise(resolve=>setTimeout(resolve,10000));
  }while(operation==='watch'&&running);
 } catch (error) {
  const code = error instanceof Error && /^TRANSPORT_[A-Z_]+$/.test(error.message) ? error.message : 'TRANSPORT_UNREADY';
  process.stderr.write(code+'\n'); process.exitCode = 1;
 }
}
