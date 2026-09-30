/** Process-wide Argon2 admission. Non-owner traffic cannot consume the reserved owner-change slot. */
export type Argon2Lane = 'viewer' | 'owner-login' | 'owner-change';
const active: Record<Argon2Lane, number> = { viewer: 0, 'owner-login': 0, 'owner-change': 0 };
const perLane: Record<Argon2Lane, number> = { viewer: 2, 'owner-login': 2, 'owner-change': 1 };

export function argon2Available(lane: Argon2Lane): boolean {
  const total = active.viewer + active['owner-login'] + active['owner-change'];
  return active[lane] < perLane[lane] && total < (lane === 'owner-change' ? 4 : 3);
}

/** Reserve synchronously before scheduling native work; release exactly once in finally. */
export function reserveArgon2(lane: Argon2Lane): () => void {
  if (!argon2Available(lane)) throw new Error('VERIFIER_UNAVAILABLE');
  active[lane]++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active[lane]--;
  };
}
