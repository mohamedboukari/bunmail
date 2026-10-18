import { and, desc, eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import { config } from "../../../config.ts";
import { db } from "../../../db/index.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { UserStoreError, withSanitizedErrors } from "../errors.ts";
import { users } from "../models/user.schema.ts";
import { userCredentials } from "../models/user-credential.schema.ts";
import { userTokens } from "../models/user-token.schema.ts";
import {
  USER_ROLES,
  isInviteRole,
  isUserRole,
  literals,
  type AcceptInvitationResult,
  type DbExecutor,
  type InviteAcceptance,
  type InviteActor,
  type InviteRefusal,
  type InviteRole,
  type InviteTarget,
  type IssueInvitationResult,
  type IssuedInvitation,
  type PendingInvitation,
  type SessionClient,
  type TokenPurpose,
  type Tx,
  type UserRole,
} from "../types/user.types.ts";
import * as inviteEmail from "./invite-email.service.ts";
import {
  buildInviteUrl,
  canGrantRole,
  grantableRoles,
  isInvitableEmail,
  normalizeInviteEmail,
} from "./invite-policy.service.ts";
import { hashPassword } from "./password.service.ts";
import { createSession } from "./session.service.ts";
import { locateSession } from "./session-location.service.ts";
import { sessionIp } from "./session-policy.service.ts";
import { hashToken, mintToken } from "./token.service.ts";

/**
 * Dashboard invitations (#217): the only way an account other than the
 * owner comes to exist.
 *
 * An admin or the owner invites an address with a role (`canGrantRole`:
 * the owner grants admin or member, an admin grants member, nobody grants
 * owner; the database's `user_tokens_invite_check` refuses an owner
 * invitation too). The invitation is a `user_tokens` row of purpose
 * `invite`: 256-bit token, only its SHA-256 stored, `INVITE_EXPIRY_DAYS`
 * to live. The link goes out by email from `SYSTEM_MAIL_FROM` when that
 * works (`invite-email.service.ts`), otherwise the caller shows it to the
 * inviter once.
 *
 * Every write for an address runs in one transaction under a Postgres
 * advisory lock keyed on that address, so concurrent invites, resends and
 * an acceptance serialize: at most one live link per address, and no
 * invitation is issued next to an account created a moment earlier.
 *
 * Never logs a token, its hash or the link; addresses are logged through
 * `redactEmail`. Database errors leave this module as `UserStoreError`
 * (SQLSTATE only).
 */

/** The token purpose this service mints and spends. */
const INVITE: TokenPurpose = "invite";

/** The credential type the accept form writes. */
const PASSWORD_CREDENTIAL = "password";

/** Namespace of the per-address advisory-lock key (distinct from `bunmail:owner`). */
const INVITE_LOCK_PREFIX = "bunmail:invite:";

/** Longest pending list the Invitations page shows; a backstop, not paging. */
const PENDING_LIST_LIMIT = 500;

/** SQLSTATE of a unique violation: `users.email` taken by a concurrent writer. */
const UNIQUE_VIOLATION = "23505";

/**
 * Runs `fn` in a transaction that first takes the advisory lock of
 * `email`. `pg_advisory_xact_lock` is released on commit or rollback.
 * `hashtext` collisions only make two addresses share a lock, which is
 * harmless.
 */
function withInviteLock<T>(email: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
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
function openInvite(): SQL | undefined {
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
function liveInvite(): SQL | undefined {
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
function acceptableInvite(): SQL | undefined {
  return and(liveInvite(), inviterStillGrants());
}

/**
 * `now() + <days> days` on the database clock. The day count is inlined
 * as an interval literal, never bound: it is a validated config integer
 * (1 to 90), and a bound value next to an interval leaves Postgres
 * guessing the parameter type.
 */
function expiryAfterDays(days: number): SQL {
  return sql`now() + ${sql.raw(`interval '${Math.trunc(days)} days'`)}`;
}

/** True when an account (enabled or not) already holds `email`. */
async function emailHasAccount(tx: Tx, email: string): Promise<boolean> {
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
async function revokeOpenInvites(tx: Tx, email: string): Promise<number> {
  const rows = await tx
    .update(userTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(openInvite(), eq(userTokens.email, email)))
    .returning({ id: userTokens.id });
  return rows.length;
}

/** Name of an account, or its email when it has none; `null` when it is gone. */
async function accountLabel(tx: Tx, userId: string): Promise<string | null> {
  const [row] = await tx
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;
  return row.name?.trim() || row.email;
}

/** An issued invitation plus the label of its inviter, for the email. */
interface IssuedWithInviter {
  invitation: IssuedInvitation;
  inviter: string;
}

/**
 * True when a live invitation for `email` grants a role `actorRole` cannot
 * grant (an owner's admin invitation, seen by an admin): the actor may
 * not replace it, which would also downgrade it.
 */
async function hasHigherPendingInvite(
  tx: Tx,
  email: string,
  actorRole: UserRole,
): Promise<boolean> {
  const rows = await tx
    .select({ role: userTokens.role })
    .from(userTokens)
    .where(and(liveInvite(), eq(userTokens.email, email)));
  return rows.some((row) => row.role === null || !canGrantRole(actorRole, row.role));
}

/**
 * Replaces the open invitations for `email` with a fresh one under the
 * address lock: refuses when an account holds the address (and revokes
 * the open invitations, which can no longer be accepted), refuses when a
 * live invitation grants a role the actor cannot grant (nothing changes),
 * otherwise revokes them and inserts the new token. The expiry is set on
 * the database clock and read back.
 */
async function replaceInvite(
  tx: Tx,
  input: { email: string; role: InviteRole; actor: InviteActor },
): Promise<
  { ok: true; issued: IssuedWithInviter } | { ok: false; reason: InviteRefusal }
> {
  if (await emailHasAccount(tx, input.email)) {
    await revokeOpenInvites(tx, input.email);
    return { ok: false, reason: "account_exists" };
  }
  if (await hasHigherPendingInvite(tx, input.email, input.actor.role)) {
    return { ok: false, reason: "pending_higher_role" };
  }
  const replaced = await revokeOpenInvites(tx, input.email);

  const { token, hash } = mintToken();
  const invitationId = generateId("utk");
  const [inserted] = await tx
    .insert(userTokens)
    .values({
      id: invitationId,
      email: input.email,
      purpose: INVITE,
      role: input.role,
      invitedBy: input.actor.id,
      tokenHash: hash,
      expiresAt: expiryAfterDays(config.invites.expiryDays),
    })
    .returning({ expiresAt: userTokens.expiresAt });
  /** Unreachable: an INSERT ... RETURNING that did not throw returns its row. */
  if (!inserted) throw new Error("Invitation insert returned no row");
  const { expiresAt } = inserted;
  const inviter = (await accountLabel(tx, input.actor.id)) ?? "A BunMail administrator";
  return {
    ok: true,
    issued: {
      invitation: {
        invitationId,
        token,
        email: input.email,
        role: input.role,
        expiresAt,
        replaced,
      },
      inviter,
    },
  };
}

/**
 * Builds the accept link and sends the email after the transaction
 * committed, so a rolled-back token is never mailed or shown. A link that
 * fell back to `http://localhost:PORT` (no usable `APP_BASE_URL`) is
 * never emailed: it would be useless to the invitee. The caller shows it
 * to the inviter once instead.
 */
async function deliver(issued: IssuedWithInviter): Promise<IssueInvitationResult> {
  const { invitation, inviter } = issued;
  const { url, usedFallback } = buildInviteUrl(
    config.appBaseUrl,
    config.server.port,
    invitation.token,
  );
  if (usedFallback) {
    logger.warn("Invitation email not sent", {
      invitationId: invitation.invitationId,
      to: redactEmail(invitation.email),
      reason: "no_base_url",
      hint: "set APP_BASE_URL: the link points at http://localhost",
    });
    return {
      ok: true,
      invitation,
      url,
      delivery: { sent: false, reason: "no_base_url" },
    };
  }
  const delivery = await inviteEmail.sendInviteEmail({
    invitationId: invitation.invitationId,
    to: invitation.email,
    url,
    inviter,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
  });
  return { ok: true, invitation, url, delivery };
}

/** Logs a refused invitation action at `warn`, with IDs and the reason only. */
function logRefusal(
  action: "create" | "resend" | "revoke",
  actor: InviteActor,
  reason: InviteRefusal,
  extra: Record<string, unknown>,
): void {
  logger.warn("Invitation refused", {
    action,
    actorId: actor.id,
    actorRole: actor.role,
    reason,
    ...extra,
  });
}

/**
 * Invites `rawEmail` with `rawRole` on behalf of `actor` (#217).
 *
 * Checks, in order: the address (trimmed, lower-cased, one bare address),
 * the role (`canGrantRole` on the actor's role, so a crafted `owner`, or
 * an admin asking for `admin`, is refused), then, under the address lock,
 * that no account holds the address. Inviting an address with a pending
 * invitation replaces it: the old link dies, exactly one stays live.
 * A live invitation for the address that grants a role the actor cannot
 * grant is never replaced (`pending_higher_role`). After commit the email
 * is sent (see `sendInviteEmail`); its outcome is returned so the caller
 * can show the link when it did not go out.
 */
export async function createInvitation(
  actor: InviteActor,
  rawEmail: string,
  rawRole: string,
): Promise<IssueInvitationResult> {
  const email = normalizeInviteEmail(rawEmail);
  const requestedRole = isUserRole(rawRole) ? rawRole : "unknown";
  if (!isInvitableEmail(email)) {
    logRefusal("create", actor, "invalid_email", { requestedRole });
    return { ok: false, reason: "invalid_email" };
  }
  if (!canGrantRole(actor.role, rawRole)) {
    logRefusal("create", actor, "role_not_allowed", {
      requestedRole,
      email: redactEmail(email),
    });
    return { ok: false, reason: "role_not_allowed" };
  }
  const role = rawRole;

  const result = await withInviteLock(email, (tx) =>
    replaceInvite(tx, { email, role, actor }),
  );
  if (!result.ok) {
    logRefusal("create", actor, result.reason, {
      requestedRole,
      email: redactEmail(email),
    });
    return result;
  }

  const { invitation } = result.issued;
  logger.info("Invitation created", {
    invitationId: invitation.invitationId,
    invitedBy: actor.id,
    role,
    email: redactEmail(email),
    replaced: invitation.replaced,
    expiresAt: invitation.expiresAt.toISOString(),
  });
  return deliver(result.issued);
}

/** The pending invitation with id `id`: open and unexpired. */
async function findPendingById(
  executor: DbExecutor,
  id: string,
): Promise<{ email: string; role: InviteRole } | null> {
  const [row] = await executor
    .select({ email: userTokens.email, role: userTokens.role })
    .from(userTokens)
    .where(and(liveInvite(), eq(userTokens.id, id)))
    .limit(1);
  if (!row?.email || !row.role || !isInviteRole(row.role)) return null;
  return { email: row.email, role: row.role };
}

/**
 * Resends a pending invitation (#217): a new token for the same address
 * and role replaces it (the old link dies), `invited_by` becomes `actor`,
 * and the email is sent again. The actor must be allowed to grant the
 * invitation's role, so an admin cannot resend an admin invitation.
 */
export async function resendInvitation(
  actor: InviteActor,
  id: string,
): Promise<IssueInvitationResult> {
  const pending = await withSanitizedErrors(() => findPendingById(db, id));
  if (!pending) {
    logRefusal("resend", actor, "not_found", { invitationId: id });
    return { ok: false, reason: "not_found" };
  }
  if (!canGrantRole(actor.role, pending.role)) {
    logRefusal("resend", actor, "role_not_allowed", {
      invitationId: id,
      role: pending.role,
    });
    return { ok: false, reason: "role_not_allowed" };
  }

  const result = await withInviteLock(pending.email, async (tx) => {
    /** Re-read under the lock: a concurrent resend or revoke may have won. */
    if (!(await findPendingById(tx, id))) {
      return { ok: false as const, reason: "not_found" as const };
    }
    return replaceInvite(tx, { email: pending.email, role: pending.role, actor });
  });
  if (!result.ok) {
    logRefusal("resend", actor, result.reason, { invitationId: id, role: pending.role });
    return result;
  }

  const { invitation } = result.issued;
  logger.info("Invitation resent", {
    invitationId: invitation.invitationId,
    previousInvitationId: id,
    invitedBy: actor.id,
    role: invitation.role,
    email: redactEmail(invitation.email),
    expiresAt: invitation.expiresAt.toISOString(),
  });
  return deliver(result.issued);
}

/**
 * Revokes a pending invitation (#217). The actor must be allowed to grant
 * its role. Conditional on the invitation still being open, so a revoke
 * racing a resend or an acceptance never undoes either.
 */
export async function revokeInvitation(
  actor: InviteActor,
  id: string,
): Promise<{ ok: true } | { ok: false; reason: InviteRefusal }> {
  const pending = await withSanitizedErrors(() => findPendingById(db, id));
  if (!pending) {
    logRefusal("revoke", actor, "not_found", { invitationId: id });
    return { ok: false, reason: "not_found" };
  }
  if (!canGrantRole(actor.role, pending.role)) {
    logRefusal("revoke", actor, "role_not_allowed", {
      invitationId: id,
      role: pending.role,
    });
    return { ok: false, reason: "role_not_allowed" };
  }

  const rows = await withSanitizedErrors(() =>
    db
      .update(userTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(openInvite(), eq(userTokens.id, id)))
      .returning({ id: userTokens.id }),
  );
  if (rows.length === 0) {
    logRefusal("revoke", actor, "not_found", { invitationId: id });
    return { ok: false, reason: "not_found" };
  }
  logger.info("Invitation revoked", {
    invitationId: id,
    revokedBy: actor.id,
    role: pending.role,
    email: redactEmail(pending.email),
  });
  return { ok: true };
}

/**
 * Pending invitations (open and unexpired), newest first, with the name
 * (or email) of whoever sent each one. For the Invitations page.
 */
export async function listPendingInvitations(): Promise<PendingInvitation[]> {
  const rows = await withSanitizedErrors(() =>
    db
      .select({
        id: userTokens.id,
        email: userTokens.email,
        role: userTokens.role,
        inviterName: users.name,
        inviterEmail: users.email,
        createdAt: userTokens.createdAt,
        expiresAt: userTokens.expiresAt,
      })
      .from(userTokens)
      .leftJoin(users, eq(users.id, userTokens.invitedBy))
      .where(liveInvite())
      .orderBy(desc(userTokens.createdAt))
      .limit(PENDING_LIST_LIMIT),
  );
  const pending: PendingInvitation[] = [];
  for (const row of rows) {
    /** Unreachable while `user_tokens_invite_check` holds; skipped, never guessed. */
    if (!row.email || !row.role || !isInviteRole(row.role)) continue;
    pending.push({
      id: row.id,
      email: row.email,
      role: row.role,
      invitedBy: row.inviterName?.trim() || row.inviterEmail || null,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    });
  }
  return pending;
}

/**
 * Looks up an acceptable invitation token: live, and its inviter still
 * an enabled account that may grant its role. Read-only: `GET
 * /dashboard/invite` uses it to render the form without spending the
 * token, so link scanners and prefetchers cannot burn it. Returns `null`
 * for every invalid case (unknown, expired, used, revoked, inviter gone,
 * disabled or demoted) so callers cannot tell them apart.
 */
export async function findLiveInvitation(token: string): Promise<InviteTarget | null> {
  const [row] = await withSanitizedErrors(() =>
    db
      .select({ id: userTokens.id, email: userTokens.email, role: userTokens.role })
      .from(userTokens)
      .where(and(acceptableInvite(), eq(userTokens.tokenHash, hashToken(token))))
      .limit(1),
  );
  if (!row?.email || !row.role || !isInviteRole(row.role)) return null;
  return { invitationId: row.id, email: row.email, role: row.role };
}

/**
 * Accepts an invitation: creates the account and signs it in (#217).
 * Order matters on this unauthenticated path:
 *
 * 1. A cheap indexed lookup first: a dead token never reaches argon2id.
 * 2. `hashPassword` outside the transaction, so the address lock is never
 *    held during argon2id.
 * 3. Under the address lock, in one transaction: refuse if an account
 *    took the address meanwhile (its open invitations are revoked, since
 *    none can be accepted any more); spend the token with a conditional
 *    `UPDATE ... SET used_at = now()` on the live predicate plus the
 *    inviter re-check (`inviterStillGrants`: an inviter deleted, disabled
 *    or demoted since sending makes the token invalid; a concurrent
 *    second submission gets no row); insert the user with the invited
 *    role and the name; insert the `password` credential; revoke every
 *    other open invitation for the address; open the session.
 *
 * `email_verified_at` stays null: the link may have been shared by hand
 * (when no system sender is configured), which proves nothing about the
 * mailbox.
 *
 * All or nothing: a failure rolls back every step. A unique violation on
 * `users.email` (an account created outside the invitation lock, e.g. the
 * owner bootstrap) is reported as `account_exists`.
 *
 * @param acceptance - Name (trimmed here again) and password, both
 *                     already checked against the policy by the caller.
 * @param client     - Request metadata stored with the new session.
 */
export async function acceptInvitation(
  token: string,
  acceptance: InviteAcceptance,
  client: SessionClient = { ip: null, userAgent: null },
): Promise<AcceptInvitationResult> {
  const target = await findLiveInvitation(token);
  if (!target) return { ok: false, reason: "invalid" };

  const secretHash = await hashPassword(acceptance.password);
  const tokenHash = hashToken(token);
  const name = acceptance.name.trim();

  let result: AcceptInvitationResult;
  try {
    result = await withInviteLock(
      target.email,
      async (tx): Promise<AcceptInvitationResult> => {
        if (await emailHasAccount(tx, target.email)) {
          await revokeOpenInvites(tx, target.email);
          return { ok: false, reason: "account_exists" };
        }

        const [spent] = await tx
          .update(userTokens)
          .set({ usedAt: sql`now()` })
          .where(and(acceptableInvite(), eq(userTokens.tokenHash, tokenHash)))
          .returning({
            email: userTokens.email,
            role: userTokens.role,
            invitedBy: userTokens.invitedBy,
          });
        if (!spent?.email || !spent.role || !isInviteRole(spent.role)) {
          return { ok: false, reason: "invalid" };
        }
        const { email, role } = spent;

        const userId = generateId("usr");
        await tx.insert(users).values({ id: userId, email, name, role });
        const credentialId = generateId("crd");
        await tx.insert(userCredentials).values({
          id: credentialId,
          userId,
          type: PASSWORD_CREDENTIAL,
          secretHash,
        });
        await revokeOpenInvites(tx, email);

        const session = await createSession(
          {
            userId,
            assurance: "password",
            authMethod: PASSWORD_CREDENTIAL,
            credentialId,
            ...client,
          },
          tx,
        );
        return {
          ok: true,
          userId,
          email,
          role,
          invitedBy: spent.invitedBy,
          sessionId: session.sessionId,
          sessionToken: session.token,
        };
      },
    );
  } catch (error: unknown) {
    if (error instanceof UserStoreError && error.sqlState === UNIQUE_VIOLATION) {
      return { ok: false, reason: "account_exists" };
    }
    throw error;
  }
  /** Committed: look the new session's location up in the background (#281). */
  if (result.ok) void locateSession(result.sessionId, sessionIp(client.ip));
  return result;
}
