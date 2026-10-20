import { randomBytes } from "crypto";
import { PASSKEY_CHALLENGE_TTL_SECONDS } from "./passkey-policy.service.ts";

/**
 * Server-side WebAuthn challenges (#223): random (32 bytes), single-use,
 * 5 minutes. Every ceremony's challenge is bound to what started it, by
 * its key:
 *
 * - `register:<sessionId>`: adding a passkey, bound to the signed-in
 *   session (and the account, checked again on use);
 * - `second_factor:<sessionId>`: the second login step, bound to the
 *   `pending` session;
 * - `sign_in:<sha256 of the bm_wa cookie>`: a passwordless sign-in, bound
 *   to a short random cookie only this browser holds.
 *
 * `take` removes the entry whatever happens next, so a challenge verifies
 * at most one response, right or wrong; an expired one is answered like a
 * missing one. A new challenge for the same key replaces the previous one.
 *
 * In memory and per replica, like the login and two-factor limiters: a
 * restart forgets every ceremony in progress (the user starts again), and
 * several replicas need sticky sessions for the dashboard, or a ceremony
 * started on one replica fails on another. Bounded (`maxEntries`): when
 * full, expired entries go first, then the oldest, so a flood of option
 * requests cannot grow memory without limit (it can only make other
 * ceremonies start again).
 */

/** What a challenge was issued for. */
export type ChallengePurpose = "register" | "second_factor" | "sign_in";

/** What a challenge carries besides its value. */
export interface ChallengeBinding {
  /** The account the ceremony is for; null for a passwordless sign-in (unknown yet). */
  userId: string | null;
  /** The new passkey's name (registration only). */
  name?: string;
}

/** A live challenge taken from the store. */
export interface TakenChallenge extends ChallengeBinding {
  /** The challenge, base64url, as it went into the options. */
  challenge: string;
}

/** A stored entry. */
interface Entry extends TakenChallenge {
  /** Epoch milliseconds after which the challenge is dead. */
  expiresAt: number;
}

/** The store's operations. */
export interface ChallengeStore {
  /** Mints a challenge for `purpose` and `bindingId`, replacing any earlier one; returns it. */
  issue(purpose: ChallengePurpose, bindingId: string, binding: ChallengeBinding): string;
  /** Removes and returns the live challenge, or null (none, or expired). */
  take(purpose: ChallengePurpose, bindingId: string): TakenChallenge | null;
  /** Live and expired entries held right now (tests). */
  size(): number;
  /** Forgets everything (tests). */
  clear(): void;
}

/** Options of a store; the defaults are the production values. */
export interface ChallengeStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/** The most challenges held at once, across every purpose. */
const DEFAULT_MAX_ENTRIES = 10_000;

/** Builds a store. One process-wide instance is exported below. */
export function createChallengeStore(
  options: ChallengeStoreOptions = {},
): ChallengeStore {
  const ttlMs = options.ttlMs ?? PASSKEY_CHALLENGE_TTL_SECONDS * 1000;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? ((): number => Date.now());
  const entries = new Map<string, Entry>();

  /** Makes room for one more entry: expired ones first, then the oldest. */
  function makeRoom(at: number): void {
    if (entries.size < maxEntries) return;
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(key);
    }
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
  }

  return {
    issue(purpose, bindingId, binding) {
      const key = `${purpose}:${bindingId}`;
      const at = now();
      /** Re-inserted, so the Map's order stays oldest first. */
      entries.delete(key);
      makeRoom(at);
      const challenge = randomBytes(32).toString("base64url");
      entries.set(key, { ...binding, challenge, expiresAt: at + ttlMs });
      return challenge;
    },
    take(purpose, bindingId) {
      const key = `${purpose}:${bindingId}`;
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      if (entry.expiresAt <= now()) return null;
      return { challenge: entry.challenge, userId: entry.userId, name: entry.name };
    },
    size: () => entries.size,
    clear: () => entries.clear(),
  };
}

/** The process-wide store every passkey ceremony uses. */
export const passkeyChallenges = createChallengeStore();
