import { Elysia, t, type Context } from "elysia";
import { html } from "@elysiajs/html";
import { config } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { setLogContextUser } from "../utils/log-context.ts";
import {
  consumeRevealSecret,
  stashRevealSecret,
  type RevealOwner,
} from "./reveal-store.ts";
import type {
  AccountActionResult,
  AccountRefusal,
  AttemptLimiter,
  DashboardAuth,
  InviteActor,
  InviteMailFailure,
  InviteRefusal,
  IssueInvitationResult,
} from "../modules/users/types/user.types.ts";
import { redactEmail } from "../utils/redact.ts";
import {
  resolveClientIp,
  isLoginRateLimited,
  recordFailedLogin,
  clearLoginAttempts,
} from "../middleware/login-rate-limit.ts";
import { isEmailStatus } from "../modules/emails/types/email.types.ts";

/* ─── Page Components ─── */
import { LoginPage } from "./routes/login.tsx";
import { OwnerSetupPage, OwnerSetupInvalidPage } from "./routes/setup.tsx";
import {
  InviteAcceptPage,
  InviteAccountExistsPage,
  InviteInvalidPage,
} from "./routes/invite.tsx";
import { InvitationsPage } from "./routes/invitations.tsx";
import { UsersPage } from "./routes/users.tsx";
import { ForbiddenPage } from "./routes/forbidden.tsx";
import { HomePage } from "./routes/home.tsx";
import { EmailsPage } from "./routes/emails.tsx";
import { EmailTombstonesPage } from "./routes/email-tombstones.tsx";
import { EmailsTrashPage } from "./routes/emails-trash.tsx";
import { EmailDetailPage } from "./routes/email-detail.tsx";
import { ApiKeysPage } from "./routes/api-keys.tsx";
import { DomainsPage } from "./routes/domains.tsx";
import { DomainDetailPage } from "./routes/domain-detail.tsx";
import { SendEmailPage } from "./routes/send-email.tsx";
import { TemplatesPage } from "./routes/templates.tsx";
import { TemplateDetailPage } from "./routes/template-detail.tsx";
import { WebhooksPage } from "./routes/webhooks.tsx";
import { WebhookDeliveriesPage } from "./routes/webhook-deliveries.tsx";
import { WebhookDeliveryDetailPage } from "./routes/webhook-delivery-detail.tsx";
import { InboundPage } from "./routes/inbound.tsx";
import { InboundTrashPage } from "./routes/inbound-trash.tsx";
import { InboundDetailPage } from "./routes/inbound-detail.tsx";
import { DmarcReportsPage } from "./routes/dmarc-reports.tsx";
import { DmarcReportDetailPage } from "./routes/dmarc-report-detail.tsx";
import { SuppressionsPage } from "./routes/suppressions.tsx";
import { clearSessionCookie, readSessionCookie, sessionSetCookie } from "./session.ts";
import { adminGuard, memberGuard, roleAtLeast, toDashboardAuth } from "./guards.tsx";
import { setViewerRole } from "./viewer.ts";
import { parsePagination } from "./pagination.ts";

/* ─── Services ─── */
import * as statsService from "../modules/emails/services/stats.service.ts";
import * as emailService from "../modules/emails/services/email.service.ts";
import * as tombstoneService from "../modules/emails/services/tombstone.service.ts";
import * as apiKeyService from "../modules/api-keys/services/api-key.service.ts";
import * as domainService from "../modules/domains/services/domain.service.ts";
import * as templateService from "../modules/templates/services/template.service.ts";
import * as webhookService from "../modules/webhooks/services/webhook.service.ts";
import * as webhookDeliveryService from "../modules/webhooks/services/webhook-delivery.service.ts";
import * as inboundService from "../modules/inbound/services/inbound.service.ts";
import * as dmarcReportsService from "../modules/dmarc-reports/services/dmarc-reports.service.ts";
import * as suppressionService from "../modules/suppressions/services/suppression.service.ts";
import { verifyDomain } from "../modules/domains/services/dns-verification.service.ts";
import * as ownerService from "../modules/users/services/owner.service.ts";
import * as sessionService from "../modules/users/services/session.service.ts";
import * as loginService from "../modules/users/services/login.service.ts";
import * as inviteService from "../modules/users/services/invite.service.ts";
import * as userAdminService from "../modules/users/services/user-admin.service.ts";
import {
  grantableRoles,
  inviteNameProblem,
} from "../modules/users/services/invite-policy.service.ts";
import {
  isWellFormedSetupToken,
  setupPasswordProblem,
} from "../modules/users/services/owner-setup-policy.service.ts";
import {
  SESSION_ABSOLUTE_SECONDS,
  loginInputTooLong,
  normalizeLoginEmail,
} from "../modules/users/services/session-policy.service.ts";
import { isWellFormedToken } from "../modules/users/services/token.service.ts";

/**
 * Normalises a form field that can come back either as a single string
 * (one checkbox checked) or an array (many checkboxes). Repeated form
 * fields like `ids=a&ids=b` produce different shapes depending on the
 * runtime parser, so we always coerce to `string[]`.
 */
function toIdArray(input: string | string[]): string[] {
  return Array.isArray(input) ? input : [input];
}

/**
 * Parses the comma-joined value the allowed-senders chip input submits
 * (#126) into a trimmed, non-empty address array. Empty string → `[]`
 * (unrestricted). The service normalises (lower-case + dedupe) again.
 */
function parseSenderList(input: string | undefined): string[] {
  return (input ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ─── Session Helpers ─── */

/**
 * `Secure` on the session cookie in production (#133), so it is never
 * sent over plaintext HTTP. Not in development, which runs over
 * `http://localhost` without TLS.
 */
function secureCookies(): boolean {
  return config.env === "production";
}

/**
 * Puts a session token in the `bm_session` cookie (#216): HttpOnly,
 * SameSite=Lax, Secure in production, Path=/dashboard. At login the
 * lifetime is the absolute cap; on rotation it is what is left of it. The
 * server enforces the idle timeout itself, so the cookie never needs
 * refreshing just to stay alive.
 */
function issueSession(
  set: Context["set"],
  token: string,
  maxAgeSec: number = SESSION_ABSOLUTE_SECONDS,
): void {
  set.headers["set-cookie"] = sessionSetCookie(token, secureCookies(), maxAgeSec);
}

/** Removes the `bm_session` cookie from the browser (same attributes, Max-Age=0). */
function clearSession(set: Context["set"]): void {
  set.headers["set-cookie"] = clearSessionCookie(secureCookies());
}

/** Answers with a 302 to `location`; the body is empty. */
function redirect(set: Context["set"], location: string): string {
  set.status = 302;
  set.headers["location"] = location;
  return "";
}

/** The message a browser sees when the session store cannot be reached. */
const SESSION_STORE_DOWN = "Dashboard temporarily unavailable";

/**
 * Message of an error for a log line. Users-module errors are already
 * `UserStoreError` (SQLSTATE only), so this never carries a token hash or
 * an email.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Token reuse (#216): a token the session already rotated away from was
 * presented, so two parties hold copies of the cookie. Every session of
 * the user is revoked (the thief's and the victim's) and the event is
 * logged; the caller then clears the cookie. Throws when the revoke fails,
 * so callers can fail closed.
 */
async function revokeOnTokenReuse(
  owner: { userId: string; sessionId: string },
  ip: string,
): Promise<void> {
  await sessionService.revokeAllUserSessions(owner.userId);
  logger.warn("Session token reuse detected: all sessions of the user revoked", {
    userId: owner.userId,
    sessionId: owner.sessionId,
    ip,
  });
}

/**
 * Leak hardening for the owner setup pages (#215), whose URL or form
 * carries a one-time setup token: never cached (`no-store`), not
 * MIME-sniffed, and not frameable (no clickjacking of the form).
 *
 * `Referrer-Policy: strict-origin` keeps the token URL out of every
 * `Referer` (the page loads a third-party CDN script, and our own access
 * logs record Referer too): requests carry the origin only. It must NOT be
 * `no-referrer`: under that policy browsers send `Origin: null` on the
 * form POST (Fetch spec, "append a request Origin header"), so
 * `isSameOrigin` would reject every real submission with 403.
 */
function setAuthPageHeaders(set: Context["set"]): void {
  set.headers["cache-control"] = "no-store";
  set.headers["referrer-policy"] = "strict-origin";
  set.headers["x-content-type-options"] = "nosniff";
  set.headers["x-frame-options"] = "DENY";
}

/**
 * CSRF origin check for state-mutating dashboard requests (#133).
 *
 * `SameSite=Lax` already blocks cross-site cookie-bearing POSTs in modern
 * browsers, but it's the *only* current defense and older/edge cases slip
 * through. As a second layer we verify that a POST's `Origin` (falling back
 * to `Referer`) host matches the request's own host. A cross-site form-POST
 * carries the attacker's Origin and is rejected; same-origin dashboard
 * forms always send a matching Origin. A POST with neither header present
 * is rejected (browsers send Origin on POST; its absence is anomalous).
 *
 * @returns true if the request is same-origin (allowed)
 */
function isSameOrigin(request: Request): boolean {
  /**
   * The target host is taken from the request URL (always present) and
   * cross-checked against the `Host` header when it exists: behind a proxy
   * the URL host may be the internal bind address while `Host` carries the
   * public name, so a match on *either* is same-origin.
   */
  const targets = new Set<string>();
  try {
    targets.add(new URL(request.url).host);
  } catch {
    /** malformed request URL: fall through to Host header only */
  }
  const hostHeader = request.headers.get("host");
  if (hostHeader) targets.add(hostHeader);
  if (targets.size === 0) return false;

  const source = request.headers.get("origin") ?? request.headers.get("referer");
  if (!source) return false;

  try {
    return targets.has(new URL(source).host);
  } catch {
    return false;
  }
}

/**
 * `Cache-Control: no-store` for pages that can render a one-time secret
 * (API key, webhook secret, invitation link): neither the browser nor a
 * proxy may keep a copy of the page that showed it.
 */
function setNoStore(set: Context["set"]): void {
  set.headers["cache-control"] = "no-store";
}

/**
 * The owner a one-time reveal is bound to (#280): the signed-in user and
 * the session that created it, from the guard's `auth` (#222).
 */
function revealOwnerOf(auth: DashboardAuth): RevealOwner {
  return { userId: auth.user.id, sessionId: auth.session.id };
}

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
  const keys = [`transfer:user:${actorId}`, `transfer:ip:${ip}`];
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

/** 302 back to the Users page with a flash message. */
function usersRedirect(
  set: Context["set"],
  message: string,
  type: "success" | "error",
): string {
  return redirect(
    set,
    `/dashboard/users?flash=${encodeURIComponent(message)}&flashType=${type}`,
  );
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

/* ─── DNS-verify throttle (#133) ─── */

/**
 * `POST /dashboard/domains/:id/verify` runs live DNS lookups (SPF/DKIM/DMARC)
 * with no throttle; the API rate-limiter only covers `/api/v1/*`. A rapid
 * click-loop (or a same-origin script) could hammer the resolver. This is a
 * lightweight per-domain sliding window: at most `DNS_VERIFY_MAX` verifies
 * per `DNS_VERIFY_WINDOW_MS` per domain id. In-memory/per-process (same
 * caveat as the other dashboard limiters). Keyed by domain id, not IP, since
 * the dashboard is a single shared operator: the resource we're protecting
 * is the DNS lookup for that domain.
 */
const DNS_VERIFY_MAX = 5;
const DNS_VERIFY_WINDOW_MS = 60_000;
const dnsVerifyHits = new Map<string, number[]>();

/**
 * Records a verify attempt for `domainId` and returns true if it exceeds the
 * window budget (i.e. the caller should be throttled). Prunes timestamps
 * outside the window on each call so the map self-trims.
 */
function isDnsVerifyThrottled(domainId: string): boolean {
  const now = Date.now();
  const cutoff = now - DNS_VERIFY_WINDOW_MS;
  const recent = (dnsVerifyHits.get(domainId) ?? []).filter((ts) => ts > cutoff);
  recent.push(now);
  dnsVerifyHits.set(domainId, recent);
  return recent.length > DNS_VERIFY_MAX;
}

/* ─── Dashboard Plugin ─── */

/**
 * Pages plugin: server-rendered dashboard under /dashboard.
 *
 * Routes:
 * - GET  /dashboard/login           → login form (email + password)
 * - POST /dashboard/login           → check email + password, open a session, set cookie
 * - POST /dashboard/logout          → revoke the session, clear cookie, redirect
 * - GET  /dashboard/setup?token=    → owner setup form (public, #215)
 * - POST /dashboard/setup           → set the owner password, sign in (public, #215)
 * - GET  /dashboard/invite?token=   → invitation accept form (public, #217)
 * - POST /dashboard/invite          → create the invited account, sign in (public, #217)
 * - GET  /dashboard                 → home (stats overview)
 * - GET  /dashboard/emails          → email list with filters
 * - GET  /dashboard/emails/:id      → email detail
 * - GET  /dashboard/api-keys        → API keys list + create form
 * - POST /dashboard/api-keys        → create API key (form action)
 * - POST /dashboard/api-keys/:id/revoke → revoke API key (form action)
 * - GET  /dashboard/invitations     → pending invitations + invite form (admin, #217)
 * - POST /dashboard/invitations     → invite an address (admin, #217)
 * - POST /dashboard/invitations/:id/revoke → revoke an invitation (admin, #217)
 * - POST /dashboard/invitations/:id/resend → new link, sent again (admin, #217)
 * - GET  /dashboard/users           → every account + allowed actions (admin, #218)
 * - POST /dashboard/users/:id/role  → member <-> admin (owner, checked in the service)
 * - POST /dashboard/users/:id/deactivate → disable + sign out (admin, #218)
 * - POST /dashboard/users/:id/reactivate → enable again (admin, #218)
 * - POST /dashboard/users/:id/remove → delete, confirmed by email (admin, #218)
 * - POST /dashboard/users/:id/transfer → hand ownership to an admin (owner, checked in the service)
 * - GET  /dashboard/domains         → domains list + add form
 * - POST /dashboard/domains         → add domain (form action)
 * - POST /dashboard/domains/:id/delete → delete domain (form action)
 * - GET  /dashboard/domains/:id     → domain detail
 *
 * Auth (#216): account login with email and password against
 * `user_credentials`, then a server-side session in the `sessions` table
 * whose opaque token rides in the `bm_session` cookie and rotates every
 * minute. The owner setup and invitation accept routes are authorized
 * by their one-time token.
 *
 * Roles (#222): the session guard puts the signed-in account on `auth`,
 * and every protected route carries a role check from `guards.tsx` as its
 * own `beforeHandle`: `memberGuard` (any signed-in account), `adminGuard`
 * or `ownerGuard`. A new route needs one of them and an entry in the
 * route table of `dashboard-route-access.integration.test.ts`.
 */

/**
 * Builds the flash-banner prop from the `flash` / `flashType` query
 * params. Both are attacker-controllable, so `flashType` is narrowed to
 * the two values the banner actually renders rather than asserted: an
 * `as "success" | "error"` cast would let an arbitrary string through
 * wearing the union's type.
 */
function toFlash(
  message: string | undefined,
  rawType: string | undefined,
): { message: string; type: "success" | "error" } | undefined {
  if (!message) return undefined;
  return { message, type: rawType === "error" ? "error" : "success" };
}

export const pagesPlugin = new Elysia({
  prefix: "/dashboard",
  normalize: true,
  detail: { hide: true },
})
  /** Enable JSX rendering via @elysiajs/html */
  .use(html())

  /* ─── Public Routes (no session required) ─── */

  /**
   * GET /dashboard/login
   * Shows the email and password form. Gets the auth-page headers (no
   * caching, no framing). The error text is the same for every failed
   * login, so it never says whether an account exists.
   */
  .get(
    "/login",
    ({ query, set }) => {
      setAuthPageHeaders(set);
      const error = query.error === "invalid" ? "Invalid email or password." : undefined;
      return <LoginPage error={error} />;
    },
    {
      query: t.Object({
        error: t.Optional(t.String()),
      }),
    },
  )

  /**
   * POST /dashboard/login
   * Email and password login (#216). In order: auth-page headers; a
   * same-origin check (blocks login CSRF, which would sign a victim into
   * the attacker's account); the per-IP limiter (#109), before any
   * database or argon2id work; the input bounds; then exactly one argon2id
   * verify on every branch (`verifyPasswordLogin`).
   *
   * Every failure (unknown email, no password, disabled account, wrong
   * password, over-long input) counts against the IP and gets the same
   * redirect to `?error=invalid`; the reason only reaches the server log.
   * The email never goes in the URL.
   *
   * On success a fresh session is opened (a session the browser already
   * presented is revoked first, so sessions do not stack and a planted
   * cookie cannot survive login) and the browser is sent to the fixed
   * `/dashboard`: no `next` parameter, no open redirect.
   *
   * The body schema is deliberately loose (only generous length caps): a
   * schema failure answers 422 JSON from the global handler, not a page,
   * so the real bounds are checked in the handler.
   */
  .post(
    "/login",
    async ({ body, set, request, server }) => {
      setAuthPageHeaders(set);
      const { loginRateLimit, trustedProxyHops } = config.dashboard;
      const ip = resolveClientIp({
        socketIp: server?.requestIP(request)?.address,
        forwardedFor: request.headers.get("x-forwarded-for"),
        trustedProxyHops,
      });

      if (!isSameOrigin(request)) {
        logger.warn("Dashboard login POST rejected: cross-origin (possible CSRF)", {
          ip,
          origin: request.headers.get("origin") ?? request.headers.get("referer") ?? null,
        });
        set.status = 403;
        return "Forbidden: cross-origin request rejected";
      }

      /**
       * Brute-force protection (#109). Lockout is checked first, then the
       * attempt is counted right away, before any await: the password
       * check (argon2id) takes tens of milliseconds, and counting only
       * after it would let a parallel burst from one IP pass the limit,
       * each request running a full hash. A successful login clears the
       * counter.
       */
      const windowMs = loginRateLimit.windowSec * 1000;
      if (loginRateLimit.enabled) {
        const { limited, retryAfterSec } = isLoginRateLimited(
          ip,
          loginRateLimit.maxAttempts,
          windowMs,
        );
        if (limited) {
          logger.warn("Dashboard login blocked: too many attempts", {
            ip,
            retryAfterSec,
          });
          set.status = 429;
          set.headers["retry-after"] = String(retryAfterSec);
          const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
          return (
            <LoginPage
              error={`Too many failed attempts. Try again in ${minutes} minute(s).`}
              disabled={true}
            />
          );
        }
        recordFailedLogin(ip, windowMs);
      }

      const email = normalizeLoginEmail(body.email);
      const tooLong = loginInputTooLong(email, body.password);

      try {
        const result = tooLong
          ? null
          : await loginService.verifyPasswordLogin(email, body.password);

        if (!result?.ok) {
          /** Already counted before the password check. */
          logger.warn("Dashboard login failed", {
            ip,
            reason: result ? result.reason : "too_long",
            ...(result ? { email: redactEmail(email) } : {}),
          });
          return redirect(set, "/dashboard/login?error=invalid");
        }

        /** Success: wipe any accumulated failures for this IP. */
        if (loginRateLimit.enabled) clearLoginAttempts(ip);

        /**
         * Replace the browser's previous session. A token the session had
         * already rotated away from means a copy is in other hands (for
         * example a victim signing in again while a thief keeps the stolen
         * session alive): treat it as reuse and revoke every session of
         * that user before opening the new one.
         */
        const presented = readSessionCookie(request.headers.get("cookie"));
        if (presented && isWellFormedToken(presented)) {
          const revoked = await sessionService.revokeSessionByToken(presented);
          if (!revoked) {
            const superseded =
              await sessionService.findSessionBySupersededToken(presented);
            if (superseded) await revokeOnTokenReuse(superseded, ip);
          }
        }

        const { sessionId, token } = await sessionService.createSession({
          userId: result.userId,
          assurance: result.assurance,
          authMethod: "password",
          ip,
          userAgent: request.headers.get("user-agent"),
        });
        logger.info("Dashboard login successful", {
          userId: result.userId,
          sessionId,
          ip,
        });

        issueSession(set, token);
        return redirect(set, "/dashboard");
      } catch (error: unknown) {
        logger.error("Dashboard login failed: session store error", {
          ip,
          error: errorMessage(error),
        });
        set.status = 503;
        return SESSION_STORE_DOWN;
      }
    },
    {
      body: t.Object({
        email: t.String({ maxLength: 320 }),
        password: t.String({ maxLength: 1024 }),
      }),
    },
  )

  /**
   * POST /dashboard/logout
   * Revokes the session (deletes its row) and clears the cookie (#216).
   * Same-origin only, so a third-party page cannot sign the operator out.
   * Works for missing, malformed, already revoked and legacy cookies: the
   * cookie is always cleared. A database error is logged and the cookie
   * is still cleared. Replaying the old cookie afterwards gets a 302 to
   * the login page.
   */
  .post("/logout", async ({ set, request, server }) => {
    const ip = resolveClientIp({
      socketIp: server?.requestIP(request)?.address,
      forwardedFor: request.headers.get("x-forwarded-for"),
      trustedProxyHops: config.dashboard.trustedProxyHops,
    });

    if (!isSameOrigin(request)) {
      logger.warn("Dashboard logout POST rejected: cross-origin (possible CSRF)", {
        ip,
        origin: request.headers.get("origin") ?? request.headers.get("referer") ?? null,
      });
      set.status = 403;
      return "Forbidden: cross-origin request rejected";
    }

    const token = readSessionCookie(request.headers.get("cookie"));
    if (token && isWellFormedToken(token)) {
      try {
        const sessionId = await sessionService.revokeSessionByToken(token);
        if (!sessionId) {
          /** A superseded token: someone else holds the live one. */
          const superseded = await sessionService.findSessionBySupersededToken(token);
          if (superseded) await revokeOnTokenReuse(superseded, ip);
        }
        logger.info("Dashboard logout", { sessionId, ip });
      } catch (error: unknown) {
        logger.error("Dashboard logout: session revoke failed", {
          ip,
          error: errorMessage(error),
        });
      }
    } else {
      logger.info("Dashboard logout", { sessionId: null, ip });
    }

    clearSession(set);
    return redirect(set, "/dashboard/login");
  })

  /**
   * GET /dashboard/setup?token=...
   * Owner setup form from the one-time link logged on first boot (#215).
   * Public: the token is the authorization. Read-only, so link scanners
   * and prefetchers cannot burn it. The format is checked before any
   * database call, and every unusable link (missing, malformed, unknown,
   * expired, used, replaced) gets the same 400 page: no oracle, and the
   * token is never echoed.
   */
  .get(
    "/setup",
    async ({ query, set }) => {
      setAuthPageHeaders(set);
      const token = query.token ?? "";
      const setup = isWellFormedSetupToken(token)
        ? await ownerService.findLiveOwnerSetup(token)
        : null;
      if (!setup) {
        set.status = 400;
        return <OwnerSetupInvalidPage />;
      }
      return <OwnerSetupPage token={token} email={setup.email} />;
    },
    {
      query: t.Object({
        token: t.Optional(t.String({ maxLength: 128 })),
      }),
    },
  )

  /**
   * POST /dashboard/setup
   * Sets the owner password and spends the token (#215). The session
   * guard's CSRF check never runs for public routes, so same-origin is
   * checked here, first, before any work. Then cheap checks before
   * expensive ones: token format, an indexed lookup, the password policy
   * (a failure re-renders the form with 200, no hashing, no write), and
   * only then argon2id inside `completeOwnerSetup`.
   *
   * On success `completeOwnerSetup` has, in one transaction, deleted every
   * session of the owner and opened a new one (#216); its token is set as
   * the cookie and the browser is redirected to `/dashboard`, which also
   * drops the setup token from the address bar.
   *
   * The body schema is deliberately loose (only length caps): a schema
   * failure answers 422 JSON from the global handler, not a page, so the
   * policy is enforced in the handler instead.
   */
  .post(
    "/setup",
    async ({ body, set, request, server }) => {
      setAuthPageHeaders(set);
      const ip = resolveClientIp({
        socketIp: server?.requestIP(request)?.address,
        forwardedFor: request.headers.get("x-forwarded-for"),
        trustedProxyHops: config.dashboard.trustedProxyHops,
      });

      if (!isSameOrigin(request)) {
        logger.warn("Owner setup POST rejected: cross-origin (possible CSRF)", {
          ip,
          origin: request.headers.get("origin") ?? request.headers.get("referer") ?? null,
        });
        set.status = 403;
        return "Forbidden: cross-origin request rejected";
      }

      const setup = isWellFormedSetupToken(body.token)
        ? await ownerService.findLiveOwnerSetup(body.token)
        : null;
      if (!setup) {
        set.status = 400;
        return <OwnerSetupInvalidPage />;
      }

      const problem = setupPasswordProblem(body.password, body.confirm);
      if (problem) {
        return <OwnerSetupPage token={body.token} email={setup.email} error={problem} />;
      }

      const owner = await ownerService.completeOwnerSetup(body.token, body.password, {
        ip,
        userAgent: request.headers.get("user-agent"),
      });
      if (!owner) {
        set.status = 400;
        return <OwnerSetupInvalidPage />;
      }

      logger.warn("Owner setup completed", { owner: redactEmail(owner.email), ip });

      issueSession(set, owner.sessionToken);
      return redirect(set, "/dashboard");
    },
    {
      body: t.Object({
        token: t.String({ maxLength: 128 }),
        password: t.String({ maxLength: 1024 }),
        confirm: t.String({ maxLength: 1024 }),
      }),
    },
  )

  /**
   * GET /dashboard/invite?token=...
   * Invitation accept form (#217). Public: the token is the authorization.
   * Mirrors the owner setup page: auth-page headers, read-only (link
   * scanners and prefetchers cannot burn the token), the format checked
   * before any database call, and one identical 400 page for every
   * unusable link (missing, malformed, unknown, expired, used, revoked).
   */
  .get(
    "/invite",
    async ({ query, set }) => {
      setAuthPageHeaders(set);
      const token = query.token ?? "";
      const target = isWellFormedToken(token)
        ? await inviteService.findLiveInvitation(token)
        : null;
      if (!target) {
        set.status = 400;
        return <InviteInvalidPage />;
      }
      return <InviteAcceptPage token={token} email={target.email} role={target.role} />;
    },
    {
      query: t.Object({
        token: t.Optional(t.String({ maxLength: 128 })),
      }),
    },
  )

  /**
   * POST /dashboard/invite
   * Creates the invited account and signs it in (#217). Same order as the
   * owner setup POST: auth-page headers; same-origin first (the session
   * guard's CSRF check never runs on public routes); token format; an
   * indexed lookup; the name and password policy (a failure re-renders the
   * form with 200, no hashing, no write); only then argon2id inside
   * `acceptInvitation`, which creates the user, the credential and the
   * session in one transaction.
   *
   * On success the session the browser presented, if any, is revoked
   * (like login: sessions do not stack, and a superseded token is treated
   * as reuse), the new cookie is set and the browser goes to `/dashboard`,
   * which also drops the token from the address bar.
   *
   * The body schema is deliberately loose (only length caps): a schema
   * failure answers 422 JSON from the global handler, not a page.
   */
  .post(
    "/invite",
    async ({ body, set, request, server }) => {
      setAuthPageHeaders(set);
      const ip = resolveClientIp({
        socketIp: server?.requestIP(request)?.address,
        forwardedFor: request.headers.get("x-forwarded-for"),
        trustedProxyHops: config.dashboard.trustedProxyHops,
      });

      if (!isSameOrigin(request)) {
        logger.warn("Invitation accept POST rejected: cross-origin (possible CSRF)", {
          ip,
          origin: request.headers.get("origin") ?? request.headers.get("referer") ?? null,
        });
        set.status = 403;
        return "Forbidden: cross-origin request rejected";
      }

      const target = isWellFormedToken(body.token)
        ? await inviteService.findLiveInvitation(body.token)
        : null;
      if (!target) {
        set.status = 400;
        return <InviteInvalidPage />;
      }

      const name = body.name.trim();
      const problem =
        inviteNameProblem(name) ?? setupPasswordProblem(body.password, body.confirm);
      if (problem) {
        return (
          <InviteAcceptPage
            token={body.token}
            email={target.email}
            role={target.role}
            name={name}
            error={problem}
          />
        );
      }

      const result = await inviteService.acceptInvitation(
        body.token,
        { name, password: body.password },
        { ip, userAgent: request.headers.get("user-agent") },
      );
      if (!result.ok) {
        if (result.reason === "account_exists") {
          logger.warn("Invitation not accepted: an account already holds the address", {
            invitationId: target.invitationId,
            email: redactEmail(target.email),
            ip,
          });
          set.status = 409;
          return <InviteAccountExistsPage />;
        }
        set.status = 400;
        return <InviteInvalidPage />;
      }

      /**
       * Replace the browser's previous session, as login does. The account
       * already exists at this point, so a failure here is logged and the
       * new session is still issued.
       */
      const presented = readSessionCookie(request.headers.get("cookie"));
      if (presented && isWellFormedToken(presented)) {
        try {
          const revoked = await sessionService.revokeSessionByToken(presented);
          if (!revoked) {
            const superseded =
              await sessionService.findSessionBySupersededToken(presented);
            if (superseded) await revokeOnTokenReuse(superseded, ip);
          }
        } catch (error: unknown) {
          logger.error("Invitation accepted, but revoking the previous session failed", {
            userId: result.userId,
            ip,
            error: errorMessage(error),
          });
        }
      }

      logger.warn("Invitation accepted", {
        invitationId: target.invitationId,
        userId: result.userId,
        invitedBy: result.invitedBy,
        role: result.role,
        email: redactEmail(result.email),
        sessionId: result.sessionId,
        ip,
      });

      issueSession(set, result.sessionToken);
      return redirect(set, "/dashboard");
    },
    {
      body: t.Object({
        token: t.String({ maxLength: 128 }),
        name: t.String({ maxLength: 1024 }),
        password: t.String({ maxLength: 1024 }),
        confirm: t.String({ maxLength: 1024 }),
      }),
    },
  )

  /* ─── Session Guard ─── */

  /**
   * All routes below this guard require a live session (#216). In order:
   *
   * 1. No cookie: 302 to the login page.
   * 2. A cookie that is not a minted token (including a pre-#216
   *    `<ts>.<hmac>` cookie): cleared and redirected, with no database
   *    query.
   * 3. One indexed lookup (`findActiveSession`): the session must exist,
   *    be unexpired, belong to an enabled user and have `password` or
   *    `mfa` assurance. No row: cookie cleared, 302. A database error:
   *    503, never a pass-through (fail closed) and never a false logout.
   * 4. The token replaced by the last rotation, presented after the grace
   *    period, or any older superseded token (`session_token_history`):
   *    reuse detected. Two parties hold the session, so every session of
   *    the user is revoked, the cookie cleared, 302.
   * 5. A cross-origin POST: 403 (CSRF second layer, #133).
   * 6. The current token, older than a minute: rotated. The new token goes
   *    out with this response; when a parallel request rotated first, this
   *    one is served without a new cookie. A rotation error is logged and
   *    the request is served (the old token stays current).
   * 7. The request goes on with `auth` (#222): the account (id, email,
   *    role) and the session (id, assurance), all from the lookup in step
   *    3, so a request costs exactly one session query. Each route's own
   *    `beforeHandle` (`memberGuard`, `adminGuard`, `ownerGuard` from
   *    `guards.tsx`) then checks the role.
   *
   * It is a `resolve`, not an `onBeforeHandle`, so the type of `auth`
   * flows to every handler registered after it. A `resolve` can only stop
   * the request by returning `status()` (any other value is merged into
   * the context), so each refusal sets its headers on `set` and returns
   * `status(code, body)`. Like every local hook it applies only to routes
   * registered after it: the public routes above never run it.
   */
  .resolve(async ({ request, set, path, server, status }) => {
    const token = readSessionCookie(request.headers.get("cookie"));
    if (!token) {
      redirect(set, "/dashboard/login");
      return status(302, "");
    }
    if (!isWellFormedToken(token)) {
      logger.debug("Dashboard session cookie malformed or legacy, clearing it");
      clearSession(set);
      redirect(set, "/dashboard/login");
      return status(302, "");
    }

    let session: Awaited<ReturnType<typeof sessionService.findActiveSession>>;
    try {
      session = await sessionService.findActiveSession(token);
    } catch (error: unknown) {
      logger.error("Dashboard session lookup failed", {
        path,
        error: errorMessage(error),
      });
      return status(503, SESSION_STORE_DOWN);
    }

    /**
     * Reuse: the previous token after the grace period, or (no live match)
     * an older superseded token from the session's history.
     */
    let reusedBy: { userId: string; sessionId: string } | null = null;
    if (session && session.matched === "previous" && session.graceOver) {
      reusedBy = session;
    } else if (!session) {
      try {
        reusedBy = await sessionService.findSessionBySupersededToken(token);
      } catch (error: unknown) {
        logger.error("Dashboard session lookup failed", {
          path,
          error: errorMessage(error),
        });
        return status(503, SESSION_STORE_DOWN);
      }
    }

    if (reusedBy) {
      const ip = resolveClientIp({
        socketIp: server?.requestIP(request)?.address,
        forwardedFor: request.headers.get("x-forwarded-for"),
        trustedProxyHops: config.dashboard.trustedProxyHops,
      });
      try {
        await revokeOnTokenReuse(reusedBy, ip);
      } catch (error: unknown) {
        logger.error("Session token reuse detected, but revoking the sessions failed", {
          userId: reusedBy.userId,
          sessionId: reusedBy.sessionId,
          ip,
          error: errorMessage(error),
        });
        return status(503, SESSION_STORE_DOWN);
      }
      clearSession(set);
      redirect(set, "/dashboard/login");
      return status(302, "");
    }

    if (!session) {
      logger.debug("Dashboard session invalid, redirecting to login");
      clearSession(set);
      redirect(set, "/dashboard/login");
      return status(302, "");
    }

    /**
     * CSRF second layer (#133): every state-mutating dashboard action is a
     * POST, so require same-origin on POST. `SameSite=Lax` is the primary
     * defense; this rejects a forged cross-site form-POST that rides the
     * operator's session cookie. Returns 403 (not a redirect) so it's an
     * explicit refusal, not a silent bounce. Checked before rotation, so a
     * rejected request never carries a new token.
     */
    if (request.method === "POST" && !isSameOrigin(request)) {
      logger.warn("Dashboard POST rejected: cross-origin (possible CSRF)", {
        path,
        origin: request.headers.get("origin") ?? request.headers.get("referer") ?? null,
      });
      return status(403, "Forbidden: cross-origin request rejected");
    }

    if (session.matched === "current" && session.rotationDue) {
      try {
        const rotated = await sessionService.rotateSession(session.sessionId, token);
        if (rotated) issueSession(set, rotated.token, rotated.maxAgeSec);
      } catch (error: unknown) {
        logger.error("Dashboard session rotation failed", {
          sessionId: session.sessionId,
          error: errorMessage(error),
        });
      }
    }

    /** Every later log line of this request names the user (#222, #284). */
    setLogContextUser(session.userId);
    /** The sidebar hides admin-only links from members (#218). */
    setViewerRole(session.role);
    return { auth: toDashboardAuth(session) };
  })

  /* ─── Protected Routes ─── */

  /**
   * GET /dashboard
   * Dashboard home: shows stat cards with overview counts.
   */
  .get(
    "/",
    async ({ auth }) => {
      const stats = await statsService.getDashboardStats();
      return <HomePage stats={stats} canInvite={roleAtLeast(auth.user.role, "admin")} />;
    },
    { beforeHandle: memberGuard },
  )

  /**
   * GET /dashboard/send
   * Send email page: compose form with flash message support. Includes
   * an explicit "Sending as" api-key picker (#89) so the operator
   * always knows which key is charged with the send and any resulting
   * auto-suppressions.
   */
  .get(
    "/send",
    async ({ query }) => {
      const keys = await apiKeyService.listApiKeys();
      /** Only active keys are eligible: disabled keys are filtered out
       *  so the dropdown reflects what's actually usable. */
      const activeKeys = keys.filter((k) => k.isActive);
      const defaultApiKeyId = activeKeys[0]?.id;

      const flash = toFlash(query.flash, query.flashType);

      return (
        <SendEmailPage
          flash={flash}
          apiKeys={activeKeys}
          defaultApiKeyId={defaultApiKeyId}
        />
      );
    },
    {
      beforeHandle: memberGuard,
      query: t.Object({
        flash: t.Optional(t.String()),
        flashType: t.Optional(t.String()),
      }),
    },
  )

  /**
   * POST /dashboard/send
   * Sends an email via form submission. The operator picks the api key
   * explicitly via the form (#89). We re-validate that the key is
   * still active before sending so a stale form fails loud instead of
   * silently falling back to a different key.
   */
  .post(
    "/send",
    async ({ body, set }) => {
      const keys = await apiKeyService.listApiKeys();
      /** Match exactly what the form submitted: no implicit fallback. */
      const chosenKey = keys.find((k) => k.id === body.apiKeyId);

      if (!chosenKey || !chosenKey.isActive) {
        set.status = 302;
        set.headers["location"] =
          `/dashboard/send?flash=${encodeURIComponent("Selected API key is not available. Pick an active one and try again.")}&flashType=error`;
        return "";
      }

      try {
        await emailService.createEmail(
          {
            from: body.from,
            to: body.to,
            cc: body.cc || undefined,
            bcc: body.bcc || undefined,
            replyTo: body.replyTo || undefined,
            subject: body.subject,
            html: body.html || undefined,
            text: body.text || undefined,
          },
          chosenKey.id,
        );

        logger.info("Email sent via dashboard", {
          to: redactEmail(body.to),
          apiKeyId: chosenKey.id,
        });
        set.status = 302;
        set.headers["location"] =
          `/dashboard/send?flash=${encodeURIComponent("Email queued for delivery")}`;
      } catch (error) {
        logger.error("Failed to send email via dashboard", {
          error: error instanceof Error ? error.message : String(error),
        });
        set.status = 302;
        set.headers["location"] =
          `/dashboard/send?flash=${encodeURIComponent(error instanceof Error ? error.message : "Failed to send email")}&flashType=error`;
      }
      return "";
    },
    {
      beforeHandle: memberGuard,
      body: t.Object({
        apiKeyId: t.String(),
        from: t.String({ format: "email" }),
        to: t.String({ format: "email" }),
        /**
         * Same header-injection guard as the REST `sendEmailDto` (#133):
         * length cap + CR/LF rejected. The dashboard path previously took
         * cc/bcc/subject unrestricted (#202).
         */
        cc: t.Optional(t.String({ maxLength: 1000, pattern: "^[^\\u000d\\u000a]*$" })),
        bcc: t.Optional(t.String({ maxLength: 1000, pattern: "^[^\\u000d\\u000a]*$" })),
        /** Same guard as the API DTO: length cap + CR/LF rejected (#169). */
        replyTo: t.Optional(
          t.String({ maxLength: 1000, pattern: "^[^\\u000d\\u000a]*$" }),
        ),
        subject: t.String({ maxLength: 500, pattern: "^[^\\u000d\\u000a]*$" }),
        html: t.Optional(t.String()),
        text: t.Optional(t.String()),
      }),
    },
  )

  /**
   * GET /dashboard/emails
   * Email list with status filter tabs, bulk-select checkboxes, and pagination.
   * Trashed rows are hidden: view them at /dashboard/emails/trash.
   */
  .get(
    "/emails",
    async ({ query }) => {
      const { page, limit } = parsePagination(query);
      const status = isEmailStatus(query.status) ? query.status : undefined;
      /** Source + API-key filters (#137). Only pass through valid values. */
      const source =
        query.source === "api" || query.source === "smtp" ? query.source : undefined;
      const apiKeyId = query.apiKeyId || undefined;

      const [{ data, total }, keys] = await Promise.all([
        emailService.listAllEmails({
          page,
          limit,
          status,
          source,
          apiKeyId,
        }),
        /** Populate the API-key dropdown (operator/cross-key view, #137). */
        apiKeyService.listApiKeys(),
      ]);

      const flash = toFlash(query.flash, query.flashType);

      return (
        <EmailsPage
          emails={data}
          total={total}
          page={page}
          limit={limit}
          status={status}
          source={source}
          apiKeyId={apiKeyId}
          apiKeys={keys.map((k) => ({ id: k.id, name: k.name, keyPrefix: k.keyPrefix }))}
          flash={flash}
        />
      );
    },
    {
      beforeHandle: memberGuard,
      query: t.Object({
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        status: t.Optional(t.String()),
        source: t.Optional(t.String()),
        apiKeyId: t.Optional(t.String()),
        flash: t.Optional(t.String()),
        flashType: t.Optional(t.String()),
      }),
    },
  )

  /**
   * GET /dashboard/emails/tombstones (#34): post-purge audit trail.
   * Defined before `/:id` so the literal segment doesn't get eaten by
   * the param route. Optional `?messageId=` for the bounce-trace flow.
   */
  .get(
    "/emails/tombstones",
    async ({ query }) => {
      const { page, limit } = parsePagination(query);
      const messageId =
        typeof query.messageId === "string" && query.messageId.length > 0
          ? query.messageId
          : undefined;

      const { data, total } = await tombstoneService.listAllTombstones({
        messageId,
        page,
        limit,
      });

      return (
        <EmailTombstonesPage
          tombstones={data}
          total={total}
          page={page}
          limit={limit}
          messageIdFilter={messageId}
        />
      );
    },
    {
      beforeHandle: memberGuard,
      query: t.Object({
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        messageId: t.Optional(t.String()),
      }),
    },
  )

  /**
   * GET /dashboard/emails/trash
   * Trashed emails view: defined before /:id so the segment doesn't match.
   */
  .get(
    "/emails/trash",
    async ({ query }) => {
      const { page, limit } = parsePagination(query);

      const { data, total } = await emailService.listTrashedEmailsUnscoped({
        page,
        limit,
      });

      const flash = toFlash(query.flash, query.flashType);

      return (
        <EmailsTrashPage
          emails={data}
          total={total}
          page={page}
          limit={limit}
          retentionDays={config.trash.retentionDays}
          flash={flash}
        />
      );
    },
    {
      beforeHandle: memberGuard,
      query: t.Object({
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        flash: t.Optional(t.String()),
        flashType: t.Optional(t.String()),
      }),
    },
  )

  /**
   * POST /dashboard/emails/bulk-trash
   * Bulk soft-delete from the emails list page.
   */
  .post(
    "/emails/bulk-trash",
    async ({ body, set }) => {
      const ids = toIdArray(body.ids);
      const count = await emailService.trashEmailsUnscoped(ids);
      logger.info("Bulk-trashed emails via dashboard", { count });

      set.status = 302;
      set.headers["location"] =
        `/dashboard/emails?flash=${encodeURIComponent(`${count} email(s) moved to trash`)}`;
      return "";
    },
    {
      beforeHandle: adminGuard,
      body: t.Object({
        ids: t.Union([t.Array(t.String()), t.String()]),
      }),
    },
  )

  /**
   * POST /dashboard/emails/trash/bulk-restore
   * Bulk-restore from the trash page.
   */
  .post(
    "/emails/trash/bulk-restore",
    async ({ body, set }) => {
      const ids = toIdArray(body.ids);
      let restored = 0;
      for (const id of ids) {
        const r = await emailService.restoreEmailUnscoped(id);
        if (r) restored += 1;
      }
      logger.info("Bulk-restored emails via dashboard", { restored });

      set.status = 302;
      set.headers["location"] =
        `/dashboard/emails/trash?flash=${encodeURIComponent(`${restored} email(s) restored`)}`;
      return "";
    },
    {
      beforeHandle: adminGuard,
      body: t.Object({
        ids: t.Union([t.Array(t.String()), t.String()]),
      }),
    },
  )

  /**
   * POST /dashboard/emails/trash/bulk-permanent
   * Bulk-permanently-delete from the trash page.
   */
  .post(
    "/emails/trash/bulk-permanent",
    async ({ body, set }) => {
      const ids = toIdArray(body.ids);
      let deleted = 0;
      for (const id of ids) {
        const r = await emailService.permanentDeleteEmailUnscoped(id);
        if (r) deleted += 1;
      }
      logger.info("Bulk-permanent-deleted emails via dashboard", { deleted });

      set.status = 302;
      set.headers["location"] =
        `/dashboard/emails/trash?flash=${encodeURIComponent(`${deleted} email(s) deleted forever`)}`;
      return "";
    },
    {
      beforeHandle: adminGuard,
      body: t.Object({
        ids: t.Union([t.Array(t.String()), t.String()]),
      }),
    },
  )

  /**
   * POST /dashboard/emails/trash/empty
   * Empties the email trash entirely.
   */
  .post(
    "/emails/trash/empty",
    async ({ set }) => {
      const deleted = await emailService.emptyEmailsTrashUnscoped();
      logger.info("Emptied emails trash via dashboard", { deleted });

      set.status = 302;
      set.headers["location"] =
        `/dashboard/emails/trash?flash=${encodeURIComponent(`Trash emptied: ${deleted} email(s) permanently deleted`)}`;
      return "";
    },
    { beforeHandle: adminGuard },
  )

  /**
   * POST /dashboard/emails/:id/trash
   * Move single email to trash from the detail or list page.
   */
  .post(
    "/emails/:id/trash",
    async ({ params, set }) => {
      const email = await emailService.trashEmailUnscoped(params.id);

      if (!email) {
        set.status = 302;
        set.headers["location"] =
          `/dashboard/emails?flash=${encodeURIComponent("Email not found")}&flashType=error`;
        return "";
      }

      logger.info("Email trashed via dashboard", { id: params.id });
      set.status = 302;
      set.headers["location"] =
        `/dashboard/emails?flash=${encodeURIComponent("Email moved to trash")}`;
      return "";
    },
    { beforeHandle: adminGuard, params: t.Object({ id: t.String() }) },
  )

  /**
   * POST /dashboard/emails/:id/restore
   * Restore a single trashed email: redirects back to trash view.
   */
  .post(
    "/emails/:id/restore",
    async ({ params, set }) => {
      const email = await emailService.restoreEmailUnscoped(params.id);

      const message = email ? "Email restored" : "Trashed email not found";
      const type: "success" | "error" = email ? "success" : "error";

      if (email) logger.info("Email restored via dashboard", { id: params.id });

      set.status = 302;
      set.headers["location"] =
        `/dashboard/emails/trash?flash=${encodeURIComponent(message)}&flashType=${type}`;
      return "";
    },
    { beforeHandle: memberGuard, params: t.Object({ id: t.String() }) },
  )

  /**
   * POST /dashboard/emails/:id/permanent
   * Permanently delete a single trashed email.
   */
  .post(
    "/emails/:id/permanent",
    async ({ params, set }) => {
      const email = await emailService.permanentDeleteEmailUnscoped(params.id);

      const message = email ? "Email deleted forever" : "Trashed email not found";
      const type: "success" | "error" = email ? "success" : "error";

      if (email)
        logger.info("Email permanently deleted via dashboard", { id: params.id });

      set.status = 302;
      set.headers["location"] =
        `/dashboard/emails/trash?flash=${encodeURIComponent(message)}&flashType=${type}`;
      return "";
    },
    { beforeHandle: adminGuard, params: t.Object({ id: t.String() }) },
  )

  /**
   * GET /dashboard/emails/:id
   * Single email detail view. Falls back to the trashed copy if the email
   * is in trash so users can navigate to it from the trash list.
   */
  .get(
    "/emails/:id",
    async ({ params, set }) => {
      const live = await emailService.getEmailByIdUnscoped(params.id);

      if (live) {
        return <EmailDetailPage email={live} isTrashed={false} />;
      }

      const trashed = await emailService.getTrashedEmailByIdUnscoped(params.id);
      if (trashed) {
        return <EmailDetailPage email={trashed} isTrashed={true} />;
      }

      set.status = 404;
      return "Email not found";
    },
    {
      beforeHandle: memberGuard,
      params: t.Object({
        id: t.String(),
      }),
    },
  )

  /**
   * GET /dashboard/api-keys
   * API keys list with create form. Shows flash messages from query params.
   */
  .get(
    "/api-keys",
    async ({ query, auth, set }) => {
      setNoStore(set);
      const keys = await apiKeyService.listApiKeys();

      /** Parse flash message from query params (set after create/revoke) */
      const flash = toFlash(query.flash, query.flashType);

      /**
       * The raw key is delivered via a one-time server-side reveal token
       * (#132): never in the URL. `consumeRevealSecret` returns it once,
       * then it's gone.
       */
      const rawKey = consumeRevealSecret(query.reveal, "api_key", revealOwnerOf(auth));

      return <ApiKeysPage keys={keys} flash={flash} rawKey={rawKey} />;
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
   * POST /dashboard/api-keys
   * Creates a new API key via form submission.
   * Redirects back to the list with the raw key shown once.
   */
  .post(
    "/api-keys",
    async ({ body, set, auth }) => {
      try {
        const { rawKey } = await apiKeyService.createApiKey({
          name: body.name,
          /** Chip input submits a comma-joined string; split to an array. */
          allowedSenders: parseSenderList(body.allowedSenders),
          /** Checkbox → "on" when ticked; operator-only admin grant (#130). */
          isAdmin: body.isAdmin === "on",
        });

        logger.info("API key created via dashboard", {
          name: body.name,
          isAdmin: body.isAdmin === "on",
        });

        /**
         * Redirect with only a one-time reveal TOKEN in the query (#132):
         * never the raw key itself. The GET consumes the token and shows
         * the key once. Keeps secrets out of history / access logs / Referer.
         */
        const reveal = stashRevealSecret(rawKey, "api_key", revealOwnerOf(auth));
        set.status = 302;
        set.headers["location"] =
          `/dashboard/api-keys?flash=${encodeURIComponent("API key created successfully")}&reveal=${reveal}`;
      } catch (error) {
        logger.error("Failed to create API key via dashboard", {
          error: error instanceof Error ? error.message : String(error),
        });
        set.status = 302;
        set.headers["location"] =
          `/dashboard/api-keys?flash=${encodeURIComponent("Failed to create API key")}&flashType=error`;
      }
      return "";
    },
    {
      beforeHandle: adminGuard,
      body: t.Object({
        name: t.String(),
        allowedSenders: t.Optional(t.String()),
        isAdmin: t.Optional(t.String()),
      }),
    },
  )

  /**
   * POST /dashboard/api-keys/:id/admin
   * Promotes/demotes a key's admin flag (#130). Operator-only: this route
   * lives on the dashboard (session auth), and `setApiKeyAdmin` is not
   * reachable from any REST DTO, so an API key can never grant itself admin.
   */
  .post(
    "/api-keys/:id/admin",
    async ({ params, body, set }) => {
      const isAdmin = body.isAdmin === "true";
      const updated = await apiKeyService.setApiKeyAdmin(params.id, isAdmin);

      set.status = 302;
      set.headers["location"] = updated
        ? `/dashboard/api-keys?flash=${encodeURIComponent(isAdmin ? "Key promoted to admin" : "Key set to restricted")}`
        : `/dashboard/api-keys?flash=${encodeURIComponent("API key not found")}&flashType=error`;
      return "";
    },
    {
      beforeHandle: adminGuard,
      params: t.Object({ id: t.String() }),
      body: t.Object({ isAdmin: t.String() }),
    },
  )

  /**
   * POST /dashboard/api-keys/:id/senders
   * Updates a key's allowed-senders allowlist via form submission (#126).
   * The chip editor submits the full desired list (comma-joined); an empty
   * value clears the list (back to unrestricted).
   */
  .post(
    "/api-keys/:id/senders",
    async ({ params, body, set }) => {
      const updated = await apiKeyService.updateApiKey(params.id, {
        allowedSenders: parseSenderList(body.allowedSenders),
      });

      set.status = 302;
      set.headers["location"] = updated
        ? `/dashboard/api-keys?flash=${encodeURIComponent("Allowed senders updated")}`
        : `/dashboard/api-keys?flash=${encodeURIComponent("API key not found")}&flashType=error`;
      return "";
    },
    {
      beforeHandle: adminGuard,
      params: t.Object({ id: t.String() }),
      body: t.Object({ allowedSenders: t.Optional(t.String()) }),
    },
  )

  /**
   * POST /dashboard/api-keys/:id/revoke
   * Revokes an API key via form submission.
   */
  .post(
    "/api-keys/:id/revoke",
    async ({ params, set }) => {
      const apiKey = await apiKeyService.revokeApiKey(params.id);

      if (!apiKey) {
        set.status = 302;
        set.headers["location"] =
          `/dashboard/api-keys?flash=${encodeURIComponent("API key not found")}&flashType=error`;
        return "";
      }

      logger.info("API key revoked via dashboard", { id: params.id });
      set.status = 302;
      set.headers["location"] =
        `/dashboard/api-keys?flash=${encodeURIComponent("API key revoked")}`;
      return "";
    },
    {
      beforeHandle: adminGuard,
      params: t.Object({
        id: t.String(),
      }),
    },
  )

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
    async ({ body, set, auth }) => {
      try {
        const result = await inviteService.createInvitation(
          inviteActorOf(auth),
          body.email,
          body.role,
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
    async ({ params, set, auth }) => {
      const result = await inviteService.revokeInvitation(inviteActorOf(auth), params.id);
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
    async ({ params, set, auth }) => {
      try {
        const result = await inviteService.resendInvitation(
          inviteActorOf(auth),
          params.id,
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

  /**
   * GET /dashboard/users
   * Every account with its role and status (#218). Admins and the owner;
   * each row shows only the actions the viewer may take, and every action
   * route checks the rules again in the service.
   */
  .get(
    "/users",
    async ({ query, auth }) => {
      const accounts = await userAdminService.listAccounts();
      const flash = toFlash(query.flash, query.flashType);
      return (
        <UsersPage
          accounts={accounts}
          viewer={{ id: auth.user.id, role: auth.user.role, disabled: false }}
          flash={flash}
        />
      );
    },
    {
      beforeHandle: adminGuard,
      query: t.Object({
        flash: t.Optional(t.String()),
        flashType: t.Optional(t.String()),
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
    async ({ params, body, set, auth }) => {
      const result = await userAdminService.changeAccountRole(
        auth.user.id,
        params.id,
        body.role,
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
    async ({ params, set, auth }) => {
      const result = await userAdminService.deactivateAccount(auth.user.id, params.id);
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
    async ({ params, set, auth }) => {
      const result = await userAdminService.reactivateAccount(auth.user.id, params.id);
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
    async ({ params, body, set, auth }) => {
      const result = await userAdminService.removeAccount(
        auth.user.id,
        params.id,
        body.confirm,
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
   * GET /dashboard/domains
   * Domains list with add form. Shows flash messages from query params.
   */
  .get(
    "/domains",
    async ({ query }) => {
      const domainList = await domainService.listDomains();

      const flash = toFlash(query.flash, query.flashType);

      return <DomainsPage domains={domainList} flash={flash} />;
    },
    {
      beforeHandle: memberGuard,
      query: t.Object({
        flash: t.Optional(t.String()),
        flashType: t.Optional(t.String()),
      }),
    },
  )

  /**
   * POST /dashboard/domains
   * Adds a new domain via form submission.
   */
  .post(
    "/domains",
    async ({ body, set }) => {
      try {
        await domainService.createDomain({ name: body.name });

        logger.info("Domain added via dashboard", { name: body.name });
        set.status = 302;
        set.headers["location"] =
          `/dashboard/domains?flash=${encodeURIComponent("Domain added successfully")}`;
      } catch (error) {
        logger.error("Failed to add domain via dashboard", {
          error: error instanceof Error ? error.message : String(error),
        });
        set.status = 302;
        set.headers["location"] =
          `/dashboard/domains?flash=${encodeURIComponent("Failed to add domain")}&flashType=error`;
      }
      return "";
    },
    {
      beforeHandle: adminGuard,
      body: t.Object({
        name: t.String(),
      }),
    },
  )

  /**
   * POST /dashboard/domains/:id/delete
   * Deletes a domain via form submission.
   */
  .post(
    "/domains/:id/delete",
    async ({ params, set }) => {
      const domain = await domainService.deleteDomain(params.id);

      if (!domain) {
        set.status = 302;
        set.headers["location"] =
          `/dashboard/domains?flash=${encodeURIComponent("Domain not found")}&flashType=error`;
        return "";
      }

      logger.info("Domain deleted via dashboard", { id: params.id });
      set.status = 302;
      set.headers["location"] =
        `/dashboard/domains?flash=${encodeURIComponent("Domain deleted")}`;
      return "";
    },
    {
      beforeHandle: adminGuard,
      params: t.Object({
        id: t.String(),
      }),
    },
  )

  /**
   * POST /dashboard/domains/:id/verify
   * Triggers DNS verification and redirects back to domain detail.
   */
  .post(
    "/domains/:id/verify",
    async ({ params, set }) => {
      const domain = await domainService.getDomainById(params.id);

      if (!domain) {
        set.status = 302;
        set.headers["location"] =
          `/dashboard/domains?flash=${encodeURIComponent("Domain not found")}&flashType=error`;
        return "";
      }

      /** Throttle live DNS lookups per domain (#133). */
      if (isDnsVerifyThrottled(params.id)) {
        logger.warn("Domain DNS verification throttled", { id: params.id });
        set.status = 302;
        set.headers["location"] =
          `/dashboard/domains/${params.id}?flash=${encodeURIComponent("Too many verification attempts: wait a minute and try again")}&flashType=error`;
        return "";
      }

      const result = await verifyDomain(domain);
      const allPassed = result.spf && result.dkim && result.dmarc;
      const message = allPassed
        ? "All DNS records verified successfully!"
        : `Verification: SPF ${result.spf ? "✓" : "✗"}, DKIM ${result.dkim ? "✓" : "✗"}, DMARC ${result.dmarc ? "✓" : "✗"}`;

      logger.info("Domain DNS verification via dashboard", {
        id: params.id,
        ...result,
      });

      set.status = 302;
      set.headers["location"] =
        `/dashboard/domains/${params.id}?flash=${encodeURIComponent(message)}&flashType=${allPassed ? "success" : "error"}`;
      return "";
    },
    {
      beforeHandle: adminGuard,
      params: t.Object({
        id: t.String(),
      }),
    },
  )

  /**
   * POST /dashboard/domains/:id/notify-email
   * Sets or clears the inbound-notification address for a domain (#106).
   * An empty submission clears it (disables notifications).
   */
  .post(
    "/domains/:id/notify-email",
    async ({ params, body, set }) => {
      const raw = (body.notifyEmail ?? "").trim();
      /** Empty clears the address; otherwise require a plausible email. */
      const value = raw === "" ? null : raw;
      if (value !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        set.status = 302;
        set.headers["location"] =
          `/dashboard/domains/${params.id}?flash=${encodeURIComponent("Enter a valid email address")}&flashType=error`;
        return "";
      }

      const updated = await domainService.updateDomainNotifyEmail(params.id, value);

      if (!updated) {
        set.status = 302;
        set.headers["location"] =
          `/dashboard/domains?flash=${encodeURIComponent("Domain not found")}&flashType=error`;
        return "";
      }

      const message = value
        ? "Inbound notifications enabled"
        : "Inbound notifications disabled";
      set.status = 302;
      set.headers["location"] =
        `/dashboard/domains/${params.id}?flash=${encodeURIComponent(message)}&flashType=success`;
      return "";
    },
    {
      beforeHandle: adminGuard,
      params: t.Object({ id: t.String() }),
      body: t.Object({ notifyEmail: t.Optional(t.String({ maxLength: 255 })) }),
    },
  )

  /**
   * POST /dashboard/domains/:id/unsubscribe
   * Sets or clears the domain's `List-Unsubscribe` overrides (#243). An
   * empty field clears that override.
   */
  .post(
    "/domains/:id/unsubscribe",
    async ({ params, body, set }) => {
      const email = (body.unsubscribeEmail ?? "").trim() || null;
      const url = (body.unsubscribeUrl ?? "").trim() || null;
      const back = (message: string, type: "success" | "error"): string => {
        set.status = 302;
        set.headers["location"] =
          `/dashboard/domains/${params.id}?flash=${encodeURIComponent(message)}&flashType=${type}`;
        return "";
      };

      if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return back("Enter a valid unsubscribe email address", "error");
      }
      if (url !== null && (!URL.canParse(url) || !url.startsWith("https://"))) {
        return back("The unsubscribe URL must be an https:// address", "error");
      }

      const updated = await domainService.updateDomainUnsubscribe(params.id, {
        unsubscribeEmail: email,
        unsubscribeUrl: url,
      });
      if (!updated) {
        set.status = 302;
        set.headers["location"] =
          `/dashboard/domains?flash=${encodeURIComponent("Domain not found")}&flashType=error`;
        return "";
      }
      return back("Unsubscribe settings saved", "success");
    },
    {
      beforeHandle: adminGuard,
      params: t.Object({ id: t.String() }),
      body: t.Object({
        unsubscribeEmail: t.Optional(t.String({ maxLength: 254 })),
        unsubscribeUrl: t.Optional(t.String({ maxLength: 2048 })),
      }),
    },
  )

  /**
   * GET /dashboard/domains/:id
   * Single domain detail view with DNS verification status.
   */
  .get(
    "/domains/:id",
    async ({ params, set, query }) => {
      const domain = await domainService.getDomainById(params.id);

      if (!domain) {
        set.status = 404;
        return "Domain not found";
      }

      const flash = toFlash(query.flash, query.flashType);

      return <DomainDetailPage domain={domain} flash={flash} />;
    },
    {
      beforeHandle: memberGuard,
      params: t.Object({
        id: t.String(),
      }),
      query: t.Object({
        flash: t.Optional(t.String()),
        flashType: t.Optional(t.String()),
      }),
    },
  )

  /* ─── Templates ─── */

  .get(
    "/templates",
    async ({ query }) => {
      const list = await templateService.listAllTemplates();
      const flash = toFlash(query.flash, query.flashType);
      return <TemplatesPage templates={list} flash={flash} />;
    },
    {
      beforeHandle: memberGuard,
      query: t.Object({
        flash: t.Optional(t.String()),
        flashType: t.Optional(t.String()),
      }),
    },
  )

  .post(
    "/templates",
    async ({ body, set }) => {
      try {
        const keys = await apiKeyService.listApiKeys();
        const activeKey = keys.find((k) => k.isActive);
        if (!activeKey) {
          set.status = 302;
          set.headers["location"] =
            `/dashboard/templates?flash=${encodeURIComponent("No active API key")}&flashType=error`;
          return "";
        }
        const variables = body.variables
          ? body.variables
              .split(",")
              .map((v: string) => v.trim())
              .filter(Boolean)
          : undefined;
        await templateService.createTemplate(
          {
            name: body.name,
            subject: body.subject,
            html: body.html || undefined,
            text: body.text || undefined,
            variables,
          },
          activeKey.id,
        );
        set.status = 302;
        set.headers["location"] =
          `/dashboard/templates?flash=${encodeURIComponent("Template created")}`;
      } catch (error) {
        set.status = 302;
        set.headers["location"] =
          `/dashboard/templates?flash=${encodeURIComponent(error instanceof Error ? error.message : "Failed to create template")}&flashType=error`;
      }
      return "";
    },
    {
      beforeHandle: memberGuard,
      body: t.Object({
        name: t.String(),
        subject: t.String(),
        html: t.Optional(t.String()),
        text: t.Optional(t.String()),
        variables: t.Optional(t.String()),
      }),
    },
  )

  .get(
    "/templates/:id",
    async ({ params, set, query }) => {
      const template = await templateService.getTemplateByIdUnscoped(params.id);
      if (!template) {
        set.status = 404;
        return "Template not found";
      }
      const flash = toFlash(query.flash, query.flashType);
      return <TemplateDetailPage template={template} flash={flash} />;
    },
    {
      beforeHandle: memberGuard,
      params: t.Object({ id: t.String() }),
      query: t.Object({
        flash: t.Optional(t.String()),
        flashType: t.Optional(t.String()),
      }),
    },
  )

  .post(
    "/templates/:id/edit",
    async ({ params, body, set }) => {
      try {
        const existing = await templateService.getTemplateByIdUnscoped(params.id);
        if (!existing) {
          set.status = 302;
          set.headers["location"] =
            `/dashboard/templates?flash=${encodeURIComponent("Template not found")}&flashType=error`;
          return "";
        }
        const variables = body.variables
          ? body.variables
              .split(",")
              .map((v: string) => v.trim())
              .filter(Boolean)
          : undefined;
        await templateService.updateTemplate(params.id, existing.apiKeyId, {
          name: body.name || undefined,
          subject: body.subject || undefined,
          html: body.html || undefined,
          text: body.text || undefined,
          variables,
        });
        set.status = 302;
        set.headers["location"] =
          `/dashboard/templates/${params.id}?flash=${encodeURIComponent("Template updated")}`;
      } catch (error) {
        set.status = 302;
        set.headers["location"] =
          `/dashboard/templates/${params.id}?flash=${encodeURIComponent(error instanceof Error ? error.message : "Failed to update")}&flashType=error`;
      }
      return "";
    },
    {
      beforeHandle: adminGuard,
      params: t.Object({ id: t.String() }),
      body: t.Object({
        name: t.Optional(t.String()),
        subject: t.Optional(t.String()),
        html: t.Optional(t.String()),
        text: t.Optional(t.String()),
        variables: t.Optional(t.String()),
      }),
    },
  )

  .post(
    "/templates/:id/delete",
    async ({ params, set }) => {
      try {
        const existing = await templateService.getTemplateByIdUnscoped(params.id);
        if (!existing) {
          set.status = 302;
          set.headers["location"] =
            `/dashboard/templates?flash=${encodeURIComponent("Template not found")}&flashType=error`;
          return "";
        }
        await templateService.deleteTemplate(params.id, existing.apiKeyId);
        set.status = 302;
        set.headers["location"] =
          `/dashboard/templates?flash=${encodeURIComponent("Template deleted")}`;
      } catch {
        set.status = 302;
        set.headers["location"] =
          `/dashboard/templates?flash=${encodeURIComponent("Failed to delete template")}&flashType=error`;
      }
      return "";
    },
    { beforeHandle: adminGuard, params: t.Object({ id: t.String() }) },
  )

  /* ─── Webhooks ─── */

  .get(
    "/webhooks",
    async ({ query, auth, set }) => {
      setNoStore(set);
      const hooks = await webhookService.listAllWebhooks();
      const flash = toFlash(query.flash, query.flashType);
      /** One-time reveal of the webhook HMAC secret (#132): never in URL. */
      const secret = consumeRevealSecret(
        query.reveal,
        "webhook_secret",
        revealOwnerOf(auth),
      );

      return <WebhooksPage webhooks={hooks} flash={flash} secret={secret} />;
    },
    {
      beforeHandle: memberGuard,
      query: t.Object({
        flash: t.Optional(t.String()),
        flashType: t.Optional(t.String()),
        reveal: t.Optional(t.String()),
      }),
    },
  )

  .post(
    "/webhooks",
    async ({ body, set, auth }) => {
      try {
        const keys = await apiKeyService.listApiKeys();
        const activeKey = keys.find((k) => k.isActive);
        if (!activeKey) {
          set.status = 302;
          set.headers["location"] =
            `/dashboard/webhooks?flash=${encodeURIComponent("No active API key")}&flashType=error`;
          return "";
        }
        const events = Array.isArray(body.events)
          ? body.events
          : [body.events].filter(Boolean);
        const { secret } = await webhookService.createWebhook(
          { url: body.url, events },
          activeKey.id,
        );
        /** One-time reveal token in the URL (#132): never the secret. */
        const reveal = stashRevealSecret(secret, "webhook_secret", revealOwnerOf(auth));
        set.status = 302;
        set.headers["location"] =
          `/dashboard/webhooks?flash=${encodeURIComponent("Webhook created")}&reveal=${reveal}`;
      } catch (error) {
        set.status = 302;
        set.headers["location"] =
          `/dashboard/webhooks?flash=${encodeURIComponent(error instanceof Error ? error.message : "Failed to create webhook")}&flashType=error`;
      }
      return "";
    },
    {
      beforeHandle: adminGuard,
      body: t.Object({
        url: t.String(),
        events: t.Union([t.String(), t.Array(t.String())]),
      }),
    },
  )

  .post(
    "/webhooks/:id/delete",
    async ({ params, set }) => {
      try {
        const hooks = await webhookService.listAllWebhooks();
        const hook = hooks.find((h) => h.id === params.id);
        if (!hook) {
          set.status = 302;
          set.headers["location"] =
            `/dashboard/webhooks?flash=${encodeURIComponent("Webhook not found")}&flashType=error`;
          return "";
        }
        await webhookService.deleteWebhook(params.id, hook.apiKeyId);
        set.status = 302;
        set.headers["location"] =
          `/dashboard/webhooks?flash=${encodeURIComponent("Webhook deleted")}`;
      } catch {
        set.status = 302;
        set.headers["location"] =
          `/dashboard/webhooks?flash=${encodeURIComponent("Failed to delete webhook")}&flashType=error`;
      }
      return "";
    },
    { beforeHandle: adminGuard, params: t.Object({ id: t.String() }) },
  )

  /**
   * GET /dashboard/webhooks/:id/deliveries, paginated history of every
   * delivery attempt for one webhook (#30). Operators land here from
   * the webhooks list to answer "did event X actually deliver?".
   *
   * The dashboard is admin-scoped (sees every api key's data), so we
   * resolve the webhook first to learn its `apiKeyId` and pass that to
   * the service: the service's per-api-key gate is for the REST path,
   * not the dashboard.
   */
  .get(
    "/webhooks/:id/deliveries",
    async ({ params, query, set }) => {
      const hooks = await webhookService.listAllWebhooks();
      const webhook = hooks.find((h) => h.id === params.id);
      if (!webhook) {
        set.status = 302;
        set.headers["location"] =
          `/dashboard/webhooks?flash=${encodeURIComponent("Webhook not found")}&flashType=error`;
        return "";
      }

      const { page, limit } = parsePagination(query);
      const status =
        query.status === "pending" ||
        query.status === "delivered" ||
        query.status === "failed"
          ? query.status
          : undefined;

      const { data, total } = await webhookDeliveryService.listDeliveriesForWebhook({
        webhookId: webhook.id,
        apiKeyId: webhook.apiKeyId,
        status,
        page,
        limit,
      });

      return (
        <WebhookDeliveriesPage
          webhook={webhook}
          deliveries={data}
          total={total}
          page={page}
          limit={limit}
          statusFilter={status}
        />
      );
    },
    {
      beforeHandle: memberGuard,
      params: t.Object({ id: t.String() }),
      query: t.Object({
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        status: t.Optional(t.String()),
      }),
    },
  )

  /** GET /dashboard/webhooks/deliveries/:deliveryId, full delivery
   *  detail with payload + attempt history + replay button. */
  .get(
    "/webhooks/deliveries/:deliveryId",
    async ({ params, query, set }) => {
      const hooks = await webhookService.listAllWebhooks();
      /** Iterate to find the delivery's parent webhook: there's no
       *  `findWebhookForDelivery` helper, but the list is small (one
       *  row per registered hook) so a single fetch is fine. */
      let foundDelivery: Awaited<
        ReturnType<typeof webhookDeliveryService.getDeliveryById>
      > = undefined;
      let foundWebhook: (typeof hooks)[number] | undefined;
      for (const hook of hooks) {
        const row = await webhookDeliveryService.getDeliveryById({
          deliveryId: params.deliveryId,
          apiKeyId: hook.apiKeyId,
        });
        if (row) {
          foundDelivery = row;
          foundWebhook = hook;
          break;
        }
      }
      if (!foundDelivery || !foundWebhook) {
        set.status = 302;
        set.headers["location"] =
          `/dashboard/webhooks?flash=${encodeURIComponent("Delivery not found")}&flashType=error`;
        return "";
      }

      const flash = toFlash(query.flash, query.flashType);

      return (
        <WebhookDeliveryDetailPage
          delivery={foundDelivery}
          webhook={foundWebhook}
          flash={flash}
        />
      );
    },
    {
      beforeHandle: memberGuard,
      params: t.Object({ deliveryId: t.String() }),
      query: t.Object({
        flash: t.Optional(t.String()),
        flashType: t.Optional(t.String()),
      }),
    },
  )

  /** POST /dashboard/webhooks/deliveries/:deliveryId/replay, flip a
   *  failed/pending delivery back to pending so the worker re-tries it
   *  on the next poll. Redirects to the detail page with a flash. */
  .post(
    "/webhooks/deliveries/:deliveryId/replay",
    async ({ params, set }) => {
      const hooks = await webhookService.listAllWebhooks();
      let replayed = false;
      for (const hook of hooks) {
        const row = await webhookDeliveryService.replayDelivery({
          deliveryId: params.deliveryId,
          apiKeyId: hook.apiKeyId,
        });
        if (row) {
          replayed = true;
          break;
        }
      }
      set.status = 302;
      set.headers["location"] = replayed
        ? `/dashboard/webhooks/deliveries/${params.deliveryId}?flash=${encodeURIComponent(
            "Replay queued: worker will re-attempt on next poll",
          )}`
        : `/dashboard/webhooks?flash=${encodeURIComponent("Delivery not found")}&flashType=error`;
      return "";
    },
    { beforeHandle: adminGuard, params: t.Object({ deliveryId: t.String() }) },
  )

  /* ─── Inbound ─── */

  .get(
    "/inbound",
    async ({ query }) => {
      const { page, limit } = parsePagination(query);

      const { data, total } = await inboundService.listInboundEmails({ page, limit });

      const flash = toFlash(query.flash, query.flashType);

      return (
        <InboundPage
          emails={data}
          total={total}
          page={page}
          limit={limit}
          flash={flash}
        />
      );
    },
    {
      beforeHandle: memberGuard,
      query: t.Object({
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        flash: t.Optional(t.String()),
        flashType: t.Optional(t.String()),
      }),
    },
  )

  /**
   * GET /dashboard/inbound/trash
   * Trashed inbound emails: defined before /:id.
   */
  .get(
    "/inbound/trash",
    async ({ query }) => {
      const { page, limit } = parsePagination(query);

      const { data, total } = await inboundService.listTrashedInboundEmails({
        page,
        limit,
      });

      const flash = toFlash(query.flash, query.flashType);

      return (
        <InboundTrashPage
          emails={data}
          total={total}
          page={page}
          limit={limit}
          retentionDays={config.trash.retentionDays}
          flash={flash}
        />
      );
    },
    {
      beforeHandle: memberGuard,
      query: t.Object({
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        flash: t.Optional(t.String()),
        flashType: t.Optional(t.String()),
      }),
    },
  )

  /** POST /dashboard/inbound/bulk-trash: bulk soft-delete from list page. */
  .post(
    "/inbound/bulk-trash",
    async ({ body, set }) => {
      const ids = toIdArray(body.ids);
      const count = await inboundService.trashInboundEmails(ids);
      logger.info("Bulk-trashed inbound emails via dashboard", { count });

      set.status = 302;
      set.headers["location"] =
        `/dashboard/inbound?flash=${encodeURIComponent(`${count} email(s) moved to trash`)}`;
      return "";
    },
    {
      beforeHandle: adminGuard,
      body: t.Object({
        ids: t.Union([t.Array(t.String()), t.String()]),
      }),
    },
  )

  /** POST /dashboard/inbound/trash/bulk-restore: bulk restore from trash page. */
  .post(
    "/inbound/trash/bulk-restore",
    async ({ body, set }) => {
      const ids = toIdArray(body.ids);
      let restored = 0;
      for (const id of ids) {
        const r = await inboundService.restoreInboundEmail(id);
        if (r) restored += 1;
      }
      logger.info("Bulk-restored inbound emails via dashboard", { restored });

      set.status = 302;
      set.headers["location"] =
        `/dashboard/inbound/trash?flash=${encodeURIComponent(`${restored} email(s) restored`)}`;
      return "";
    },
    {
      beforeHandle: adminGuard,
      body: t.Object({
        ids: t.Union([t.Array(t.String()), t.String()]),
      }),
    },
  )

  /** POST /dashboard/inbound/trash/bulk-permanent: bulk hard-delete from trash page. */
  .post(
    "/inbound/trash/bulk-permanent",
    async ({ body, set }) => {
      const ids = toIdArray(body.ids);
      let deleted = 0;
      for (const id of ids) {
        const r = await inboundService.permanentDeleteInboundEmail(id);
        if (r) deleted += 1;
      }
      logger.info("Bulk-permanent-deleted inbound emails via dashboard", { deleted });

      set.status = 302;
      set.headers["location"] =
        `/dashboard/inbound/trash?flash=${encodeURIComponent(`${deleted} email(s) deleted forever`)}`;
      return "";
    },
    {
      beforeHandle: adminGuard,
      body: t.Object({
        ids: t.Union([t.Array(t.String()), t.String()]),
      }),
    },
  )

  /** POST /dashboard/inbound/trash/empty: empty inbound trash entirely. */
  .post(
    "/inbound/trash/empty",
    async ({ set }) => {
      const deleted = await inboundService.emptyInboundTrash();
      logger.info("Emptied inbound trash via dashboard", { deleted });

      set.status = 302;
      set.headers["location"] =
        `/dashboard/inbound/trash?flash=${encodeURIComponent(`Trash emptied: ${deleted} email(s) permanently deleted`)}`;
      return "";
    },
    { beforeHandle: adminGuard },
  )

  /** POST /dashboard/inbound/:id/trash, move single inbound to trash. */
  .post(
    "/inbound/:id/trash",
    async ({ params, set }) => {
      const email = await inboundService.trashInboundEmail(params.id);

      if (!email) {
        set.status = 302;
        set.headers["location"] =
          `/dashboard/inbound?flash=${encodeURIComponent("Inbound email not found")}&flashType=error`;
        return "";
      }

      logger.info("Inbound email trashed via dashboard", { id: params.id });
      set.status = 302;
      set.headers["location"] =
        `/dashboard/inbound?flash=${encodeURIComponent("Email moved to trash")}`;
      return "";
    },
    { beforeHandle: adminGuard, params: t.Object({ id: t.String() }) },
  )

  /** POST /dashboard/inbound/:id/restore, restore single trashed inbound. */
  .post(
    "/inbound/:id/restore",
    async ({ params, set }) => {
      const email = await inboundService.restoreInboundEmail(params.id);
      const message = email ? "Email restored" : "Trashed email not found";
      const type: "success" | "error" = email ? "success" : "error";
      if (email) logger.info("Inbound restored via dashboard", { id: params.id });

      set.status = 302;
      set.headers["location"] =
        `/dashboard/inbound/trash?flash=${encodeURIComponent(message)}&flashType=${type}`;
      return "";
    },
    { beforeHandle: memberGuard, params: t.Object({ id: t.String() }) },
  )

  /** POST /dashboard/inbound/:id/permanent, hard-delete single trashed inbound. */
  .post(
    "/inbound/:id/permanent",
    async ({ params, set }) => {
      const email = await inboundService.permanentDeleteInboundEmail(params.id);
      const message = email ? "Email deleted forever" : "Trashed email not found";
      const type: "success" | "error" = email ? "success" : "error";
      if (email) {
        logger.info("Inbound permanently deleted via dashboard", { id: params.id });
      }

      set.status = 302;
      set.headers["location"] =
        `/dashboard/inbound/trash?flash=${encodeURIComponent(message)}&flashType=${type}`;
      return "";
    },
    { beforeHandle: adminGuard, params: t.Object({ id: t.String() }) },
  )

  .get(
    "/inbound/:id",
    async ({ params, set }) => {
      const live = await inboundService.getInboundEmailById(params.id);
      if (live) return <InboundDetailPage email={live} isTrashed={false} />;

      const trashed = await inboundService.getTrashedInboundEmailById(params.id);
      if (trashed) return <InboundDetailPage email={trashed} isTrashed={true} />;

      set.status = 404;
      return "Inbound email not found";
    },
    { beforeHandle: memberGuard, params: t.Object({ id: t.String() }) },
  )

  /**
   * GET /dashboard/inbound/:id/reply (#86)
   *
   * Pre-fills the compose form with a reply skeleton. The chosen
   * direction:
   *   - `from` = the address that *received* the inbound (the user's
   *     own address) so reputation + SPF/DKIM stay aligned.
   *   - `to` = the original sender.
   *   - `subject` = the original subject prefixed with "Re: " when not
   *     already prefixed (case-insensitive to avoid double "Re:" loops).
   *   - body = the original message quoted: HTML wrapped in a
   *     `<blockquote>` with an attribution line, plain text with the
   *     classic `>` line prefix.
   *
   * This is a GET: operator may navigate to it, see what's pre-filled,
   * back out without sending. No side effects until they hit Send.
   *
   * Trash status is not consulted: replying to a trashed message is
   * fine; the trash bit only governs the destructive Delete forever path.
   */
  .get(
    "/inbound/:id/reply",
    async ({ params, set }) => {
      const inbound =
        (await inboundService.getInboundEmailById(params.id)) ??
        (await inboundService.getTrashedInboundEmailById(params.id));
      if (!inbound) {
        set.status = 404;
        return "Inbound email not found";
      }

      const originalSubject = inbound.subject ?? "";
      const replySubject = /^re:/i.test(originalSubject)
        ? originalSubject
        : `Re: ${originalSubject || "(no subject)"}`;

      /**
       * Quote construction. Attribution line uses the original sender +
       * received date. HTML and plain-text variants are constructed
       * independently: we don't auto-derive one from the other so the
       * quote matches whatever the original message actually had.
       */
      const receivedIso = inbound.receivedAt.toISOString();
      const attribution = `On ${receivedIso}, ${inbound.fromAddress} wrote:`;

      /** Defensive HTML escape: the attribution components (ISO date,
       *  email address) shouldn't contain `<>&"'` in practice, but a
       *  hostile sender shouldn't be able to inject anything either. */
      const escapeHtml = (s: string): string =>
        s.replace(/[&<>"']/g, (c) => {
          const map: Record<string, string> = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          };
          return map[c]!;
        });

      const quotedHtml = inbound.html
        ? `<p></p><p>${escapeHtml(attribution)}</p><blockquote style="margin:0 0 0 0.8em;padding-left:1em;border-left:2px solid #ccc;color:#555;">${inbound.html}</blockquote>`
        : undefined;

      const quotedText = inbound.textContent
        ? `\n\n${attribution}\n${inbound.textContent
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")}`
        : undefined;

      const keys = await apiKeyService.listApiKeys();
      const activeKeys = keys.filter((k) => k.isActive);

      return (
        <SendEmailPage
          flash={undefined}
          apiKeys={activeKeys}
          defaultApiKeyId={activeKeys[0]?.id}
          prefill={{
            from: inbound.toAddress,
            to: inbound.fromAddress,
            subject: replySubject,
            html: quotedHtml,
            text: quotedText,
          }}
        />
      );
    },
    { beforeHandle: memberGuard, params: t.Object({ id: t.String() }) },
  )

  /**
   * GET /dashboard/dmarc-reports: list page with optional `?domain=`
   * filter. The filter dropdown is driven by the distinct set of
   * domains we have reports for.
   */
  .get(
    "/dmarc-reports",
    async ({ query }) => {
      const { page, limit } = parsePagination(query);
      const domain = query.domain || undefined;

      const { data, total } = await dmarcReportsService.listDmarcReports({
        page,
        limit,
        domain,
      });

      const domains = await dmarcReportsService.listReportDomains();

      return (
        <DmarcReportsPage
          reports={data}
          total={total}
          page={page}
          limit={limit}
          domainFilter={domain}
          domains={domains}
        />
      );
    },
    {
      beforeHandle: memberGuard,
      query: t.Object({
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        domain: t.Optional(t.String()),
      }),
    },
  )

  /** GET /dashboard/dmarc-reports/:id, detail with per-source-IP records. */
  .get(
    "/dmarc-reports/:id",
    async ({ params, set }) => {
      const result = await dmarcReportsService.getDmarcReportById(params.id);
      if (!result) {
        set.status = 404;
        return "DMARC report not found";
      }
      return <DmarcReportDetailPage report={result.report} records={result.records} />;
    },
    { beforeHandle: memberGuard, params: t.Object({ id: t.String() }) },
  )

  /**
   * GET /dashboard/suppressions (#89)
   *
   * Admin-scoped list across every API key. Auto-suppressions get
   * filed under whichever key happened to be sending when a bounce
   * arrived; before this page the only way to clear a stuck
   * suppression was direct SQL because the suppression's owning key
   * was rarely the same key as the operator's Bearer token. The list
   * supports two filter params (`email` substring + `apiKeyId`) and
   * per-row deletion via a POST sibling route.
   */
  .get(
    "/suppressions",
    async ({ query }) => {
      const { page, limit } = parsePagination(query, 25);

      const [{ data, total }, allKeys] = await Promise.all([
        suppressionService.listAllSuppressions({
          page,
          limit,
          email: query.email || undefined,
          apiKeyId: query.apiKeyId || undefined,
        }),
        apiKeyService.listApiKeys(),
      ]);

      /** Pre-build the id→name lookup once so the page component
       *  doesn't have to make N service calls or duplicate logic. */
      const apiKeyLabels = Object.fromEntries(
        allKeys.map((k) => [k.id, { name: k.name }]),
      );

      const flash = toFlash(query.flash, query.flashType);

      return (
        <SuppressionsPage
          suppressions={data}
          total={total}
          page={page}
          limit={limit}
          filters={{
            email: query.email || undefined,
            apiKeyId: query.apiKeyId || undefined,
          }}
          apiKeys={allKeys}
          apiKeyLabels={apiKeyLabels}
          flash={flash}
        />
      );
    },
    {
      beforeHandle: memberGuard,
      query: t.Object({
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        email: t.Optional(t.String()),
        apiKeyId: t.Optional(t.String()),
        flash: t.Optional(t.String()),
        flashType: t.Optional(t.String()),
      }),
    },
  )

  /**
   * POST /dashboard/suppressions/:id/delete (#89)
   *
   * Unscoped delete: the dashboard session already authenticated; we
   * trust the operator to clear any suppression they can see. Redirect
   * back to the list (preserving the filter context that brought them
   * here would be nicer; deferred to keep this PR tight).
   */
  .post(
    "/suppressions/:id/delete",
    async ({ params, set }) => {
      const removed = await suppressionService.deleteSuppressionByIdUnscoped(params.id);
      const flash = removed
        ? `Suppression for ${removed.email} removed`
        : "Suppression not found (already deleted?)";
      const flashType = removed ? "success" : "error";

      set.status = 302;
      set.headers["location"] =
        `/dashboard/suppressions?flash=${encodeURIComponent(flash)}&flashType=${flashType}`;
      return "";
    },
    { beforeHandle: adminGuard, params: t.Object({ id: t.String() }) },
  );
