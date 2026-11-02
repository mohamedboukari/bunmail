import { randomBytes } from "crypto";
import { logger } from "../utils/logger.ts";
import { sharedOneTimeStore, sharedStoreErrorCode } from "../utils/shared-store.ts";

/**
 * One-time secret reveal (#132, bound to its creator in #280).
 *
 * After the dashboard creates an API key or a webhook, the raw key or the
 * HMAC secret must be shown exactly once; so must an invitation link that
 * could not be emailed (#217), a password reset link (#277) and a fresh
 * set of TOTP recovery codes (#220). Putting it in the post-create
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
 * Storage (#185): in Redis when `REDIS_URL` is set, so the GET may land on
 * any replica (the Redis key is the token's SHA-256 and the secret is
 * encrypted there); else in process memory, for one replica. A Redis
 * failure fails closed: the secret is not shown (the operator revokes and
 * recreates), and the failure is logged.
 */

/** How long a reveal token stays redeemable. */
const REVEAL_TTL_MS = 60_000;

/** Hard cap so a burst of creates cannot grow the in-memory map without bound. */
const REVEAL_MAX_ENTRIES = 1000;

/**
 * What a reveal entry holds, and therefore which page may show it. An
 * `invite_link` (#217) is the accept link of an invitation whose email
 * did not go out, shown to the inviter on the Invitations page. A
 * `password_reset_link` (#277) is shown to the admin who issued it on the
 * Users page. `recovery_codes` (#220) are the TOTP recovery codes, one per
 * line, shown on the Two-factor page to the user and session that
 * enabled 2FA or regenerated them.
 */
export type RevealKind =
  "api_key" | "webhook_secret" | "invite_link" | "password_reset_link" | "recovery_codes";

/** The dashboard user and session a reveal belongs to (from `auth`, #222). */
export interface RevealOwner {
  /** `users.id` of the creator. */
  userId: string;
  /** `sessions.id` of the creating session; stable across token rotation. */
  sessionId: string;
}

const reveals = sharedOneTimeStore("reveal", REVEAL_MAX_ENTRIES);

/**
 * The binding a token is stored with: kind, user and session, as one
 * string compared for equality. IDs only, safe to log.
 */
function guardOf(kind: RevealKind, owner: RevealOwner): string {
  return JSON.stringify([kind, owner.userId, owner.sessionId]);
}

/** The IDs of a stored binding, for the refusal log line. */
function describeGuard(guard: string): Record<string, string | null> {
  const parsed: unknown = JSON.parse(guard);
  const at = (i: number): string | null =>
    Array.isArray(parsed) && typeof parsed[i] === "string" ? parsed[i] : null;
  return { entryKind: at(0), ownerUserId: at(1), ownerSessionId: at(2) };
}

/**
 * Stashes a one-time secret for `owner` and returns the opaque token to put
 * in the redirect URL: 32 random bytes in hex, redeemable once, for
 * {@link REVEAL_TTL_MS}, only on the page of `kind`, only by `owner`.
 * When the store fails, the token is still returned but redeems nothing
 * (fails closed, logged): the page then shows no secret.
 */
export async function stashRevealSecret(
  value: string,
  kind: RevealKind,
  owner: RevealOwner,
): Promise<string> {
  const token = randomBytes(32).toString("hex");
  try {
    await reveals.put(token, { guard: guardOf(kind, owner), value }, REVEAL_TTL_MS);
  } catch (error: unknown) {
    logger.error("One-time reveal could not be stored: the secret will not be shown", {
      kind,
      userId: owner.userId,
      sessionId: owner.sessionId,
      code: sharedStoreErrorCode(error),
    });
  }
  return token;
}

/**
 * Redeems a reveal token on the page of `kind` for `requester`. Returns the
 * secret and deletes the entry when the token is live and was created by
 * the same user and session for the same kind; otherwise `undefined`,
 * whatever the reason (unknown, expired, used, wrong page, someone else,
 * store failure), so the response reveals nothing. A mismatch keeps the
 * entry for its owner and logs a warning with IDs only.
 */
export async function consumeRevealSecret(
  token: string | undefined,
  kind: RevealKind,
  requester: RevealOwner,
): Promise<string | undefined> {
  if (!token) return undefined;
  let taken;
  try {
    taken = await reveals.take(token, guardOf(kind, requester));
  } catch (error: unknown) {
    logger.error("One-time reveal could not be read: the secret is not shown", {
      kind,
      userId: requester.userId,
      sessionId: requester.sessionId,
      code: sharedStoreErrorCode(error),
    });
    return undefined;
  }
  if (taken.status === "taken") return taken.value;
  if (taken.status === "mismatch") {
    logger.warn("One-time reveal refused: token presented by another session or page", {
      requesterUserId: requester.userId,
      requesterSessionId: requester.sessionId,
      expectedKind: kind,
      ...describeGuard(taken.guard),
    });
  }
  return undefined;
}
