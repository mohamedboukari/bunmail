import { randomBytes } from "crypto";
import { logger } from "../utils/logger.ts";

/**
 * One-time secret reveal (#132, bound to its creator in #280).
 *
 * After the dashboard creates an API key or a webhook, the raw key or the
 * HMAC secret must be shown exactly once; so must an invitation link that
 * could not be emailed (#217). Putting it in the post-create
 * redirect URL would leak it into browser history, proxy access logs and
 * `Referer` headers, which would defeat the "shown once, stored hashed"
 * model. Instead it is stashed here under an opaque random token, only the
 * token goes in the URL, and the following GET redeems it once.
 *
 * Each entry is bound to what created it (#280): the kind of secret (so an
 * API-key token cannot be redeemed on the webhooks page, which members can
 * open) and the user and session that created it (so a token that leaks
 * through history, a shared screen or a proxy log is useless to anyone
 * else). A mismatched redemption answers exactly like an unknown token (no
 * oracle), is logged with IDs only, and does not consume the entry: whoever
 * presents a stolen token cannot destroy the creator's one-time view.
 *
 * Caveat (documented in SECURITY.md): the store is in memory and per
 * process. On a multi-replica deploy a create on one replica and the
 * follow-up GET on another miss the token; the operator then revokes and
 * recreates.
 */

/** How long a reveal token stays redeemable. */
const REVEAL_TTL_MS = 60_000;

/** Hard cap so a burst of creates cannot grow the map without bound. */
const REVEAL_MAX_ENTRIES = 1000;

/**
 * What a reveal entry holds, and therefore which page may show it. An
 * `invite_link` (#217) is the accept link of an invitation whose email
 * did not go out, shown to the inviter on the Invitations page.
 */
export type RevealKind = "api_key" | "webhook_secret" | "invite_link";

/** The dashboard user and session a reveal belongs to (from `auth`, #222). */
export interface RevealOwner {
  /** `users.id` of the creator. */
  userId: string;
  /** `sessions.id` of the creating session; stable across token rotation. */
  sessionId: string;
}

interface RevealEntry {
  /** The one-time secret (raw API key, webhook secret or invitation link). */
  value: string;
  /** The page that may show it. */
  kind: RevealKind;
  /** Who created it. */
  owner: RevealOwner;
  /** Unix epoch ms after which the entry is expired. */
  expiresAt: number;
}

const reveals = new Map<string, RevealEntry>();

/** Drops expired entries; a cheap lazy sweep run on each stash. */
function sweepExpired(now: number): void {
  for (const [token, entry] of reveals) {
    if (entry.expiresAt <= now) reveals.delete(token);
  }
}

/**
 * Stashes a one-time secret for `owner` and returns the opaque token to put
 * in the redirect URL: 32 random bytes in hex, redeemable once, for
 * {@link REVEAL_TTL_MS}, only on the page of `kind`, only by `owner`.
 */
export function stashRevealSecret(
  value: string,
  kind: RevealKind,
  owner: RevealOwner,
  now: number = Date.now(),
): string {
  sweepExpired(now);
  if (reveals.size >= REVEAL_MAX_ENTRIES) {
    /** Still at the cap after the sweep: evict the oldest insertion. */
    const oldest = reveals.keys().next().value;
    if (oldest !== undefined) reveals.delete(oldest);
  }
  const token = randomBytes(32).toString("hex");
  reveals.set(token, {
    value,
    kind,
    owner: { ...owner },
    expiresAt: now + REVEAL_TTL_MS,
  });
  return token;
}

/**
 * Redeems a reveal token on the page of `kind` for `requester`. Returns the
 * secret and deletes the entry when the token is live and was created by
 * the same user and session for the same kind; otherwise `undefined`,
 * whatever the reason (unknown, expired, used, wrong page, someone else),
 * so the response reveals nothing. A mismatch keeps the entry for its
 * owner and logs a warning with IDs only.
 */
export function consumeRevealSecret(
  token: string | undefined,
  kind: RevealKind,
  requester: RevealOwner,
  now: number = Date.now(),
): string | undefined {
  if (!token) return undefined;
  const entry = reveals.get(token);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    reveals.delete(token);
    return undefined;
  }
  const sameOwner =
    entry.owner.userId === requester.userId &&
    entry.owner.sessionId === requester.sessionId;
  if (entry.kind !== kind || !sameOwner) {
    logger.warn("One-time reveal refused: token presented by another session or page", {
      requesterUserId: requester.userId,
      requesterSessionId: requester.sessionId,
      ownerUserId: entry.owner.userId,
      ownerSessionId: entry.owner.sessionId,
      expectedKind: kind,
      entryKind: entry.kind,
    });
    return undefined;
  }
  reveals.delete(token);
  return entry.value;
}
