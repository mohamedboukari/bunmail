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
import { redirect, setNoStore, toFlash } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { revealOwnerOf } from "../lib/reveal-owner.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";
import { dashboardClient } from "../lib/audit.ts";

/* ─── Invitation helpers (#217) ─── */

/** The account acting on invitations: id and role from the guard's `auth`. */
function inviteActorOf(auth: DashboardAuth): InviteActor {
  return { id: auth.user.id, role: auth.user.role };
}

/** Why the invitation email did not go out, in the inviter's flash message. */
const INVITE_MAIL_FAILURE_TEXT: Record<InviteMailFailure, string> = {
  not_configured: "no system sender is configured",
  sender_unavailable: "the system sender's domain is not registered or not DKIM-verified",
  send_failed: "sending failed",
  no_base_url: "APP_BASE_URL is not set, so no usable link could be emailed",
};

/** Flash text for a refused invitation action (other than a role refusal). */
const INVITE_REFUSAL_TEXT: Record<InviteRefusal, string> = {
  invalid_email: "Enter one valid email address.",
  role_not_allowed: "Your role cannot grant or manage that role.",
  account_exists: "An account already exists for that address.",
  pending_higher_role:
    "A pending invitation from a higher role exists for this address. Only the owner can replace it.",
  not_found: "Invitation not found: it may have been accepted, revoked or replaced.",
};

/** 302 back to the Invitations page with a flash message (never the link or token). */
function invitationsRedirect(
  set: Context["set"],
  message: string,
  type: "success" | "error",
  reveal?: string,
): string {
  const query = `flash=${encodeURIComponent(message)}&flashType=${type}`;
  return redirect(
    set,
    `/dashboard/invitations?${query}${reveal ? `&reveal=${reveal}` : ""}`,
  );
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
    return <ForbiddenPage message={INVITE_REFUSAL_TEXT.role_not_allowed} />;
  }
  return invitationsRedirect(set, INVITE_REFUSAL_TEXT[reason], "error");
}

/**
 * Answers a created or resent invitation. When the email went out, a
 * plain success flash. When it did not, the accept link is stashed for a
 * one-time reveal bound to this user and session (#280) and only the
 * reveal token goes in the redirect: the link itself never appears in a
 * URL, a flash message or a log.
 */
function answerIssuedInvitation(
  set: Context["set"],
  auth: DashboardAuth,
  result: IssueInvitationResult,
  verb: "sent" | "resent",
): string | Promise<string> {
  if (!result.ok) return answerInviteRefusal(set, result.reason);
  if (result.delivery.sent) {
    return invitationsRedirect(set, `Invitation ${verb} by email.`, "success");
  }
  const reveal = stashRevealSecret(result.url, "invite_link", revealOwnerOf(auth));
  return invitationsRedirect(
    set,
    `Invitation created, but the email was not sent: ${INVITE_MAIL_FAILURE_TEXT[result.delivery.reason]}. Copy the link below and share it with the invitee.`,
    "success",
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
          const flash = toFlash(query.flash, query.flashType);
          /** One-time reveal bound to this user and session (#280): never in a URL. */
          const revealedLink = consumeRevealSecret(
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
            flash: t.Optional(t.String()),
            flashType: t.Optional(t.String()),
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
            return answerIssuedInvitation(set, auth, result, "sent");
          } catch (error: unknown) {
            logger.error("Failed to create invitation via dashboard", {
              error: errorMessage(error),
            });
            return invitationsRedirect(set, "Failed to create the invitation.", "error");
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
          return invitationsRedirect(set, "Invitation revoked.", "success");
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
            return answerIssuedInvitation(set, auth, result, "resent");
          } catch (error: unknown) {
            logger.error("Failed to resend invitation via dashboard", {
              invitationId: params.id,
              error: errorMessage(error),
            });
            return invitationsRedirect(set, "Failed to resend the invitation.", "error");
          }
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String({ maxLength: 64 }) }),
        },
      )
  );
}
