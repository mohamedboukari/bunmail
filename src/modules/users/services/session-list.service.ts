import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { withSanitizedErrors } from "../errors.ts";
import { sessions } from "../models/session.schema.ts";
import type { UserSessionSummary } from "../types/user.types.ts";
import { liveSession } from "./session-predicates.service.ts";

/**
 * The Active sessions page (#281): a user's live sessions, revoking one or
 * all the others, and the location stored for one. The public surface is
 * `session.service.ts`.
 */

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
