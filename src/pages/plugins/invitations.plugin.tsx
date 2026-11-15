import { t, type Context } from "elysia";
import { logger } from "../../utils/logger.ts";
import { consumeRevealSecret, stashRevealSecret } from "../reveal-store.ts";
import type {
  DashboardAuth,
  InviteActor,
  InviteMailFailure,
  InviteRefusal,
  IssueInvitationResult,
} from "../../modules/users/types/user.types.ts";
import { InvitationsPage } from "../routes/invitations.tsx";
import { ForbiddenPage } from "../routes/forbidden.tsx";
import { adminGuard } from "../guards.tsx";
import * as inviteService from "../../modules/users/services/invite.service.ts";
import { grantableRoles } from "../../modules/users/services/invite-policy.service.ts";
import { redirect, setNoStore } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { revealOwnerOf } from "../lib/reveal-owner.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";
import { dashboardClient } from "../lib/audit.ts";
import { FLASH_QUERY, flashMessage, flashUrl, toFlash } from "../lib/flash.ts";
import type { FlashCode } from "../lib/flash-codes.ts";

/* ─── Invitation helpers (#217) ─── */

/** The account acting on invitations: id and role from the guard's `auth`. */
function inviteActorOf(auth: DashboardAuth): InviteActor {
  return { id: auth.user.id, role: auth.user.role };
}

/**
 * The inviter's flash code when the invitation email did not go out, one
 * per reason (#421: the message, with the reason in words, is looked up by
 * code).
 */
const INVITE_MAIL_FAILURE_FLASH: Record<InviteMailFailure, FlashCode> = {
  not_configured: "invitation_unsent_not_configured",
  sender_unavailable: "invitation_unsent_sender_unavailable",
  send_failed: "invitation_unsent_send_failed",
  no_base_url: "invitation_unsent_no_base_url",
};

/** Flash code for a refused invitation action (a role refusal shows its message on the 403 page). */
const INVITE_REFUSAL_FLASH: Record<InviteRefusal, FlashCode> = {
  invalid_email: "invite_invalid_email",
  role_not_allowed: "invite_role_not_allowed",
  account_exists: "invite_account_exists",
  pending_higher_role: "invite_pending_higher_role",
  not_found: "invite_not_found",
};

/** 302 back to the Invitations page with a flash code (never the link or token). */
function invitationsRedirect(
  set: Context["set"],
  code: FlashCode,
  reveal?: string,
): string {
  const location = flashUrl("/dashboard/invitations", code);
  return redirect(set, `${location}${reveal ? `&reveal=${reveal}` : ""}`);
}

/**
 * Answers a refused invitation action: a role the actor cannot grant is a
 * crafted request (the form never offers it), so it gets the 403 page;
 * anything else goes back to the page with an error flash. The service
 * already logged the refusal.
 */
function answerInviteRefusal(
  set: Context["set"],
  reason: InviteRefusal,
): string | Promise<string> {
  if (reason === "role_not_allowed") {
    set.status = 403;
    return (
      <ForbiddenPage message={flashMessage(INVITE_REFUSAL_FLASH.role_not_allowed)} />
    );
  }
  return invitationsRedirect(set, INVITE_REFUSAL_FLASH[reason]);
}

/**
 * Answers a created or resent invitation. When the email went out, a
 * plain success flash. When it did not, the accept link is stashed for a
 * one-time reveal bound to this user and session (#280) and only the
 * reveal token goes in the redirect: the link itself never appears in a
 * URL, a flash message or a log.
 */
async function answerIssuedInvitation(
  set: Context["set"],
  auth: DashboardAuth,
  result: IssueInvitationResult,
  verb: "sent" | "resent",
): Promise<string> {
  if (!result.ok) return answerInviteRefusal(set, result.reason);
  if (result.delivery.sent) {
    return invitationsRedirect(
      set,
      verb === "sent" ? "invitation_sent" : "invitation_resent",
    );
  }
  const reveal = await stashRevealSecret(result.url, "invite_link", revealOwnerOf(auth));
  return invitationsRedirect(
    set,
    INVITE_MAIL_FAILURE_FLASH[result.delivery.reason],
    reveal,
  );
}

/** Invitation pages (#291): pending invitations, invite, revoke, resend. */
export function invitationPages(app: GuardedDashboard) {
  return (
    app
      /**
       * GET /dashboard/invitations
       * Pending invitations, the invite form and, right after an invitation
       * whose email did not go out, its accept link once (#217). Admins and
       * the owner; the role select offers only what the viewer may grant.
       */
      .get(
        "/invitations",
        async ({ query, auth, set }) => {
          setNoStore(set);
          const invitations = await inviteService.listPendingInvitations();
          const flash = toFlash(query.flash, query.flashN);
          /** One-time reveal bound to this user and session (#280): never in a URL. */
          const revealedLink = await consumeRevealSecret(
            query.reveal,
            "invite_link",
            revealOwnerOf(auth),
          );
          return (
            <InvitationsPage
              invitations={invitations}
              grantable={grantableRoles(auth.user.role)}
              flash={flash}
              revealedLink={revealedLink}
            />
          );
        },
        {
          beforeHandle: adminGuard,
          query: t.Object({
            ...FLASH_QUERY,
            reveal: t.Optional(t.String()),
          }),
        },
      )

      /**
       * POST /dashboard/invitations
       * Invites an address with a role (#217). The service re-checks the role
       * against the actor's (owner: admin or member; admin: member), so a
       * crafted `owner` or an admin asking for `admin` gets 403. The email is
       * sent when a system sender is usable; otherwise the link is revealed
       * once on the page.
       */
      .post(
        "/invitations",
        async ({ body, set, auth, request, server }) => {
          try {
            const result = await inviteService.createInvitation(
              inviteActorOf(auth),
              body.email,
              body.role,
              dashboardClient(request, server),
            );
            return await answerIssuedInvitation(set, auth, result, "sent");
          } catch (error: unknown) {
            logger.error("Failed to create invitation via dashboard", {
              error: errorMessage(error),
            });
            return invitationsRedirect(set, "invitation_create_failed");
          }
        },
        {
          beforeHandle: adminGuard,
          body: t.Object({
            email: t.String({ maxLength: 320 }),
            role: t.String({ maxLength: 20 }),
          }),
        },
      )

      /**
       * POST /dashboard/invitations/:id/revoke
       * Revokes a pending invitation (#217); its link stops working. Only for
       * a role the actor may grant.
       */
      .post(
        "/invitations/:id/revoke",
        async ({ params, set, auth, request, server }) => {
          const result = await inviteService.revokeInvitation(
            inviteActorOf(auth),
            params.id,
            dashboardClient(request, server),
          );
          if (!result.ok) return answerInviteRefusal(set, result.reason);
          return invitationsRedirect(set, "invitation_revoked");
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String({ maxLength: 64 }) }),
        },
      )

      /**
       * POST /dashboard/invitations/:id/resend
       * Replaces a pending invitation with a new link (same address and role;
       * the old link dies) and sends it again, or reveals it once (#217).
       * Only for a role the actor may grant.
       */
      .post(
        "/invitations/:id/resend",
        async ({ params, set, auth, request, server }) => {
          try {
            const result = await inviteService.resendInvitation(
              inviteActorOf(auth),
              params.id,
              dashboardClient(request, server),
            );
            return await answerIssuedInvitation(set, auth, result, "resent");
          } catch (error: unknown) {
            logger.error("Failed to resend invitation via dashboard", {
              invitationId: params.id,
              error: errorMessage(error),
            });
            return invitationsRedirect(set, "invitation_resend_failed");
          }
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String({ maxLength: 64 }) }),
        },
      )
  );
}
