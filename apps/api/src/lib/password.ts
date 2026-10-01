// Password hashing: argon2id, OWASP parameters (m=19 MiB, t=2, p=1), verified in docs/compatibility.md.
import argon2 from 'argon2';

export const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Staff passwords: 12–128 characters (argon2 cost makes very long inputs a DoS vector). */
export const STAFF_PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/** false for a wrong password and for a malformed hash (never throws on bad input). */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
