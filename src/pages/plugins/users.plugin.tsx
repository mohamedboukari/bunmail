import { t, type Context } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import { consumeRevealSecret, stashRevealSecret } from "../reveal-store.ts";
import type {
  AccountActionResult,
  AccountRefusal,
  AttemptLimiter,
  DashboardAuth,
  IssuePasswordResetResult,
} from "../../modules/users/types/user.types.ts";
import { resolveClientIp, rateLimitBucket } from "../../middleware/login-rate-limit.ts";
import { loginBudgetLimiter } from "../lib/password-limiter.ts";
import { UsersPage } from "../routes/users.tsx";
import { ForbiddenPage } from "../routes/forbidden.tsx";
import { adminGuard } from "../guards.tsx";
import * as userAdminService from "../../modules/users/services/user-admin.service.ts";
import { redirect, setNoStore } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { revealOwnerOf } from "../lib/reveal-owner.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";
import { dashboardClient } from "../lib/audit.ts";
import { FLASH_QUERY, flashMessage, flashUrl, toFlash } from "../lib/flash.ts";
import type { FlashCode } from "../lib/flash-codes.ts";

/* ─── Account management helpers (#218) ─── */

/**
 * Flash code for a refused account action (#421: the message is looked up
 * by code). The first group can only come from a crafted request (the
 * Users page never offers the button), so it is answered with the 403
 * page, showing the code's message; the rest are races or typos and go
 * back to the page as an error flash.
 */
const ACCOUNT_REFUSAL_FLASH: Record<AccountRefusal, FlashCode> = {
  actor_inactive: "account_actor_inactive",
  self: "account_self",
  target_is_owner: "account_target_is_owner",
  role_not_allowed: "account_role_not_allowed",
  invalid_role: "account_invalid_role",
  not_found: "account_not_found",
  unchanged: "account_unchanged",
  confirm_mismatch: "account_confirm_mismatch",
  wrong_password: "account_wrong_password",
  not_eligible: "account_not_eligible",
  sso_link_without_second_factor: "account_sso_link_without_second_factor",
  rate_limited: "account_rate_limited",
  account_disabled: "account_disabled",
};

/** Refusals answered with the 403 page: no button on the page leads to them. */
const ACCOUNT_REFUSAL_FORBIDDEN: ReadonlySet<AccountRefusal> = new Set<AccountRefusal>([
  "actor_inactive",
  "self",
  "target_is_owner",
  "role_not_allowed",
  "invalid_role",
]);

/**
 * Failed-attempt budget for the ownership transfer password check (#218):
 * the login limiter's primitives and settings (`DASHBOARD_LOGIN_RATE_LIMIT_*`),
 * with keys of its own, one per actor and one per client IP, so neither a
 * stolen session nor one address can guess faster than a login could.
 * The `transfer:` prefix keeps them apart from the login keys: a
 * successful login never clears them. No-op when the limiter is off.
 */
function transferLimiter(actorId: string, ip: string): AttemptLimiter {
  /** IPv6 clients by /64, like the login (#256). */
  return loginBudgetLimiter([
    `transfer:user:${actorId}`,
    `transfer:ip:${rateLimitBucket(ip)}`,
  ]);
}

/** 302 back to the Users page with a flash code (never a link or token). */
function usersRedirect(set: Context["set"], code: FlashCode, reveal?: string): string {
  const location = flashUrl("/dashboard/users", code);
  return redirect(set, `${location}${reveal ? `&reveal=${reveal}` : ""}`);
}

/**
 * Answers an account action: a success flash, the 403 page for a
 * refusal only a crafted request can reach, or an error flash. The
 * service already logged the outcome.
 */
function answerAccountAction(
  set: Context["set"],
  result: AccountActionResult,
  success: FlashCode,
): string | Promise<string> {
  if (result.ok) return usersRedirect(set, success);
  if (ACCOUNT_REFUSAL_FORBIDDEN.has(result.reason)) {
    set.status = 403;
    return <ForbiddenPage message={flashMessage(ACCOUNT_REFUSAL_FLASH[result.reason])} />;
  }
  return usersRedirect(set, ACCOUNT_REFUSAL_FLASH[result.reason]);
}

/**
 * Answers an issued password reset link (#277): the link is stashed for a
 * one-time reveal bound to this user and session (#280) and only the
 * reveal token goes in the redirect, so the link never appears in a URL,
 * a flash message or a log. A refusal is answered like any account action.
 */
async function answerPasswordReset(
  set: Context["set"],
  auth: DashboardAuth,
  result: IssuePasswordResetResult,
): Promise<string> {
  /** `success` is unused on a refusal. */
  if (!result.ok) return answerAccountAction(set, result, "reset_link_created");
  const reveal = await stashRevealSecret(
    result.url,
    "password_reset_link",
    revealOwnerOf(auth),
  );
  return usersRedirect(
    set,
    result.usedFallback ? "reset_link_created_localhost" : "reset_link_created",
    reveal,
  );
}

/**
 * Account management pages (#291): the Users list and its role, status,
 * removal, ownership transfer and password reset actions.
 */
export function userPages(app: GuardedDashboard) {
  return (
    app
      /**
       * GET /dashboard/users
       * Every account with its role and status (#218). Admins and the owner;
       * each row shows only the actions the viewer may take, and every action
       * route checks the rules again in the service.
       */
      .get(
        "/users",
        async ({ query, auth, set }) => {
          setNoStore(set);
          const accounts = await userAdminService.listAccounts();
          const flash = toFlash(query.flash, query.flashN);
          /** One-time reveal of a reset link (#277), bound to this user and session (#280). */
          const revealedResetLink = await consumeRevealSecret(
            query.reveal,
            "password_reset_link",
            revealOwnerOf(auth),
          );
          return (
            <UsersPage
              accounts={accounts}
              viewer={{ id: auth.user.id, role: auth.user.role, disabled: false }}
              flash={flash}
              revealedResetLink={revealedResetLink}
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
       * POST /dashboard/users/:id/role
       * Makes an account an admin or a member (#218). Owner only, never to or
       * from owner, never the actor's own account: checked by the service
       * against the live rows. Demoting an admin revokes its open invitations.
       */
      .post(
        "/users/:id/role",
        async ({ params, body, set, auth, request, server }) => {
          const result = await userAdminService.changeAccountRole(
            auth.user.id,
            params.id,
            body.role,
            dashboardClient(request, server),
          );
          /** A success means the role was `admin` or `member` (else `invalid_role`). */
          return answerAccountAction(
            set,
            result,
            body.role === "admin" ? "account_role_admin" : "account_role_member",
          );
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String({ maxLength: 64 }) }),
          body: t.Object({ role: t.String({ maxLength: 20 }) }),
        },
      )

      /**
       * POST /dashboard/users/:id/deactivate
       * Deactivates an account (#218): no login, every session revoked, its
       * open invitations revoked. The owner may target admins and members, an
       * admin members only.
       */
      .post(
        "/users/:id/deactivate",
        async ({ params, set, auth, request, server }) => {
          const result = await userAdminService.deactivateAccount(
            auth.user.id,
            params.id,
            dashboardClient(request, server),
          );
          return answerAccountAction(set, result, "account_deactivated");
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String({ maxLength: 64 }) }),
        },
      )

      /**
       * POST /dashboard/users/:id/reactivate
       * Lets a deactivated account sign in again (#218). Same rules as
       * deactivation.
       */
      .post(
        "/users/:id/reactivate",
        async ({ params, set, auth, request, server }) => {
          const result = await userAdminService.reactivateAccount(
            auth.user.id,
            params.id,
            dashboardClient(request, server),
          );
          return answerAccountAction(set, result, "account_reactivated");
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String({ maxLength: 64 }) }),
        },
      )

      /**
       * POST /dashboard/users/:id/remove
       * Deletes an account for good (#218), confirmed by typing its email.
       * Same rules as deactivation. Sessions and credentials go with it.
       */
      .post(
        "/users/:id/remove",
        async ({ params, body, set, auth, request, server }) => {
          const result = await userAdminService.removeAccount(
            auth.user.id,
            params.id,
            body.confirm,
            dashboardClient(request, server),
          );
          return answerAccountAction(set, result, "account_removed");
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String({ maxLength: 64 }) }),
          body: t.Object({ confirm: t.String({ maxLength: 320 }) }),
        },
      )

      /**
       * POST /dashboard/users/:id/transfer
       * Hands ownership to an active admin (#218), confirmed with the owner's
       * current password. Owner only (checked in the service). The password
       * check is throttled per actor and per client IP with the login limits
       * (`transferLimiter`). The owner becomes an admin; both stay signed in.
       */
      .post(
        "/users/:id/transfer",
        async ({ params, body, set, auth, request, server }) => {
          const ip = resolveClientIp({
            socketIp: server?.requestIP(request)?.address,
            forwardedFor: request.headers.get("x-forwarded-for"),
            trustedProxyHops: config.dashboard.trustedProxyHops,
          });
          const result = await userAdminService.transferOwnership(
            auth.user.id,
            params.id,
            body.password,
            transferLimiter(auth.user.id, ip),
            { ip, userAgent: request.headers.get("user-agent") },
          );
          return answerAccountAction(set, result, "ownership_transferred");
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String({ maxLength: 64 }) }),
          body: t.Object({ password: t.String({ maxLength: 1024 }) }),
        },
      )

      /**
       * POST /dashboard/users/:id/reset-password
       * Issues a one-time password reset link for an account (#277): the
       * owner for admins and members, an admin for members; never the actor's
       * own account, never the owner (who uses `reset-owner`), never a
       * deactivated account. Checked by the service against the live rows.
       * The link is revealed once to this user and session on the Users page;
       * it is never emailed, and never in a URL, a flash message or a log.
       */
      .post(
        "/users/:id/reset-password",
        async ({ params, set, auth, request, server }) => {
          try {
            const result = await userAdminService.issuePasswordReset(
              auth.user.id,
              params.id,
              dashboardClient(request, server),
            );
            return await answerPasswordReset(set, auth, result);
          } catch (error: unknown) {
            logger.error("Failed to issue a password reset link via dashboard", {
              targetUserId: params.id,
              error: errorMessage(error),
            });
            return usersRedirect(set, "reset_link_failed");
          }
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String({ maxLength: 64 }) }),
        },
      )
  );
}
