import { and, desc, eq, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { withSanitizedErrors } from "../errors.ts";
import { generateId } from "../../../utils/id.ts";
import { sessions } from "../models/session.schema.ts";
import { sessionTokenHistory } from "../models/session-token-history.schema.ts";
import { users } from "../models/user.schema.ts";
import { hasSecondFactor } from "../models/user-credential.schema.ts";
import {
  isSessionAssurance,
  isUserRole,
  type ActiveSession,
  type CreatedSession,
  type DbExecutor,
  type NewSessionInput,
  type PendingSession,
  type RotatedSession,
  type Tx,
  type UserSessionSummary,
} from "../types/user.types.ts";
import {
  SESSION_ABSOLUTE_SECONDS,
  SESSION_IDLE_SECONDS,
  SESSION_PENDING_SECONDS,
  SESSION_ROTATE_SECONDS,
  SESSION_ROTATION_GRACE_SECONDS,
  clampUserAgent,
  sessionIp,
} from "./session-policy.service.ts";
import { hashToken, mintToken } from "./token.service.ts";

/**
 * Server-side dashboard sessions (#216): the only code outside
 * `owner.service.ts` that touches the `sessions` table.
 *
 * The cookie carries an opaque 256-bit token; only its SHA-256 is stored.
 * All expiry math runs on the database clock (`now()`), so replicas with
 * skewed clocks agree. Lifetimes: `expires_at` slides to `now() + idle` on
 * every rotation, capped at `created_at + absolute`.
 *
 * Rotation and reuse detection: once a token is older than
 * `SESSION_ROTATE_SECONDS`, the next request swaps it for a fresh one and
 * keeps the old hash in `previous_token_hash`. The old token stays usable
 * for `SESSION_ROTATION_GRACE_SECONDS` (requests already in flight); after
 * that, presenting it means someone else holds a copy of the cookie, and
 * the guard revokes every session of the user. Every superseded hash is
 * also kept in `session_token_history` for the session's life, so a token
 * two or more rotations old is recognized as reuse as well
 * (`findSessionBySupersededToken`): a thief who keeps a stolen session
 * active cannot outrun detection.
 *
 * Never logs or returns a token hash. Database errors leave this module
 * as `UserStoreError` (SQLSTATE only): drizzle's message would carry the
 * token hashes in its params.
 */

/**
 * A constant interval literal, e.g. `interval '60 seconds'`. Inlined
 * rather than bound: the values are code constants, and a bound number
 * next to an interval leaves Postgres guessing the parameter type.
 */
function seconds(value: number): SQL {
  return sql.raw(`interval '${Math.trunc(value)} seconds'`);
}

/**
 * The session-side half of "live" (#216, #281): unexpired (`expires_at`
 * carries both the 24 h idle and the 7 d absolute rule, see
 * `slidingExpiry`) and an assurance that may open a page: `mfa`, or
 * `password` only while the account has no second factor (#220: TOTP;
 * #223: a passkey; one shared predicate, `hasSecondFactor`). `pending`
 * never. So a password-level session can never outlive the account
 * turning 2FA on or adding a passkey, even one a login opened while a
 * confirmation was committing (confirmation deletes the other sessions, but a login
 * that checked the password just before can insert after it). The guard
 * (`findActiveSession`) and the Active sessions list share it, so the
 * list shows exactly the sessions that still open the dashboard.
 */
function liveSession(): SQL | undefined {
  return and(
    sql`${sessions.expiresAt} > now()`,
    or(
      eq(sessions.assurance, "mfa"),
      and(
        eq(sessions.assurance, "password"),
        sql`NOT ${hasSecondFactor(sessions.userId)}`,
      ),
    ),
  );
}

/** `expires_at` after activity: the idle timeout, capped by the absolute one. */
function slidingExpiry(): SQL {
  return sql`LEAST(now() + ${seconds(SESSION_IDLE_SECONDS)}, ${sessions.createdAt} + ${seconds(SESSION_ABSOLUTE_SECONDS)})`;
}

/**
 * Opens a session for a user who just passed login (or owner setup) and
 * returns the raw token for the cookie. `executor` lets owner setup run
 * this inside its own transaction, after it deleted the owner's old
 * sessions. A fresh session starts unrotated (`rotated_at` null).
 *
 * A `pending` session (#220: password passed, second factor to come)
 * expires after `SESSION_PENDING_SECONDS` (10 minutes) instead of the
 * idle timeout; nothing extends it, since the guard never admits it and
 * so never rotates it.
 *
 * `input.credentialId` binds the session to the credential that was
 * checked (#277): when that credential has been replaced meanwhile (a
 * password reset racing a login), the insert fails with a foreign-key
 * violation (`UserStoreError`, SQLSTATE `23503`) instead of opening a
 * session on the old password.
 */
export async function createSession(
  input: NewSessionInput,
  executor: DbExecutor = db,
): Promise<CreatedSession> {
  const { token, hash } = mintToken();
  const sessionId = generateId("ses");
  await withSanitizedErrors(() =>
    executor.insert(sessions).values({
      id: sessionId,
      userId: input.userId,
      tokenHash: hash,
      assurance: input.assurance,
      authMethod: input.authMethod,
      credentialId: input.credentialId ?? null,
      expiresAt: sql`now() + ${seconds(
        input.assurance === "pending" ? SESSION_PENDING_SECONDS : SESSION_IDLE_SECONDS,
      )}`,
      ip: sessionIp(input.ip),
      userAgent: clampUserAgent(input.userAgent),
    }),
  );
  return { sessionId, token };
}

/**
 * Finds the live session a presented cookie token belongs to, or `null`.
 * One query: the token hash matched against the current and the previous
 * hash (both indexed), joined to the user. A row only counts when the
 * session has not expired, the user is not disabled, and the assurance is
 * `password` or `mfa`, so a `pending` session (#220) can never open a
 * protected page. The same row carries the account's email and role, the
 * session's assurance (#222) and whether the account has a second factor
 * (#220, #223, for the `REQUIRE_2FA` policy): the guard builds the handlers'
 * `auth` from it without a second query.
 */
export async function findActiveSession(token: string): Promise<ActiveSession | null> {
  const tokenHash = hashToken(token);
  const [row] = await withSanitizedErrors(() =>
    db
      .select({
        sessionId: sessions.id,
        userId: sessions.userId,
        email: users.email,
        role: users.role,
        assurance: sessions.assurance,
        hasSecondFactor: hasSecondFactor(sessions.userId),
        isCurrent: sql<boolean>`${sessions.tokenHash} = ${tokenHash}`,
        rotationDue: sql<boolean>`coalesce(${sessions.rotatedAt}, ${sessions.createdAt}) < now() - ${seconds(SESSION_ROTATE_SECONDS)}`,
        graceOver: sql<boolean>`coalesce(${sessions.rotatedAt} < now() - ${seconds(SESSION_ROTATION_GRACE_SECONDS)}, true)`,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          or(
            eq(sessions.tokenHash, tokenHash),
            eq(sessions.previousTokenHash, tokenHash),
          ),
          liveSession(),
          sql`${users.disabledAt} IS NULL`,
        ),
      )
      .limit(1),
  );
  if (!row) return null;
  /**
   * Unreachable while the CHECK constraints hold; an unknown role or
   * assurance is treated as no session (fail closed), never as a guess.
   */
  if (!isUserRole(row.role) || !isSessionAssurance(row.assurance)) return null;
  return {
    sessionId: row.sessionId,
    userId: row.userId,
    email: row.email,
    role: row.role,
    assurance: row.assurance,
    hasSecondFactor: row.hasSecondFactor,
    matched: row.isCurrent ? "current" : "previous",
    rotationDue: row.rotationDue,
    graceOver: row.graceOver,
  };
}

/**
 * Swaps the session's token for a fresh one (#216). The old hash moves to
 * `previous_token_hash` and is recorded in `session_token_history`, in the
 * same transaction; `last_seen_at` and `expires_at` slide forward (this
 * write is the sliding refresh). Conditional on the presented token
 * still being the current one: when two requests race, exactly one
 * rotates and the other gets `null` and is served without a new cookie
 * (its token is now the previous one, inside the grace period).
 *
 * @returns the new token and the cookie lifetime left until the absolute
 *          cap, or `null` when another request rotated first.
 */
export async function rotateSession(
  sessionId: string,
  presentedToken: string,
): Promise<RotatedSession | null> {
  const { token, hash } = mintToken();
  const presentedHash = hashToken(presentedToken);
  const row = await withSanitizedErrors(() =>
    db.transaction(async (tx) => {
      const [rotated] = await tx
        .update(sessions)
        .set({
          previousTokenHash: sql`${sessions.tokenHash}`,
          tokenHash: hash,
          rotatedAt: sql`now()`,
          lastSeenAt: sql`now()`,
          expiresAt: slidingExpiry(),
        })
        .where(
          and(
            eq(sessions.id, sessionId),
            eq(sessions.tokenHash, presentedHash),
            sql`${sessions.expiresAt} > now()`,
          ),
        )
        .returning({
          maxAgeSec: sql<number>`GREATEST(0, floor(extract(epoch from (${sessions.createdAt} + ${seconds(SESSION_ABSOLUTE_SECONDS)} - now()))))::int`,
        });
      if (!rotated) return undefined;
      await tx
        .insert(sessionTokenHistory)
        .values({ tokenHash: presentedHash, sessionId });
      return rotated;
    }),
  );
  if (!row) return null;
  return { token, maxAgeSec: row.maxAgeSec };
}

/**
 * Finds the live session a SUPERSEDED token once belonged to (#216): any
 * generation the session rotated away from, however old. A hit means
 * someone presented a token the session no longer uses, i.e. two parties
 * hold copies of the cookie: the caller revokes every session of the
 * user. Only unexpired sessions count: once a session has expired, its
 * old tokens are worthless to everyone and need no alarm.
 *
 * @returns the session and its user, or `null` when the token was never
 *          superseded (unknown, or the session is gone or expired).
 */
export async function findSessionBySupersededToken(
  token: string,
): Promise<{ sessionId: string; userId: string } | null> {
  const [row] = await withSanitizedErrors(() =>
    db
      .select({ sessionId: sessions.id, userId: sessions.userId })
      .from(sessionTokenHistory)
      .innerJoin(sessions, eq(sessions.id, sessionTokenHistory.sessionId))
      .where(
        and(
          eq(sessionTokenHistory.tokenHash, hashToken(token)),
          sql`${sessions.expiresAt} > now()`,
        ),
      )
      .limit(1),
  );
  return row ?? null;
}

/**
 * Deletes the session a presented token belongs to (logout, or a new login
 * replacing the browser's previous session). Matches the current or the
 * previous token, so a logout sent with a just-rotated cookie still ends
 * the session.
 *
 * @returns the revoked `ses_` id and its user (for the audit log, #221),
 *          or `null` when nothing matched.
 */
export async function revokeSessionByToken(
  token: string,
): Promise<{ sessionId: string; userId: string } | null> {
  const tokenHash = hashToken(token);
  const [row] = await withSanitizedErrors(() =>
    db
      .delete(sessions)
      .where(
        or(eq(sessions.tokenHash, tokenHash), eq(sessions.previousTokenHash, tokenHash)),
      )
      .returning({ sessionId: sessions.id, userId: sessions.userId }),
  );
  return row ?? null;
}

/**
 * Deletes every session of a user: owner setup and reset-owner (#216),
 * token reuse detection, and later deactivation (#218) and password
 * change (#277). `executor` lets a caller run it inside its transaction.
 *
 * @returns how many sessions were revoked.
 */
export async function revokeAllUserSessions(
  userId: string,
  executor: DbExecutor = db,
): Promise<number> {
  const rows = await withSanitizedErrors(() =>
    executor
      .delete(sessions)
      .where(eq(sessions.userId, userId))
      .returning({ id: sessions.id }),
  );
  return rows.length;
}

/**
 * The live sessions of one user, most recently active first, for the
 * Active sessions page (#281). "Live" is the guard's own predicate
 * (`liveSession`), so an expired session is never listed. Only columns
 * safe to show: never a token hash.
 */
export async function listUserSessions(userId: string): Promise<UserSessionSummary[]> {
  return withSanitizedErrors(() =>
    db
      .select({
        id: sessions.id,
        ip: sessions.ip,
        userAgent: sessions.userAgent,
        location: sessions.location,
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
      })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), liveSession()))
      .orderBy(desc(sessions.lastSeenAt), desc(sessions.createdAt)),
  );
}

/**
 * Deletes one session, but only when it belongs to `userId` (#281): the
 * ownership check is in the `WHERE`, so another user's session id (or an
 * unknown one) deletes nothing. Its token history goes with it (cascade).
 *
 * @returns true when a session was revoked.
 */
export async function revokeUserSession(
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const rows = await withSanitizedErrors(() =>
    db
      .delete(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
      .returning({ id: sessions.id }),
  );
  return rows.length > 0;
}

/**
 * Deletes every session of `userId` except `keepSessionId` ("sign out
 * all other devices", #281). Token history rows cascade.
 *
 * @returns how many sessions were revoked.
 */
export async function revokeOtherUserSessions(
  userId: string,
  keepSessionId: string,
): Promise<number> {
  const rows = await withSanitizedErrors(() =>
    db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)))
      .returning({ id: sessions.id }),
  );
  return rows.length;
}

/**
 * Stores the approximate location looked up for a session (#281). A
 * session revoked meanwhile is simply not found.
 */
export async function setSessionLocation(
  sessionId: string,
  location: string,
): Promise<void> {
  await withSanitizedErrors(() =>
    db.update(sessions).set({ location }).where(eq(sessions.id, sessionId)),
  );
}

/**
 * Deletes expired sessions; run by the purge worker on boot and every 6
 * hours. Only keeps the table small: the guard enforces expiry itself, so
 * security never depends on this sweep.
 *
 * @returns how many rows were deleted.
 */
export async function purgeExpiredSessions(): Promise<number> {
  const rows = await withSanitizedErrors(() =>
    db
      .delete(sessions)
      .where(lt(sessions.expiresAt, sql`now()`))
      .returning({ id: sessions.id }),
  );
  return rows.length;
}

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
      .select({ sessionId: sessions.id, userId: sessions.userId, email: users.email })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
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
