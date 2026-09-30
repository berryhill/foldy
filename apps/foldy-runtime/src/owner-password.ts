import * as crypto from 'node:crypto';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { reserveArgon2 } from './argon2-budget.js';

// Node 24.15 provides this API; repository @types/node predates its addition.
const { argon2 } = crypto as unknown as { argon2: (algorithm: 'argon2id', options: { message: Buffer; nonce: Buffer; memory: number; passes: number; parallelism: number; tagLength: number }, callback: (error: Error | null, result: Buffer) => void) => void };

export interface OwnerPasswordVerifier { algorithm: 'argon2id'; salt: string; hash: string }

/** Exact UTF-8, measured in Unicode scalar values. Neither trim nor normalize. */
export function validateOwnerPassword(value: unknown): value is string {
  return typeof value === 'string' && Buffer.from(value, 'utf8').toString('utf8') === value
    && Array.from(value).length >= 12 && Array.from(value).length <= 128;
}

const hex = (value: unknown, bytes: number): value is string => typeof value === 'string' && new RegExp(`^[a-f0-9]{${bytes * 2}}$`).test(value);
const validVerifier = (value: unknown): value is OwnerPasswordVerifier => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<OwnerPasswordVerifier>;
  return v.algorithm === 'argon2id' && hex(v.salt, 16) && hex(v.hash, 32);
};

async function derive(password: string, salt: string, lane: 'owner' | 'verify'): Promise<Buffer> {
  const release = reserveArgon2(lane === 'owner' ? 'owner-change' : 'owner-login');
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      argon2('argon2id', { message: Buffer.from(password, 'utf8'), nonce: Buffer.from(salt, 'hex'), memory: 65536, passes: 3, parallelism: 1, tagLength: 32 },
        (error, result) => error ? reject(new Error('VERIFIER_UNAVAILABLE')) : resolve(result));
    });
  } catch {
    throw new Error('VERIFIER_UNAVAILABLE');
  } finally {
    release();
  }
}

/** Library primitive only: caller must supply owner authority and private custody. */
export async function deriveOwnerPassword(password: unknown): Promise<OwnerPasswordVerifier> {
  if (!validateOwnerPassword(password)) throw new Error('PASSWORD_POLICY');
  const salt = randomBytes(16).toString('hex');
  return { algorithm: 'argon2id', salt, hash: (await derive(password, salt, 'owner')).toString('hex') };
}

export async function verifyOwnerPassword(password: unknown, verifier: unknown): Promise<boolean> {
  if (!validVerifier(verifier)) throw new Error('VERIFIER_UNAVAILABLE');
  if (!validateOwnerPassword(password)) return false;
  const salt = verifier.salt, expected = Buffer.from(verifier.hash, 'hex');
  const actual = await derive(password, salt, 'verify');
  return timingSafeEqual(actual, expected);
}
