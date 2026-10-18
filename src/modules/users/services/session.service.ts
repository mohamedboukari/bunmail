import { and, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { withSanitizedErrors } from "../errors.ts";
import { generateId } from "../../../utils/id.ts";
import { sessions } from "../models/session.schema.ts";
import { sessionTokenHistory } from "../models/session-token-history.schema.ts";
import { users } from "../models/user.schema.ts";
import {
  isSessionAssurance,
  isUserRole,
  type ActiveSession,
  type CreatedSession,
  type DbExecutor,
  type NewSessionInput,
  type RotatedSession,
  type SessionAssurance,
} from "../types/user.types.ts";
import {
  SESSION_ABSOLUTE_SECONDS,
  SESSION_IDLE_SECONDS,
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

/** Assurance levels that may open a protected page; `pending` may not (#220). */
const ADMITTED_ASSURANCES: SessionAssurance[] = ["password", "mfa"];

/**
 * A constant interval literal, e.g. `interval '60 seconds'`. Inlined
 * rather than bound: the values are code constants, and a bound number
 * next to an interval leaves Postgres guessing the parameter type.
 */
function seconds(value: number): SQL {
  return sql.raw(`interval '${Math.trunc(value)} seconds'`);
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
      expiresAt: sql`now() + ${seconds(SESSION_IDLE_SECONDS)}`,
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
 * `password` or `mfa`, so a future `pending` session (#220) can never open
 * a protected page. The same row carries the account's email and role and
 * the session's assurance (#222): the guard builds the handlers' `auth`
 * from it without a second query.
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
          sql`${sessions.expiresAt} > now()`,
          sql`${users.disabledAt} IS NULL`,
          inArray(sessions.assurance, ADMITTED_ASSURANCES),
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
 * @returns the revoked `ses_` id, or `null` when nothing matched.
 */
export async function revokeSessionByToken(token: string): Promise<string | null> {
  const tokenHash = hashToken(token);
  const [row] = await withSanitizedErrors(() =>
    db
      .delete(sessions)
      .where(
        or(eq(sessions.tokenHash, tokenHash), eq(sessions.previousTokenHash, tokenHash)),
      )
      .returning({ id: sessions.id }),
  );
  return row?.id ?? null;
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
