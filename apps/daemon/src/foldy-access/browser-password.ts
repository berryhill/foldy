import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import {
  constants,
} from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import {
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import path from 'node:path';

const COOKIE_NAME = 'foldy_browser_session';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES = 5;
const MAX_THROTTLE_BUCKETS = 10_000;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 1_024;
const SCRYPT = Object.freeze({ N: 16_384, r: 8, p: 1, keyLength: 32 });

interface PersistedBrowserPassword {
  schemaVersion: 1;
  enabled: true;
  scrypt: typeof SCRYPT;
  salt: string;
  passwordHash: string;
  sessionKey: string;
}

interface FailureBucket {
  count: number;
  startedAt: number;
}

export interface BrowserPasswordAccess {
  status(req: Request): { enabled: boolean; authenticated: boolean };
  configure(password: string): Promise<void>;
  disable(): Promise<void>;
  unlock(req: Request, password: string): Promise<
    | { ok: true; cookie: string }
    | { ok: false; status: 401 | 429; retryAfterSeconds?: number }
  >;
  logoutCookie(req: Request): Promise<string>;
  isAuthorized(req: Request): boolean;
  acceptsPasswordTransport(req: Request): boolean;
  isAdministrativeRequest(req: Request): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeBase64(value: unknown, bytes: number): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.byteLength === bytes ? decoded : null;
}

function parsePersisted(value: unknown): PersistedBrowserPassword {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.enabled !== true || !isRecord(value.scrypt)
    || value.scrypt.N !== SCRYPT.N || value.scrypt.r !== SCRYPT.r || value.scrypt.p !== SCRYPT.p
    || value.scrypt.keyLength !== SCRYPT.keyLength || !decodeBase64(value.salt, 16)
    || !decodeBase64(value.passwordHash, SCRYPT.keyLength) || !decodeBase64(value.sessionKey, 32)) {
    throw new Error('Foldy browser-password state is corrupt or unsupported');
  }
  return value as unknown as PersistedBrowserPassword;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split('%', 1)[0];
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
}

function requestIsSecure(req: Request): boolean {
  return req.secure || req.protocol === 'https';
}

function requestOrigin(req: Request): string | null {
  const host = req.get('host');
  if (!host) return null;
  return `${requestIsSecure(req) ? 'https' : 'http'}://${host}`;
}

function isSameOrigin(req: Request): boolean {
  const supplied = req.get('origin');
  if (!supplied) return true; // Non-browser local clients have no Origin header.
  const expected = requestOrigin(req);
  if (!expected) return false;
  try {
    return new URL(supplied).origin === new URL(expected).origin;
  } catch {
    return false;
  }
}

function cookieValue(req: Request, name: string): string | null {
  const raw = req.get('cookie');
  if (!raw) return null;
  for (const pair of raw.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0 || pair.slice(0, index).trim() !== name) continue;
    const value = pair.slice(index + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

function constantTimeEqual(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

async function passwordDigest(password: string, salt: Buffer): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, SCRYPT.keyLength, {
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      maxmem: 64 * 1024 * 1024,
    }, (error, derivedKey) => error ? reject(error) : resolve(derivedKey));
  });
}

async function atomicWritePrivateJson(directory: string, target: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Foldy browser-password storage directory is unsafe');
  }
  const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const openedStat = await directoryHandle.stat();
  if (openedStat.dev !== directoryStat.dev || openedStat.ino !== directoryStat.ino) {
    await directoryHandle.close();
    throw new Error('Foldy browser-password storage directory changed identity');
  }
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let temporaryHandle: FileHandle | undefined;
  try {
    temporaryHandle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await temporaryHandle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await temporaryHandle.sync();
    const currentDirectoryStat = await lstat(directory);
    const currentDescriptorStat = await directoryHandle.stat();
    if (currentDirectoryStat.isSymbolicLink() || currentDirectoryStat.dev !== openedStat.dev
      || currentDirectoryStat.ino !== openedStat.ino || currentDescriptorStat.dev !== openedStat.dev
      || currentDescriptorStat.ino !== openedStat.ino) {
      throw new Error('Foldy browser-password storage directory changed before commit');
    }
    await rename(temporary, target);
    await chmod(target, 0o600);
    await directoryHandle.sync();
  } finally {
    await temporaryHandle?.close();
    await rm(temporary, { force: true });
    await directoryHandle.close();
  }
}

function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new RangeError(`password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`);
  }
}

export async function createBrowserPasswordAccess(options: {
  dataRoot: string;
  now?: () => number;
}): Promise<BrowserPasswordAccess> {
  if (!path.isAbsolute(options.dataRoot)) throw new Error('Foldy browser-password dataRoot must be absolute');
  const now = options.now ?? Date.now;
  const directory = path.join(path.resolve(options.dataRoot), 'foldy-access');
  const statePath = path.join(directory, 'browser-password.json');
  let state: PersistedBrowserPassword | null;
  try {
    state = parsePersisted(JSON.parse(await readFile(statePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') state = null;
    else throw error;
  }
  const failures = new Map<string, FailureBucket>();
  let mutation = Promise.resolve();

  const persist = async (next: PersistedBrowserPassword | null): Promise<void> => {
    const task = mutation.then(async () => {
      if (next) await atomicWritePrivateJson(directory, statePath, next);
      else {
        await rm(statePath, { force: true });
        const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
          .catch(() => null);
        await directoryHandle?.sync();
        await directoryHandle?.close();
      }
      state = next;
    });
    mutation = task.catch(() => undefined);
    await task;
  };

  const sessionCookie = (req: Request, token: string, maxAge: number): string => {
    const attributes = [
      `${COOKIE_NAME}=${token}`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      `Max-Age=${maxAge}`,
    ];
    if (requestIsSecure(req)) attributes.push('Secure');
    return attributes.join('; ');
  };

  const createSession = (): string => {
    if (!state) throw new Error('browser password is disabled');
    const payload = Buffer.from(JSON.stringify({ exp: now() + SESSION_MAX_AGE_SECONDS * 1000, nonce: randomBytes(16).toString('base64url') }))
      .toString('base64url');
    const signature = createHmac('sha256', Buffer.from(state.sessionKey, 'base64')).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  };

  const isAuthorized = (req: Request): boolean => {
    if (!state) return false;
    const token = cookieValue(req, COOKIE_NAME);
    if (!token) return false;
    const separator = token.indexOf('.');
    if (separator < 1 || token.indexOf('.', separator + 1) !== -1) return false;
    const payload = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    const expected = createHmac('sha256', Buffer.from(state.sessionKey, 'base64')).update(payload).digest();
    let actual: Buffer;
    try { actual = Buffer.from(signature, 'base64url'); } catch { return false; }
    if (!constantTimeEqual(actual, expected)) return false;
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
      return isRecord(parsed) && typeof parsed.exp === 'number' && Number.isSafeInteger(parsed.exp) && parsed.exp > now();
    } catch {
      return false;
    }
  };

  const peerKey = (req: Request): string => req.socket?.remoteAddress ?? 'unknown';
  const currentFailure = (key: string): FailureBucket | null => {
    const bucket = failures.get(key);
    if (!bucket) return null;
    if (now() - bucket.startedAt >= FAILURE_WINDOW_MS) {
      failures.delete(key);
      return null;
    }
    return bucket;
  };
  const retryAfter = (bucket: FailureBucket): number => Math.max(1, Math.ceil((FAILURE_WINDOW_MS - (now() - bucket.startedAt)) / 1000));

  return {
    status(req) {
      return { enabled: state !== null, authenticated: state !== null && isAuthorized(req) };
    },
    async configure(password) {
      validatePassword(password);
      const salt = randomBytes(16);
      const passwordHash = await passwordDigest(password, salt);
      await persist({
        schemaVersion: 1,
        enabled: true,
        scrypt: SCRYPT,
        salt: salt.toString('base64'),
        passwordHash: passwordHash.toString('base64'),
        sessionKey: randomBytes(32).toString('base64'),
      });
      failures.clear();
    },
    async disable() {
      await persist(null);
      failures.clear();
    },
    async unlock(req, password) {
      if (!state) return { ok: false, status: 401 };
      const key = peerKey(req);
      const bucket = currentFailure(key);
      if (bucket && bucket.count >= MAX_FAILURES) {
        return { ok: false, status: 429, retryAfterSeconds: retryAfter(bucket) };
      }
      const supplied = typeof password === 'string' && password.length <= PASSWORD_MAX_LENGTH
        ? await passwordDigest(password, Buffer.from(state.salt, 'base64'))
        : randomBytes(SCRYPT.keyLength);
      if (!constantTimeEqual(supplied, Buffer.from(state.passwordHash, 'base64'))) {
        const next = bucket ?? { count: 0, startedAt: now() };
        next.count += 1;
        failures.set(key, next);
        if (failures.size > MAX_THROTTLE_BUCKETS) failures.delete(failures.keys().next().value!);
        if (next.count >= MAX_FAILURES) {
          return { ok: false, status: 429, retryAfterSeconds: retryAfter(next) };
        }
        return { ok: false, status: 401 };
      }
      failures.delete(key);
      return { ok: true, cookie: sessionCookie(req, createSession(), SESSION_MAX_AGE_SECONDS) };
    },
    async logoutCookie(req) {
      return sessionCookie(req, '', 0);
    },
    isAuthorized,
    acceptsPasswordTransport(req) {
      return requestIsSecure(req) || isLoopbackAddress(req.socket?.remoteAddress);
    },
    isAdministrativeRequest(req) {
      return isLoopbackAddress(req.socket?.remoteAddress) && isSameOrigin(req);
    },
  };
}

function bodyPassword(req: Request): string | null {
  return isRecord(req.body) && typeof req.body.password === 'string' ? req.body.password : null;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function accessError(res: Response, status: number, code: string, message: string): void {
  noStore(res);
  res.status(status).json({ error: { code, message } });
}

export function registerBrowserPasswordAccessRoutes(app: Express, access: BrowserPasswordAccess): void {
  // Bootstrap parsing stays before the gate, but is intentionally tiny.
  app.use(
    ['/api/foldy-access/unlock', '/api/foldy-access/password'],
    express.json({ limit: '2kb', strict: true }),
  );
  app.get('/api/foldy-access/status', (req, res) => {
    noStore(res);
    res.json(access.status(req));
  });

  app.post('/api/foldy-access/unlock', async (req, res) => {
    if (!access.acceptsPasswordTransport(req)) {
      accessError(res, 403, 'FOLDY_ACCESS_SECURE_TRANSPORT_REQUIRED', 'password submission requires HTTPS or a loopback connection');
      return;
    }
    if (!isSameOrigin(req)) {
      accessError(res, 403, 'FOLDY_ACCESS_ORIGIN_REJECTED', 'cross-origin request rejected');
      return;
    }
    const password = bodyPassword(req);
    if (password === null) {
      accessError(res, 400, 'FOLDY_ACCESS_INVALID_REQUEST', 'password must be a string');
      return;
    }
    const result = await access.unlock(req, password);
    if (!result.ok) {
      if (result.retryAfterSeconds) res.setHeader('Retry-After', String(result.retryAfterSeconds));
      accessError(
        res,
        result.status,
        result.status === 429 ? 'FOLDY_ACCESS_THROTTLED' : 'FOLDY_ACCESS_INVALID_PASSWORD',
        result.status === 429 ? 'too many failed unlock attempts' : 'password was not accepted',
      );
      return;
    }
    noStore(res);
    res.setHeader('Set-Cookie', result.cookie);
    res.status(204).end();
  });

  app.post('/api/foldy-access/logout', async (req, res) => {
    if (!isSameOrigin(req)) {
      accessError(res, 403, 'FOLDY_ACCESS_ORIGIN_REJECTED', 'cross-origin request rejected');
      return;
    }
    if (!access.isAuthorized(req)) {
      accessError(res, 401, 'FOLDY_ACCESS_AUTHENTICATION_REQUIRED', 'current browser session is required');
      return;
    }
    noStore(res);
    res.setHeader('Set-Cookie', await access.logoutCookie(req));
    res.status(204).end();
  });

  app.put('/api/foldy-access/password', async (req, res) => {
    if (!access.isAdministrativeRequest(req)) {
      accessError(res, 403, 'FOLDY_ACCESS_ADMIN_LOCAL_ONLY', 'password administration requires a loopback same-origin request');
      return;
    }
    if (access.status(req).enabled && !access.isAuthorized(req)) {
      accessError(res, 401, 'FOLDY_ACCESS_AUTHENTICATION_REQUIRED', 'current browser session is required');
      return;
    }
    const password = bodyPassword(req);
    try {
      if (password === null) throw new RangeError('password must be a string');
      await access.configure(password);
    } catch (error) {
      if (error instanceof RangeError) {
        accessError(res, 400, 'FOLDY_ACCESS_INVALID_PASSWORD', error.message);
        return;
      }
      throw error;
    }
    noStore(res);
    res.status(204).end();
  });

  app.delete('/api/foldy-access/password', async (req, res) => {
    if (!access.isAdministrativeRequest(req)) {
      accessError(res, 403, 'FOLDY_ACCESS_ADMIN_LOCAL_ONLY', 'password administration requires a loopback same-origin request');
      return;
    }
    if (!access.status(req).enabled || !access.isAuthorized(req)) {
      accessError(res, 401, 'FOLDY_ACCESS_AUTHENTICATION_REQUIRED', 'current browser session is required');
      return;
    }
    await access.disable();
    noStore(res);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.status(204).end();
  });
}

function isExemptPath(req: Request): boolean {
  const pathname = req.path;
  return pathname === '/api/health' || pathname === '/health'
    || pathname === '/api/version' || pathname === '/version'
    || pathname === '/api/ready' || pathname === '/ready'
    || pathname === '/api/foldy-access/status'
    || pathname === '/api/foldy-access/unlock'
    || pathname === '/api/foldy-access/logout'
    || pathname === '/api/foldy-access/password'
    || pathname === '/api/foldy/mcp'
    || pathname === '/api/foldy/mcp/health'
    || pathname === '/api/foldy/mcp/session'
    || pathname === '/api/foldy/mcp/resources'
    || pathname === '/api/foldy/mcp/resources/read'
    || /^\/api\/foldy\/mcp\/operations\/[^/]+$/.test(pathname);
}

export function installBrowserPasswordGate(access: BrowserPasswordAccess): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!access.status(req).enabled || isExemptPath(req) || access.isAuthorized(req)) {
      next();
      return;
    }
    const acceptsHtml = !req.path.startsWith('/api/')
      && (req.get('accept') ?? '').split(',').some((value) => value.trim().startsWith('text/html'));
    if (acceptsHtml) {
      noStore(res);
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      res.status(401).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unlock OpenDesign</title><style>body{font:16px system-ui;max-width:28rem;margin:12vh auto;padding:1rem}label,input,button{display:block;width:100%;box-sizing:border-box}input,button{font:inherit;padding:.7rem;margin-top:.5rem}p{color:#555}</style></head>
<body><main><h1>Unlock OpenDesign</h1><p>This OpenDesign browser is protected by a shared password.</p>
<form id="unlock"><label>Password<input name="password" type="password" required autofocus autocomplete="current-password"></label><button type="submit">Unlock</button><p id="error" role="alert"></p></form></main>
<script>document.getElementById('unlock').addEventListener('submit',async function(event){event.preventDefault();var error=document.getElementById('error');error.textContent='';var response=await fetch('/api/foldy-access/unlock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:new FormData(event.target).get('password')})});if(response.ok){location.reload();return}error.textContent=response.status===429?'Too many attempts. Try again later.':'Password was not accepted.'})</script></body></html>`);
      return;
    }
    accessError(res, 401, 'FOLDY_ACCESS_AUTHENTICATION_REQUIRED', 'shared browser password required');
  };
}
