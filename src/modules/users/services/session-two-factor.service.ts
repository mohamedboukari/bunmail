import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { withSanitizedErrors } from "../errors.ts";
import { sessions } from "../models/session.schema.ts";
import { users } from "../models/user.schema.ts";
import { userCredentials } from "../models/user-credential.schema.ts";
import type {
  DbExecutor,
  PendingSession,
  RotatedSession,
  Tx,
} from "../types/user.types.ts";
import { SESSION_ABSOLUTE_SECONDS } from "./session-policy.service.ts";
import { hashToken, mintToken } from "./token.service.ts";
import { liveSession, seconds, slidingExpiry } from "./session-predicates.service.ts";

/**
 * Session steps of the second factor (#220, #223) and of linking an SSO
 * identity (#224): the pending session, its lock and elevation, the live
 * session lock, the enrolment secret and the raise to `mfa`. The public
 * surface is `session.service.ts`.
 */

/* ─── Two-factor sign-in and enrolment (#220) ─── */

/**
 * Finds the `pending` session a presented cookie token belongs to (#220):
 * the second login step's only way in. Current token only (a pending
 * session never rotates), unexpired (10 minutes from the password step),
 * user enabled. `null` for everything else, a full session included.
 */
export async function findPendingSession(token: string): Promise<PendingSession | null> {
  const [row] = await withSanitizedErrors(() =>
    db
      .select({
        sessionId: sessions.id,
        userId: sessions.userId,
        email: users.email,
        ssoProvider: userCredentials.provider,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .leftJoin(
        userCredentials,
        and(
          eq(userCredentials.id, sessions.credentialId),
          eq(userCredentials.type, "oauth"),
        ),
      )
      .where(
        and(
          eq(sessions.tokenHash, hashToken(token)),
          eq(sessions.assurance, "pending"),
          sql`${sessions.expiresAt} > now()`,
          sql`${users.disabledAt} IS NULL`,
        ),
      )
      .limit(1),
  );
  return row ?? null;
}

/**
 * Locks a still-pending session for the second login step (#220), inside
 * the caller's transaction: the row must still carry the presented token,
 * be `pending` and unexpired, and its user enabled. `SELECT ... FOR
 * UPDATE`, so of two requests completing the same pending session the
 * second waits, then sees it is no longer pending and gets `false`.
 */
export async function lockPendingSession(
  tx: Tx,
  sessionId: string,
  presentedToken: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.tokenHash, hashToken(presentedToken)),
        eq(sessions.assurance, "pending"),
        sql`${sessions.expiresAt} > now()`,
        sql`${users.disabledAt} IS NULL`,
      ),
    )
    .for("update", { of: sessions });
  return rows.length > 0;
}

/**
 * Locks a live session of a user inside the caller's transaction (#224,
 * linking an SSO identity): the row must be the user's, unexpired, admit
 * the dashboard (`password` without a second factor, or `mfa`, the guard's
 * own rule) and its user enabled. `SELECT ... FOR UPDATE`, so a logout or
 * revocation racing the caller waits for it, and one that committed first
 * makes this `false`.
 */
export async function lockLiveSession(
  tx: Tx,
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.userId, userId),
        liveSession(),
        sql`${users.disabledAt} IS NULL`,
      ),
    )
    .for("update", { of: sessions });
  return rows.length > 0;
}

/**
 * Completes a pending session after its second factor (#220), inside the
 * caller's transaction (which holds the row lock from
 * `lockPendingSession`): assurance `mfa`, a fresh token, and the normal
 * lifetimes from here on (`expires_at` = the idle timeout, capped at
 * `created_at` + 7 days, `created_at` being the password step).
 *
 * The pending token is dead at once: it is not kept as the previous
 * token (no grace) nor recorded in `session_token_history`, since it
 * never opened anything and must not open the full session either.
 *
 * @returns the new token and the cookie lifetime left until the cap.
 */
export async function elevatePendingSession(
  tx: Tx,
  sessionId: string,
): Promise<RotatedSession> {
  const { token, hash } = mintToken();
  const [row] = await tx
    .update(sessions)
    .set({
      assurance: "mfa",
      tokenHash: hash,
      previousTokenHash: null,
      rotatedAt: sql`now()`,
      lastSeenAt: sql`now()`,
      expiresAt: slidingExpiry(),
    })
    .where(and(eq(sessions.id, sessionId), eq(sessions.assurance, "pending")))
    .returning({
      maxAgeSec: sql<number>`GREATEST(0, floor(extract(epoch from (${sessions.createdAt} + ${seconds(SESSION_ABSOLUTE_SECONDS)} - now()))))::int`,
    });
  /** Unreachable: the caller locked the row as pending in this transaction. */
  if (!row) throw new Error("Pending session vanished under its lock");
  return { token, maxAgeSec: row.maxAgeSec };
}

/**
 * Stores (or, with `null`, clears) the secret of a TOTP enrolment started
 * in this session (#220), already encrypted. Scoped to the user in the
 * `WHERE`, so a session id of another account changes nothing.
 *
 * @returns true when the session was found.
 */
export async function setTotpPendingSecret(
  userId: string,
  sessionId: string,
  encryptedSecret: string | null,
): Promise<boolean> {
  const rows = await withSanitizedErrors(() =>
    db
      .update(sessions)
      .set({ totpPendingSecret: encryptedSecret })
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
      .returning({ id: sessions.id }),
  );
  return rows.length > 0;
}

/**
 * The encrypted secret of the enrolment started in this session, or
 * `null` (#220). `forUpdate` locks the session row in the caller's
 * transaction (confirmation).
 */
export async function totpPendingSecretOf(
  executor: DbExecutor,
  userId: string,
  sessionId: string,
  forUpdate: boolean = false,
): Promise<string | null> {
  const query = executor
    .select({ secret: sessions.totpPendingSecret })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  const [row] = await withSanitizedErrors(() =>
    forUpdate ? query.for("update") : query,
  );
  return row?.secret ?? null;
}

/**
 * Marks a session as verified with a second factor (#220), after the
 * user confirmed an authenticator app in it, and clears its pending
 * enrolment secret. The token is not rotated: the session already had
 * full access before, so there is nothing to fixate.
 */
export async function markSessionMfa(tx: Tx, sessionId: string): Promise<void> {
  await tx
    .update(sessions)
    .set({ assurance: "mfa", totpPendingSecret: null })
    .where(eq(sessions.id, sessionId));
}

/**
 * Raises a session to `mfa` after the user proved a passkey in it (#223,
 * registration). Unlike `markSessionMfa`, a TOTP enrolment the session
 * started is left alone. The token is not rotated, for the same reason.
 */
export async function raiseSessionToMfa(tx: Tx, sessionId: string): Promise<void> {
  await tx.update(sessions).set({ assurance: "mfa" }).where(eq(sessions.id, sessionId));
}
