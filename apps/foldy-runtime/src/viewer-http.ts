import { createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ViewerAccess, type AccessChange } from './viewer-access.js';

const COOKIE = '__Host-foldy-viewer';
export function viewerCookie(req: IncomingMessage): string | undefined {
  const values = (req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(COOKIE + '='));
  return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0].slice(COOKIE.length + 1)) ? values[0].slice(COOKIE.length + 1) : undefined;
}
/** Bounded, per-instance ingress budget; forwarded headers never select a bucket.
 * Keyed hashes are process-local and never logged or persisted as raw addresses. */
export function sourceLimiter(clock = Date.now, capacity = 1024, budget = 20) {
  const key = randomBytes(32);
  const buckets = new Map<string, { until: number; count: number }>();
  return async (source: string): Promise<boolean> => {
    const now = clock();
    for (const [id, b] of buckets) if (b.until <= now) buckets.delete(id);
    const id = createHmac('sha256', key).update(source).digest('hex');
    let b = buckets.get(id);
    if (!b) {
      if (buckets.size >= capacity) return false;
      b = { until: now + 60000, count: 0 }; buckets.set(id, b);
    }
    return ++b.count <= budget;
  };
}
function reply(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function input(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json' || req.headers['content-encoding']) throw Error('REQUEST_INVALID');
  const parts: Buffer[] = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 4096) throw Error('REQUEST_INVALID');
    parts.push(part);
  }
  const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('REQUEST_INVALID');
  return value;
}
export async function viewerRoute(req: IncomingMessage, res: ServerResponse, path: string, origin: string, access: ViewerAccess, owner: (req: IncomingMessage) => boolean, configured?: () => void): Promise<boolean> {
  if (!['/api/viewer-access', '/api/owner/viewer-access', '/api/viewer/unlock', '/api/viewer/logout'].includes(path)) return false;
  res.setHeader('cache-control', 'no-store');
  if (path === '/api/viewer-access' && req.method === 'GET') { reply(res, 200, await access.status()); return true; }
  if (path === '/api/owner/viewer-access' && !owner(req)) { reply(res, 401, { code: 'OWNER_REQUIRED' }); return true; }
  if (path === '/api/owner/viewer-access' && req.method === 'GET') { reply(res, 200, await access.status()); return true; }
  if (req.method !== 'POST' || path === '/api/viewer-access') { reply(res, 405, { code: 'METHOD_INVALID' }); return true; }
  if (req.headers.origin !== origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) { reply(res, 403, { code: 'ORIGIN_INVALID' }); return true; }
  const value = await input(req);
  if (path === '/api/owner/viewer-access') {
    if (value.mode === 'password_required' ? Object.keys(value).length !== 2 || typeof value.password !== 'string' : value.mode !== 'public' || Object.keys(value).length !== 2 || value.confirmDisable !== true) throw Error('REQUEST_INVALID');
    const allowed = value.mode === 'password_required' ? ['mode', 'password'] : ['mode', 'confirmDisable'];
    if (Object.keys(value).some(k => !allowed.includes(k))) throw Error('REQUEST_INVALID');
    const receipt = await access.configure(req, value as AccessChange);
    configured?.();
    reply(res, 200, receipt);
  } else if (path === '/api/viewer/unlock') {
    if (Object.keys(value).length !== 1 || typeof value.password !== 'string') throw Error('REQUEST_INVALID');
    const source = req.socket.remoteAddress;
    if (!source) { reply(res, 403, { code: 'AUTH_INVALID' }); return true; }
    const result = await access.unlock(value.password, source);
    if (!result.ok) { reply(res, result.code === 'RATE_LIMITED' ? 429 : result.code === 'ACCESS_UNAVAILABLE' ? 503 : 401, { code: result.code }); return true; }
    res.setHeader('set-cookie', `${COOKIE}=${result.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200`);
    reply(res, 200, { unlocked: true, role: 'VIEWER' });
  } else {
    if (Object.keys(value).length) throw Error('REQUEST_INVALID');
    await access.logout(viewerCookie(req) ?? '');
    res.setHeader('set-cookie', `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
    reply(res, 200, { revoked: true });
  }
  return true;
}
