import { and, eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { withSanitizedErrors } from "../errors.ts";
import { users } from "../models/user.schema.ts";
import { userTokens } from "../models/user-token.schema.ts";
import {
  USER_ROLES,
  literals,
  type DbExecutor,
  type InviteRole,
  type SessionClient,
  type TokenPurpose,
  type Tx,
} from "../types/user.types.ts";
import { grantableRoles } from "./invite-policy.service.ts";

/**
 * What every invitation write builds on (#217): the per-address advisory
 * lock, the open, live and acceptable predicates, and the reads and
 * revocations under the lock. The public surface is `invite.service.ts`.
 */

/** The token purpose this service mints and spends. */
export const INVITE: TokenPurpose = "invite";

/** The credential type the accept form writes. */
export const PASSWORD_CREDENTIAL = "password";

/** Namespace of the per-address advisory-lock key (distinct from `bunmail:owner`). */
const INVITE_LOCK_PREFIX = "bunmail:invite:";

/** Longest pending list the Invitations page shows; a backstop, not paging. */
export const PENDING_LIST_LIMIT = 500;

/** SQLSTATE of a unique violation: `users.email` taken by a concurrent writer. */
export const UNIQUE_VIOLATION = "23505";

/** No request metadata (a script, a test): the event is still recorded. */
export const NO_CLIENT: SessionClient = { ip: null, userAgent: null };

/**
 * Runs `fn` in a transaction that first takes the advisory lock of
 * `email`. `pg_advisory_xact_lock` is released on commit or rollback.
 * `hashtext` collisions only make two addresses share a lock, which is
 * harmless.
 */
export function withInviteLock<T>(email: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withSanitizedErrors(() =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${INVITE_LOCK_PREFIX + email}))`,
      );
      return fn(tx);
    }),
  );
}

/** An open invitation: not spent, not revoked (may be expired). */
export function openInvite(): SQL | undefined {
  return and(
    eq(userTokens.purpose, INVITE),
    isNull(userTokens.usedAt),
    isNull(userTokens.revokedAt),
  );
}

/**
 * Revokes the open (unspent, unrevoked) invitations `inviterId` issued,
 * or only those granting `role` when it is given. Housekeeping for
 * account management (#218) and a completed password reset (#277):
 * acceptance re-checks the inviter anyway (`inviterStillGrants`).
 *
 * @returns how many invitations were revoked.
 */
export async function revokeInvitesIssuedBy(
  executor: DbExecutor,
  inviterId: string,
  role?: InviteRole,
): Promise<number> {
  const rows = await executor
    .update(userTokens)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        openInvite(),
        eq(userTokens.invitedBy, inviterId),
        role === undefined ? undefined : eq(userTokens.role, role),
      ),
    )
    .returning({ id: userTokens.id });
  return rows.length;
}

/**
 * A live invitation: open and not expired. Expiry is checked against the
 * database clock (`now()`), so replicas with skewed clocks agree.
 */
export function liveInvite(): SQL | undefined {
  return and(openInvite(), gt(userTokens.expiresAt, sql`now()`));
}

/**
 * The inviter can still grant the invitation's role: `invited_by` names an
 * existing, enabled account whose current role grants it (`grantableRoles`:
 * the owner any invite role, an admin `member`). Rendered from the same
 * table as `canGrantRole`, with literal value lists (code constants). An
 * invitation whose inviter was deleted (`invited_by` set to NULL),
 * disabled or demoted can no longer be accepted.
 */
function inviterStillGrants(): SQL {
  const clauses = USER_ROLES.filter((role) => grantableRoles(role).length > 0).map(
    (role) =>
      sql`(inviter.role = ${sql.raw(`'${role}'`)} AND ${userTokens.role} IN (${literals(grantableRoles(role))}))`,
  );
  return sql`EXISTS (SELECT 1 FROM ${users} AS inviter WHERE inviter.id = ${userTokens.invitedBy} AND inviter.disabled_at IS NULL AND (${sql.join(clauses, sql` OR `)}))`;
}

/** An invitation that can be accepted: live, and its inviter still grants its role. */
export function acceptableInvite(): SQL | undefined {
  return and(liveInvite(), inviterStillGrants());
}

/**
 * `now() + <days> days` on the database clock. The day count is inlined
 * as an interval literal, never bound: it is a validated config integer
 * (1 to 90), and a bound value next to an interval leaves Postgres
 * guessing the parameter type.
 */
export function expiryAfterDays(days: number): SQL {
  return sql`now() + ${sql.raw(`interval '${Math.trunc(days)} days'`)}`;
}

/** True when an account (enabled or not) already holds `email`. */
export async function emailHasAccount(tx: Tx, email: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return row !== undefined;
}

/**
 * Revokes every open invitation for `email`. Must run under the address
 * lock, which is what keeps "at most one live link per address" true.
 *
 * @returns how many invitations were revoked.
 */
export async function revokeOpenInvites(tx: Tx, email: string): Promise<number> {
  const rows = await tx
    .update(userTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(openInvite(), eq(userTokens.email, email)))
    .returning({ id: userTokens.id });
  return rows.length;
}

/** Name of an account, or its email when it has none; `null` when it is gone. */
export async function accountLabel(tx: Tx, userId: string): Promise<string | null> {
  const [row] = await tx
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;
  return row.name?.trim() || row.email;
}
