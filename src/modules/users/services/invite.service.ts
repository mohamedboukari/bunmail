import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { withSanitizedErrors } from "../errors.ts";
import { users } from "../models/user.schema.ts";
import { userTokens } from "../models/user-token.schema.ts";
import {
  isInviteRole,
  type InviteActor,
  type InviteRefusal,
  type PendingInvitation,
  type SessionClient,
} from "../types/user.types.ts";
import { canGrantRole } from "./invite-policy.service.ts";
import { recordAuditEvent } from "../../audit/services/audit.service.ts";
import {
  NO_CLIENT,
  PENDING_LIST_LIMIT,
  liveInvite,
  openInvite,
} from "./invite-store.service.ts";
import { findPendingById, logRefusal } from "./invite-issue.service.ts";

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

/**
 * The service's public surface (#387). Revoking and listing invitations
 * live here; the rest is in one file per concern, beside this one:
 *
 *   - `invite-store.service.ts`: the address lock, the invitation predicates, `revokeInvitesIssuedBy`
 *   - `invite-issue.service.ts`: creating and resending, the link and email after commit
 *   - `invite-accept.service.ts`: the token lookup and the acceptance
 *
 * Importers keep using this module.
 */
export { revokeInvitesIssuedBy } from "./invite-store.service.ts";
export { createInvitation, resendInvitation } from "./invite-issue.service.ts";
export { findLiveInvitation, acceptInvitation } from "./invite-accept.service.ts";

/**
 * Revokes a pending invitation (#217). The actor must be allowed to grant
 * its role. Conditional on the invitation still being open, so a revoke
 * racing a resend or an acceptance never undoes either.
 */
export async function revokeInvitation(
  actor: InviteActor,
  id: string,
  client: SessionClient = NO_CLIENT,
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
    db.transaction(async (tx) => {
      const revoked = await tx
        .update(userTokens)
        .set({ revokedAt: sql`now()` })
        .where(and(openInvite(), eq(userTokens.id, id)))
        .returning({ id: userTokens.id });
      /** Recorded with the revocation (#221): both commit, or neither. */
      if (revoked.length > 0) {
        await recordAuditEvent(
          {
            action: "user.invitation.revoked",
            actor: { type: "user", id: actor.id },
            ...client,
            target: { type: "invitation", id, label: pending.email },
            metadata: { role: pending.role },
          },
          tx,
        );
      }
      return revoked;
    }),
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
