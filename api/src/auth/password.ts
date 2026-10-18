import { hash, verify } from '@node-rs/argon2';

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

/** Hashes with argon2id using the library defaults (19 MiB, 2 passes, 1 lane). */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * A valid hash to verify against when a username does not exist, so that
 * unknown users cost the same time as known ones.
 */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('dummy-password-used-only-for-timing');
  return dummyHash;
}
