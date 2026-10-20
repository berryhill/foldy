import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const css = `:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#29271f;background:#f7f5ef}*{box-sizing:border-box}body{margin:0}header{background:#fffdf8;border-bottom:1px solid #dedacf;padding:16px clamp(20px,4vw,56px);display:flex;align-items:center;justify-content:space-between;gap:24px}header strong{font-family:Georgia,serif;font-size:27px;color:#442e29}nav{display:flex;flex-wrap:wrap;gap:20px}a{color:#824635;text-underline-offset:4px}nav a{font-weight:650;min-height:44px;display:inline-flex;align-items:center}nav a[aria-current]{text-decoration-thickness:3px}main{max-width:1100px;margin:auto;padding:clamp(24px,5vw,64px) 20px}.eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:12px;font-weight:700;color:#805f4a}h1,h2{font-family:Georgia,serif;line-height:1.13}h1{font-size:clamp(38px,6vw,68px);margin:12px 0 18px}h2{font-size:clamp(23px,3vw,34px)}p,li{line-height:1.65}.lead{font-size:19px;max-width:680px;color:#554f46}.panel{background:#fffdf8;border:1px solid #dfd9c9;border-radius:16px;padding:clamp(20px,3vw,32px);margin:22px 0}.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;counter-reset:step}.steps section{background:#fffdf8;border:1px solid #dfd9c9;border-radius:14px;padding:20px;min-width:0}.steps section:before{counter-increment:step;content:'0' counter(step);color:#925339;font-weight:700;letter-spacing:.12em}.steps h2{font-size:24px;margin:10px 0}.actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.button,button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 16px;border-radius:8px;border:1px solid #844c38;background:#844c38;color:white;font:inherit;font-weight:650;cursor:pointer;text-decoration:none}.button.secondary,button.secondary{background:transparent;color:#713d2c}.button:hover,button:hover{filter:brightness(.9)}:focus-visible{outline:3px solid #1e62aa;outline-offset:3px}dl{display:grid;grid-template-columns:minmax(110px,1fr) 2fr;gap:10px;overflow-wrap:anywhere}dt{font-weight:700}dd{margin:0}article{border-top:1px solid #dedacf;padding:16px 0}small,.muted{color:#5f594f}code{overflow-wrap:anywhere}iframe{display:block;width:100%;height:76vh;min-height:420px;border:1px solid #dedacf;background:white}#status{min-height:24px;color:#713d2c}#private[hidden]{display:none}@media(max-width:500px){header{align-items:flex-start;flex-direction:column}nav{gap:12px}dl{grid-template-columns:1fr}main{padding-top:28px}}`;

const connectScript = String.raw`
const status=document.querySelector('#status'),privateArea=document.querySelector('#private'),transport=document.querySelector('#transport');
const setStatus=text=>{status.textContent=text;};
const clearPrivate=()=>{privateArea.hidden=true;privateArea.replaceChildren();};
let refreshGeneration=0;
const add=(parent,tag,text)=>{const node=document.createElement(tag);node.textContent=text;parent.append(node);return node;};
const request=async(path,options={},generation=refreshGeneration)=>{const response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options});if(generation!==refreshGeneration)return null;if(response.status===401){refreshGeneration++;clearPrivate();setStatus('Sign in as owner to authorize and view connection activity.');return null;}if(!response.ok)throw Error('REQUEST_FAILED');const value=await response.json();return generation===refreshGeneration?value:null;};
const copy=(parent,label,value)=>{const button=add(parent,'button',label);button.type='button';button.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(value);setStatus(label+' copied.');}catch{setStatus('Copy was not available in this browser.');}});};
copy(document.querySelector('#owner-entry'),'Copy invitation setup URL',new URL('/owner/setup',location.origin).href);
copy(document.querySelector('#owner-entry'),'Copy ChatGPT setup link','https://chatgpt.com/plugins');
async function refresh(){
 const generation=++refreshGeneration,current=()=>generation===refreshGeneration;
 clearPrivate();setStatus('Checking connection availability…');
 try{
  const publicStatus=await request('/api/connect',{},generation);if(!current())return;
  if(!publicStatus)throw Error('REQUEST_FAILED');
  transport.textContent=publicStatus.transport==='unconfigured'?'Connection unavailable. The deploying operator must make the secure connection available before ChatGPT can reach this Foldy. You can still review the steps below.':publicStatus.transport==='ready-poll-confirmed'?'Tunnel process healthy, ready and recently polled the control plane. This does not verify your ChatGPT account or a successful Foldy read.':publicStatus.transport==='healthy'?'Tunnel process is healthy, but a recent successful control-plane poll is still required before connection readiness can be confirmed.':'Connection configured, but transport readiness and ChatGPT installation are not verified.';
  const detail=await request('/api/connect/status',{},generation);if(!current())return;
  if(!detail){setStatus('Sign in as owner to authorize and view connection activity.');return;}
  const tunnel=await request('/api/connect/tunnel',{},generation);if(!current())return;
  if(!tunnel)return;
  const manifest=await request('/mcp/manifest.json',{},generation);if(!current())return;
  if(!manifest)return;
  privateArea.hidden=false;
  add(privateArea,'h2','Your Foldy connection');
  const facts=add(privateArea,'dl','');
  for(const [label,value] of [['Instance',manifest.instanceId],['Project',manifest.projectId],['Workbook',manifest.workbookId],['Published revision',manifest.currentPublishedRevisionId]]){add(facts,'dt',label);add(facts,'dd',String(value));}
  if(tunnel.tunnelId){add(privateArea,'p','Connection Tunnel ID (not proof of reachability): '+tunnel.tunnelId);copy(privateArea,'Copy tunnel ID',tunnel.tunnelId);}
  else add(privateArea,'p','No Connection Tunnel ID is configured. Ask the deploying operator to enable the connection; do not create a tunnel or API key yourself.');
  if(detail.observedAt)add(privateArea,'p','Transport observation: '+new Date(detail.observedAt).toLocaleString()+' · '+detail.transport+'. This is not ChatGPT account verification.');
  else if(detail.errorCode)add(privateArea,'p','Transport status: '+detail.errorCode+'. Ask the deploying operator to check the tunnel.');
  const endpoint=new URL(manifest.endpoint,location.origin).href;
  add(privateArea,'p','Local/private MCP endpoint (not a ChatGPT-reachable address): '+endpoint);
  copy(privateArea,'Copy private MCP endpoint',endpoint);
  const readPrompt='Using this Foldy plugin, call get_project and list_pages (read only). Expect instance '+manifest.instanceId+', project '+manifest.projectId+', workbook '+manifest.workbookId+'. Report page paths and observedRevisionId; compare with published revision '+manifest.currentPublishedRevisionId+'. Stop if identity differs. Do not create or edit anything. Call get_workbook only if workbook.json is present.';
  const draftPrompt='Using this Foldy plugin for project '+manifest.projectId+', first read the latest published revision. Ask me which change I want, then create an isolated update proposal using the current revision and idempotency keys. Only use foldy:draft:write if explicitly authorized. Submit the exact proposal for owner review and report its update ID. Do not approve, publish or change reader access.';
  add(privateArea,'h3','Try a read first');add(privateArea,'p',readPrompt);copy(privateArea,'Copy read-only test prompt',readPrompt);
  const permission=add(privateArea,'label','Optional: show draft proposal instructions'),draft=document.createElement('input');draft.type='checkbox';permission.prepend(draft);
  const proposal=add(privateArea,'div','');proposal.hidden=true;
  add(proposal,'p','Request foldy:read and foldy:draft:write in ChatGPT and check both on the Foldy OAuth consent. This switch only shows guidance; it never changes a grant. Reconnect with the intended scopes if your current grant is read-only.');
  add(proposal,'p',draftPrompt);copy(proposal,'Copy draft proposal prompt',draftPrompt);
  draft.addEventListener('change',()=>{proposal.hidden=!draft.checked;});
  add(privateArea,'p','After expiry or revocation, reconnect from ChatGPT and authorize again. There are no refresh tokens. A restart retains grant expiry and recorded activity but ends MCP sessions; retry the read to establish a new session.');
  add(privateArea,'h2','Connection activity');
  if(!detail.grants.length)add(privateArea,'p','No assistant grants recorded. Connecting in ChatGPT is not yet verified.');
  for(const grant of detail.grants){
   const row=add(privateArea,'article','');
   add(row,'strong',grant.kind+' grant · '+grant.grantId);
   add(row,'p','Scopes: '+grant.scopes.join(', ')+' · Expires: '+new Date(grant.expiresAt).toLocaleString()+' · '+(grant.active?'Active':'Expired'));
   add(row,'p',grant.lastSuccessfulReadAt?'Successful MCP read: '+new Date(grant.lastSuccessfulReadAt).toLocaleString():'No successful MCP read recorded.');
   add(row,'p',grant.lastSuccessfulDraftAt?'Successful draft action: '+new Date(grant.lastSuccessfulDraftAt).toLocaleString():'No successful draft action recorded.');
   add(row,'p','MCP activity does not independently verify the ChatGPT account or plugin identity. Compare the read result in ChatGPT with this Foldy.');
   const revoke=add(row,'button','Revoke this grant');revoke.type='button';revoke.className='secondary';revoke.addEventListener('click',async()=>{if(!confirm('Revoke this grant and terminate its sessions?'))return;try{const result=await request('/api/mcp-grants/revoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grantId:grant.grantId})});if(result){await refresh();setStatus('Grant revoked.');}else setStatus('Owner session ended. Sign in again.');}catch{setStatus('Could not revoke. Refresh and check the current state.');}});
  }
  setStatus('Owner connection activity loaded. Refresh after trying a read in ChatGPT.');
 }catch{if(!current())return;clearPrivate();transport.textContent='Connection unavailable. Retry, or ask the deploying operator to check this Foldy.';setStatus('Could not check the connection.');}
}
document.querySelector('#retry').addEventListener('click',refresh);refresh();
`;

function html(kind:'root'|'connect', nonce:string, allowed:boolean):string {
 const nav=`<nav aria-label="Foldy navigation"><a href="/"${kind==='root'?' aria-current="page"':''}>Read Foldy</a><a href="/connect"${kind==='connect'?' aria-current="page"':''}>Connect ChatGPT</a><a href="/owner">Updates / Review</a></nav>`;
 const content=kind==='root'
  ? `<p class="eyebrow">Published Foldy</p><h1>Your Foldy, in one place.</h1><p class="lead">Read the published version below. Connect ChatGPT to work with it, or open Updates / Review to decide what readers see next.</p>${allowed?'<iframe title="Published Foldy" src="/_document/index.html" sandbox="" referrerpolicy="no-referrer"></iframe>':'<div class="panel"><h2>Reading is locked</h2><p>No published content is loaded until viewing access is granted.</p><a class="button" href="/unlock">Unlock this Foldy</a></div>'}`
  : `<p class="eyebrow">Foldy · Assistant connection</p><h1>Bring your Foldy into ChatGPT.</h1><p class="lead">Connect to the published Foldy, verify a real read, then decide whether to allow draft proposals. Only an owner can approve or publish.</p><div class="panel"><h2>Owner access</h2><p>New owner? <a href="/owner/setup">Open invitation setup</a> to use a separately delivered one-use key, or request ownership of this browser. A browser request stays pending until the deploying operator independently confirms the exact reference in a supported secure decision UI. The reference is only a lookup, never proof of identity or authority. After approval, choose your own password in this browser. The generic setup URL alone grants no access.</p><p>Already an owner? <a href="/owner">Sign in to the owner workspace</a> with the password you chose. A configured password alone does not establish who chose it.</p><p>Invalid or expired key? Ask the deploying operator for a new protected invitation. There is no public issuer; secure delivery of the key is separate. The viewing password does not restore ownership.</p><div id="owner-entry" class="actions"></div></div><div class="panel"><h2>Connection status</h2><p id="transport">Checking connection availability…</p><button id="retry" type="button" class="secondary">Retry connection check</button><p id="status" role="status" aria-live="polite">Loading…</p><a href="/owner" class="button">Sign in to authorize and view connection activity</a></div><div class="steps"><section><h2>1 · Connect</h2><p><a href="https://chatgpt.com/plugins" target="_blank" rel="noopener noreferrer">Open ChatGPT Plugins</a>. Choose Add custom MCP server and Connection Tunnel if your account supports it. Select an available tunnel for this workspace or enter the actual tunnel ID shown below after owner sign-in. No tunnel-specific setup link is available here. See the <a href="https://developers.openai.com/api/docs/guides/secure-mcp-tunnels" target="_blank" rel="noopener noreferrer">official Secure MCP Tunnels guide</a>. Availability depends on your account and workspace policy.</p></section><section><h2>2 · Authorize</h2><p>Choose OAuth and complete the Foldy owner authorization in this same browser. Review the requested scopes and risk warning. Read-only is the default; allow draft proposals only if you intend to propose changes for review.</p></section><section><h2>3 · Verify</h2><p>Create as a plugin, inspect and install it. In a new conversation, use @ to select the plugin, then ask it to read the Foldy project and list pages. After owner sign-in, compare the returned identity and published revision in Your Foldy connection below. Installing alone does not prove a read.</p></section><section><h2>4 · Iterate</h2><p>Ask questions against the published pages. With explicit draft authority, request a proposal; drafts cannot approve or publish themselves. Review changes in Updates / Review.</p></section><section><h2>5 · Manage</h2><p>Refresh activity to see actual successful MCP reads, draft actions, scopes and expiry. Revoke a grant here if access should end. A successful MCP call is not independent proof of which ChatGPT account used it.</p></section></div><section id="private" class="panel" hidden></section>`;
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${kind==='root'?'Read':'Connect ChatGPT'} · Foldy</title><style nonce="${nonce}">${css}</style></head><body><header><strong>Foldy</strong>${nav}</header><main>${content}${kind==='connect'?'<noscript>Enable JavaScript to check current availability and authenticated activity. No connection has been verified by this page.</noscript>':''}</main>${kind==='connect'?`<script nonce="${nonce}" src="/connect/app.js" defer></script>`:''}</body></html>`;
}

export function clientUiRoute(req:IncomingMessage,res:ServerResponse,path:string,rootAccess?:'allowed'|'locked'|'unavailable'):boolean {
 if(!['/','/connect','/connect/app.js'].includes(path))return false;
 if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return true;}
 const script=path==='/connect/app.js';const nonce=randomBytes(24).toString('base64');
 res.setHeader('cache-control','no-store');res.setHeader('referrer-policy','no-referrer');
 res.setHeader('content-security-policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
 res.setHeader('content-type',script?'text/javascript; charset=utf-8':'text/html; charset=utf-8');
 const status=path==='/'?rootAccess==='unavailable'?423:rootAccess==='locked'?401:200:200;
 res.writeHead(status);res.end(req.method==='HEAD'?undefined:script?connectScript:html(path==='/'?'root':'connect',nonce,rootAccess==='allowed'));return true;
}
