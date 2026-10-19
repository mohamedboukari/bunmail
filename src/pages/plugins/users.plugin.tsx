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
import {
  resolveClientIp,
  isLoginRateLimited,
  recordFailedLogin,
  clearLoginAttempts,
  rateLimitBucket,
} from "../../middleware/login-rate-limit.ts";
import { UsersPage } from "../routes/users.tsx";
import { ForbiddenPage } from "../routes/forbidden.tsx";
import { adminGuard } from "../guards.tsx";
import * as userAdminService from "../../modules/users/services/user-admin.service.ts";
import { redirect, setNoStore, toFlash } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { revealOwnerOf } from "../lib/reveal-owner.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";
import { dashboardClient } from "../lib/audit.ts";

/* ─── Account management helpers (#218) ─── */

/**
 * Text for a refused account action. The first group can only come from
 * a crafted request (the Users page never offers the button), so it is
 * answered with the 403 page; the rest are races or typos and go back to
 * the page as an error flash.
 */
const ACCOUNT_REFUSAL_TEXT: Record<AccountRefusal, string> = {
  actor_inactive: "Your account can no longer manage accounts.",
  self: "You cannot change the role or status of your own account.",
  target_is_owner: "The owner cannot be demoted, deactivated or removed.",
  role_not_allowed: "Your role cannot do this to that account.",
  invalid_role: "An account can only be made an admin or a member here.",
  not_found: "Account not found: it may have been removed.",
  unchanged: "Nothing to change: the account already has that role or status.",
  confirm_mismatch: "Type the account's email address exactly to remove it.",
  wrong_password: "Wrong password: ownership was not transferred.",
  not_eligible: "Ownership can only go to an active admin.",
  rate_limited: "Too many failed attempts, try again later.",
  account_disabled: "Reactivate the account before resetting its password.",
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
  const { enabled, maxAttempts, windowSec } = config.dashboard.loginRateLimit;
  const windowMs = windowSec * 1000;
  /** IPv6 clients by /64, like the login (#256). */
  const keys = [`transfer:user:${actorId}`, `transfer:ip:${rateLimitBucket(ip)}`];
  return {
    isLimited: () =>
      enabled &&
      keys.some((key) => isLoginRateLimited(key, maxAttempts, windowMs).limited),
    record: () => {
      if (enabled) for (const key of keys) recordFailedLogin(key, windowMs);
    },
    clear: () => {
      for (const key of keys) clearLoginAttempts(key);
    },
  };
}

/** 302 back to the Users page with a flash message (never a link or token). */
function usersRedirect(
  set: Context["set"],
  message: string,
  type: "success" | "error",
  reveal?: string,
): string {
  const query = `flash=${encodeURIComponent(message)}&flashType=${type}`;
  return redirect(set, `/dashboard/users?${query}${reveal ? `&reveal=${reveal}` : ""}`);
}

/**
 * Answers an account action: a success flash, the 403 page for a
 * refusal only a crafted request can reach, or an error flash. The
 * service already logged the outcome.
 */
function answerAccountAction(
  set: Context["set"],
  result: AccountActionResult,
  success: string,
): string | Promise<string> {
  if (result.ok) return usersRedirect(set, success, "success");
  if (ACCOUNT_REFUSAL_FORBIDDEN.has(result.reason)) {
    set.status = 403;
    return <ForbiddenPage message={ACCOUNT_REFUSAL_TEXT[result.reason]} />;
  }
  return usersRedirect(set, ACCOUNT_REFUSAL_TEXT[result.reason], "error");
}

/**
 * Answers an issued password reset link (#277): the link is stashed for a
 * one-time reveal bound to this user and session (#280) and only the
 * reveal token goes in the redirect, so the link never appears in a URL,
 * a flash message or a log. A refusal is answered like any account action.
 */
function answerPasswordReset(
  set: Context["set"],
  auth: DashboardAuth,
  result: IssuePasswordResetResult,
): string | Promise<string> {
  if (!result.ok) return answerAccountAction(set, result, "");
  const reveal = stashRevealSecret(
    result.url,
    "password_reset_link",
    revealOwnerOf(auth),
  );
  const fallback = result.usedFallback
    ? " APP_BASE_URL is not set, so the link points at localhost."
    : "";
  return usersRedirect(
    set,
    `Password reset link created. Copy it below and share it privately: it works once, for one hour.${fallback}`,
    "success",
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
          const flash = toFlash(query.flash, query.flashType);
          /** One-time reveal of a reset link (#277), bound to this user and session (#280). */
          const revealedResetLink = consumeRevealSecret(
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
            flash: t.Optional(t.String()),
            flashType: t.Optional(t.String()),
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
          return answerAccountAction(set, result, `Role changed to ${body.role}.`);
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
          return answerAccountAction(set, result, "Account deactivated and signed out.");
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
          return answerAccountAction(set, result, "Account reactivated.");
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
          return answerAccountAction(set, result, "Account removed.");
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
          return answerAccountAction(
            set,
            result,
            "Ownership transferred. You are now an admin.",
          );
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
            return answerPasswordReset(set, auth, result);
          } catch (error: unknown) {
            logger.error("Failed to issue a password reset link via dashboard", {
              targetUserId: params.id,
              error: errorMessage(error),
            });
            return usersRedirect(
              set,
              "Failed to create the password reset link.",
              "error",
            );
          }
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String({ maxLength: 64 }) }),
        },
      )
  );
}
