import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OwnerAuthority, type Grant } from './owner-authority.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const opaque = () => randomBytes(32).toString('base64url');
const scopes = ['foldy:read', 'foldy:draft:write'];
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
type Client = { client_id: string; redirect_uris: string[]; client_name: string; origin: string; expires: number };
type Authorization = { client: Client; redirect: string; resource: string; challenge: string; state?: string; scopes: string[]; expires: number; ownerVerifier: string; generation: number; continuation?: boolean };

// Native HTTP adapter: SDK 1.29's mcpAuthRouter requires Express and advertises
// refresh_token unconditionally. This runtime deliberately implements no refresh
// grants. Access-token verifier custody is the existing fsynced OwnerAuthority.
// Public registrations and pending transactions are bounded, process-local and
// lost on restart; existing access tokens remain durable until expiry/revocation.
export class McpOAuth {
  private clients = new Map<string, Client>();
  private pending = new Map<string, Authorization>();
  private codes = new Map<string, Authorization>();
  private sources = new Map<string, {count: number; expires: number}>();
  constructor(private authority: OwnerAuthority, private instanceId: string) {}
  private prefix(origin: string) { return `oauth:${hash(this.instanceId + '\n' + origin + '/mcp')}:`; }
  accepts(grant: Grant, origin: string) { return !grant.grantId.startsWith('oauth:') || grant.grantId.startsWith(this.prefix(origin)); }
  private json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, {'content-type':'application/json','cache-control':'no-store','pragma':'no-cache'}); res.end(JSON.stringify(value));
  }
  private page(res: ServerResponse, ticket: string, a: Authorization, recovery = false) {
    // Chromium derives form POST Origin from Referrer-Policy; no-referrer
    // produces Origin:null. same-origin suppresses external leakage while
    // preserving the exact-origin CSRF check for our consent form.
    res.setHeader('referrer-policy','same-origin');
    res.setHeader('content-security-policy',`default-src 'none'; form-action 'self' ${a.continuation ? '' : new URL(a.redirect).origin}; frame-ancestors 'none'; base-uri 'none'`);
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
    const content=a.continuation
      ? `<h1>Continue to owner authorization</h1><p>This request does not grant access. Continue in this browser to review permissions.</p>${recovery ? '<p>Owner access is not active. Open recovery in a new tab, then return here within five minutes. Recovery does not approve this request.</p><a href="/owner" target="_blank" rel="noopener noreferrer">Sign in or recover owner access</a>' : ''}<p><a href="/oauth/continue?ticket=${ticket}">Continue to authorization</a></p>`
      : `<h1>Authorize MCP client</h1><p>Client: ${escape(a.client.client_name)}</p><p>Redirect: ${escape(a.redirect)}</p><p>Resource: ${escape(a.resource)}</p><p>Permissions: ${escape(a.scopes.join(', '))}. No approval, publication, or owner administration.</p><form method="post" action="/oauth/consent"><input type="hidden" name="ticket" value="${ticket}"><button name="decision" value="allow">Authorize these permissions</button><button name="decision" value="deny">Deny</button></form>`;
    res.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Authorize MCP client</title><main>${content}</main></html>`);
  }
  private redirect(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 2048) return false;
    try { const u = new URL(value); return !u.hash && !u.username && !u.password && !u.searchParams.has('code') && !u.searchParams.has('state') && (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1','[::1]','localhost'].includes(u.hostname))); } catch { return false; }
  }
  private async input(req: IncomingMessage) {
    let size = 0; const parts: Buffer[] = [];
    for await (const p of req) { size += p.length; if (size > 16384) throw Error('invalid_request'); parts.push(p); }
    const raw = Buffer.concat(parts).toString('utf8');
    if (req.headers['content-type']?.split(';')[0] === 'application/json') {
      const v = JSON.parse(raw); if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('invalid_request'); return v;
    }
    if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') throw Error('invalid_request');
    return this.params(new URLSearchParams(raw));
  }
  private params(p: URLSearchParams): Record<string,string> {
    const v: Record<string,string> = Object.create(null);
    for (const [k,s] of p) { if (k in v) throw Error('invalid_request'); v[k] = s; } return v;
  }
  async route(req: IncomingMessage, res: ServerResponse, origin: string): Promise<boolean> {
    const u = new URL(req.url!, origin), path = u.pathname;
    if (!path.startsWith('/oauth/') && !path.startsWith('/.well-known/oauth-')) return false;
    const resource = origin + '/mcp';
    res.setHeader('referrer-policy','no-referrer');
    res.setHeader('cache-control','no-store'); res.setHeader('pragma','no-cache');
    try {
      if (req.headers.origin && req.headers.origin !== origin) { this.json(res,403,{error:'access_denied'}); return true; }
      if (req.method === 'GET' && (path === '/.well-known/oauth-protected-resource/mcp' || path === '/.well-known/oauth-protected-resource')) {
        this.json(res,200,{resource,authorization_servers:[origin],scopes_supported:scopes,bearer_methods_supported:['header']}); return true;
      }
      if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
        this.json(res,200,{issuer:origin,authorization_endpoint:origin+'/oauth/authorize',token_endpoint:origin+'/oauth/token',registration_endpoint:origin+'/oauth/register',revocation_endpoint:origin+'/oauth/revoke',response_types_supported:['code'],grant_types_supported:['authorization_code'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],revocation_endpoint_auth_methods_supported:['none'],scopes_supported:scopes}); return true;
      }
      if (!this.authority.state) { this.json(res,423,{error:'temporarily_unavailable'}); return true; }
      for (const map of [this.pending,this.codes,this.clients,this.sources]) for (const [key,v] of map) if (v.expires <= Date.now()) map.delete(key);
      if (path === '/oauth/register' && req.method === 'POST') {
        // Trust only the transport peer; forwarded headers are attacker-controlled.
        const source = req.socket.remoteAddress || 'unknown', now = Date.now();
        let budget = this.sources.get(source);
        if (!budget) { if (this.sources.size >= 1000) { this.json(res,429,{error:'temporarily_unavailable'}); return true; } budget={count:0,expires:now+60000}; this.sources.set(source,budget); }
        if (++budget.count > 20) { res.setHeader('retry-after',String(Math.ceil((budget.expires-now)/1000))); this.json(res,429,{error:'temporarily_unavailable'}); return true; }
        const v = await this.input(req);
        if (this.clients.size >= 1000) throw Error('temporarily_unavailable');
        if (!Array.isArray(v.redirect_uris) || !v.redirect_uris.length || v.redirect_uris.length > 8 || !v.redirect_uris.every((r: unknown)=>this.redirect(r)) || (v.token_endpoint_auth_method !== undefined && v.token_endpoint_auth_method !== 'none') || (v.grant_types !== undefined && (!Array.isArray(v.grant_types) || v.grant_types.length !== 1 || v.grant_types[0] !== 'authorization_code')) || (v.response_types !== undefined && (!Array.isArray(v.response_types) || v.response_types.length !== 1 || v.response_types[0] !== 'code')) || (v.client_name !== undefined && (typeof v.client_name !== 'string' || v.client_name.length > 100))) throw Error('invalid_client_metadata');
        const client: Client = {client_id:randomUUID(),redirect_uris:v.redirect_uris,client_name:v.client_name || 'MCP client',origin,expires:Date.now()+86400000}; this.clients.set(client.client_id,client);
        this.json(res,201,{client_id:client.client_id,client_id_issued_at:Math.floor(Date.now()/1000),client_registration_expires_at:Math.floor(client.expires/1000),client_name:client.client_name,redirect_uris:client.redirect_uris,token_endpoint_auth_method:'none',grant_types:['authorization_code'],response_types:['code']}); return true;
      }
      if (path === '/oauth/authorize' && req.method === 'GET') {
        const v = this.params(u.searchParams), client = this.clients.get(v.client_id);
        if (!client || client.origin !== origin) throw Error('invalid_client');
        if (!client.redirect_uris.includes(v.redirect_uri)) throw Error('invalid_request');
        if (v.resource !== resource) throw Error('invalid_target');
        if (v.response_type !== 'code' || v.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(v.code_challenge || '') || (v.state?.length ?? 0) > 2048) throw Error('invalid_request');
        const requested = v.scope === undefined ? ['foldy:read'] : v.scope.split(' ');
        if (!requested.includes('foldy:read') || requested.some(s=>!scopes.includes(s)) || new Set(requested).size !== requested.length) throw Error('invalid_scope');
        if (this.pending.size >= 1000) throw Error('temporarily_unavailable');
        const ticket = opaque(), owner = this.authority.state!;
        const a: Authorization = {client,redirect:v.redirect_uri,resource,challenge:v.code_challenge,state:v.state,scopes:requested,expires:Date.now()+300000,ownerVerifier:owner.ownerVerifier,generation:owner.generation,continuation:!this.authority.ownerCookie(req.headers.cookie)};
        this.pending.set(hash(ticket),a);
        this.page(res,ticket,a); return true;
      }
      if (path === '/oauth/continue' && req.method === 'GET') {
        const v=this.params(u.searchParams), key=hash(v.ticket || ''), a=this.pending.get(key);
        if (Object.keys(v).length !== 1 || !a || !a.continuation || a.resource !== resource) throw Error('invalid_request');
        if (!this.authority.ownerCookie(req.headers.cookie)) { this.page(res,v.ticket,a,true); return true; }
        // A URL ticket identifies a validated request, never an owner capability.
        // Consume it and bind a new consent-only ticket to the current owner session.
        this.pending.delete(key); const ticket=opaque(), owner=this.authority.state!;
        const consent={...a,continuation:false,ownerVerifier:owner.ownerVerifier,generation:owner.generation};
        this.pending.set(hash(ticket),consent); this.page(res,ticket,consent); return true;
      }
      if (path === '/oauth/consent' && req.method === 'POST') {
        if (req.headers.origin !== origin || !this.authority.ownerCookie(req.headers.cookie)) { this.json(res,403,{error:'access_denied'}); return true; }
        const v = await this.input(req), key = hash(typeof v.ticket === 'string' ? v.ticket : ''), a = this.pending.get(key), owner = this.authority.state!;
        if (!a || a.continuation || a.expires <= Date.now() || a.resource !== resource || a.ownerVerifier !== owner.ownerVerifier || a.generation !== owner.generation || !this.authority.ownerCookie(req.headers.cookie) || !['allow','deny'].includes(v.decision)) throw Error('invalid_request');
        this.pending.delete(key); const target = new URL(a.redirect);
        if (v.decision === 'allow') { if(this.codes.size >= 1000) throw Error('temporarily_unavailable'); const code = opaque(); this.codes.set(hash(code),{...a,expires:Date.now()+60000}); target.searchParams.set('code',code); } else target.searchParams.set('error','access_denied');
        if (a.state !== undefined) target.searchParams.set('state',a.state);
        res.writeHead(303,{location:target.href}); res.end(); return true;
      }
      if (path === '/oauth/token' && req.method === 'POST') {
        const v = await this.input(req);
        if (v.grant_type !== 'authorization_code') throw Error('unsupported_grant_type');
        const key = hash(typeof v.code === 'string' ? v.code : ''), a = this.codes.get(key), owner = this.authority.state!;
        if (!a || a.expires <= Date.now() || a.client.client_id !== v.client_id || a.client.origin !== origin || a.resource !== v.resource || a.resource !== resource || a.redirect !== v.redirect_uri || a.generation !== owner.generation || a.ownerVerifier !== owner.ownerVerifier || typeof v.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(v.code_verifier) || createHash('sha256').update(v.code_verifier).digest('base64url') !== a.challenge) throw Error('invalid_grant');
        this.codes.delete(key); const token = opaque();
        const grant: Grant = {grantId:this.prefix(origin)+a.client.client_id+':'+randomUUID(),verifier:hash(token),expiresAt:Date.now()+600000,scopes:a.scopes};
        this.authority.persist({...owner,grants:[...owner.grants.filter(g=>g.expiresAt>Date.now()),grant]});
        this.json(res,200,{access_token:token,token_type:'Bearer',expires_in:600,scope:a.scopes.join(' ')}); return true;
      }
      if (path === '/oauth/revoke' && req.method === 'POST') {
        const v = await this.input(req), owner = this.authority.state!;
        if (typeof v.token !== 'string' || typeof v.client_id !== 'string') throw Error('invalid_request');
        const prefix = this.prefix(origin)+v.client_id+':';
        this.authority.persist({...owner,grants:owner.grants.filter(g=>!(g.grantId.startsWith(prefix) && g.verifier === hash(v.token)))});
        this.json(res,200,{}); return true;
      }
      this.json(res,404,{error:'invalid_request'}); return true;
    } catch (e) { const error = e instanceof Error && /^(invalid_request|invalid_client_metadata|invalid_client|invalid_target|invalid_scope|invalid_grant|unsupported_grant_type|temporarily_unavailable)$/.test(e.message) ? e.message : 'invalid_request'; this.json(res,400,{error}); return true; }
  }
}
