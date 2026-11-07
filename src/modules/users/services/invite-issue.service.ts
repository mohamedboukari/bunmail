import { and, eq } from "drizzle-orm";
import { config } from "../../../config.ts";
import { db } from "../../../db/index.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { withSanitizedErrors } from "../errors.ts";
import { userTokens } from "../models/user-token.schema.ts";
import {
  isInviteRole,
  isUserRole,
  type DbExecutor,
  type InviteActor,
  type InviteRefusal,
  type InviteRole,
  type IssueInvitationResult,
  type IssuedInvitation,
  type SessionClient,
  type Tx,
  type UserRole,
} from "../types/user.types.ts";
import * as inviteEmail from "./invite-email.service.ts";
import {
  buildInviteUrl,
  canGrantRole,
  isInvitableEmail,
  normalizeInviteEmail,
} from "./invite-policy.service.ts";
import { mintToken } from "./token.service.ts";
import { recordAuditEvent } from "../../audit/services/audit.service.ts";
import {
  INVITE,
  NO_CLIENT,
  accountLabel,
  emailHasAccount,
  expiryAfterDays,
  liveInvite,
  revokeOpenInvites,
  withInviteLock,
} from "./invite-store.service.ts";

/**
 * Issuing invitations (#217): creating and resending one under the address
 * lock, and the accept link and email after commit. The public surface is
 * `invite.service.ts`.
 */

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
export function logRefusal(
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
  client: SessionClient = NO_CLIENT,
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

  const result = await withInviteLock(email, async (tx) => {
    const replaced = await replaceInvite(tx, { email, role, actor });
    /** Recorded with the invitation (#221): both commit, or neither. */
    if (replaced.ok) {
      const { invitation } = replaced.issued;
      await recordAuditEvent(
        {
          action: "user.invitation.created",
          actor: { type: "user", id: actor.id },
          ...client,
          target: { type: "invitation", id: invitation.invitationId, label: email },
          metadata: { role, replaced: invitation.replaced },
        },
        tx,
      );
    }
    return replaced;
  });
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
export async function findPendingById(
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
  client: SessionClient = NO_CLIENT,
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
    const replaced = await replaceInvite(tx, {
      email: pending.email,
      role: pending.role,
      actor,
    });
    if (replaced.ok) {
      await recordAuditEvent(
        {
          action: "user.invitation.resent",
          actor: { type: "user", id: actor.id },
          ...client,
          target: {
            type: "invitation",
            id: replaced.issued.invitation.invitationId,
            label: pending.email,
          },
          metadata: { role: pending.role, previousInvitationId: id },
        },
        tx,
      );
    }
    return replaced;
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
