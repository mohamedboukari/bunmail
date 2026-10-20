import { Elysia } from "elysia";
import { html } from "@elysiajs/html";
import { assetResponse } from "./static-assets.tsx";
import { withSessionGuard } from "./lib/session-guard.ts";
import { authPages } from "./plugins/auth.plugin.tsx";
import { homePages } from "./plugins/home.plugin.tsx";
import { accountPages } from "./plugins/account.plugin.tsx";
import { passkeyAccountPages, passkeyLoginPages } from "./plugins/passkeys.plugin.tsx";
import { emailPages } from "./plugins/emails.plugin.tsx";
import { apiKeyPages } from "./plugins/api-keys.plugin.tsx";
import { invitationPages } from "./plugins/invitations.plugin.tsx";
import { userPages } from "./plugins/users.plugin.tsx";
import { auditLogPages } from "./plugins/audit-log.plugin.tsx";
import { domainPages } from "./plugins/domains.plugin.tsx";
import { templatePages } from "./plugins/templates.plugin.tsx";
import { webhookPages } from "./plugins/webhooks.plugin.tsx";
import { inboundPages } from "./plugins/inbound.plugin.tsx";
import { dmarcPages } from "./plugins/dmarc.plugin.tsx";
import { suppressionPages } from "./plugins/suppressions.plugin.tsx";

/* ─── Dashboard Plugin ─── */

/**
 * Pages plugin: server-rendered dashboard under /dashboard.
 *
 * Routes:
 * - GET  /dashboard/login           → login form (email + password)
 * - POST /dashboard/login           → check email + password, open a session, set cookie
 *                                    (`pending`, then the second step, for a 2FA account, #220)
 * - GET  /dashboard/login/two-factor → second step form (public, needs a pending session, #220)
 * - POST /dashboard/login/two-factor → check the TOTP or recovery code, mfa session (public, #220)
 * - POST /dashboard/login/passkey/options → passwordless passkey options, bm_wa cookie (public, #223)
 * - POST /dashboard/login/passkey   → verify the passkey, open an mfa session (public, #223)
 * - POST /dashboard/login/two-factor/passkey/options → second-step passkey options (public, pending session, #223)
 * - POST /dashboard/login/two-factor/passkey → second step with a passkey, mfa session (public, #223)
 * - POST /dashboard/logout          → revoke the session, clear cookie, redirect
 * - GET  /dashboard/setup?token=    → owner setup form (public, #215)
 * - POST /dashboard/setup           → set the owner password, sign in (public, #215)
 * - GET  /dashboard/invite?token=   → invitation accept form (public, #217)
 * - POST /dashboard/invite          → create the invited account, sign in (public, #217)
 * - GET  /dashboard/reset?token=    → password reset form (public, #277)
 * - POST /dashboard/reset           → set the new password, sign out everywhere, sign in (public, #277)
 * - GET  /dashboard/assets/dashboard.css → the self-hosted stylesheet (public, #255)
 * - GET  /dashboard/assets/dashboard.js  → the dashboard script (public, #255)
 * - GET  /dashboard                 → home (stats overview)
 * - GET  /dashboard/account/password → change password form (any role, #279)
 * - POST /dashboard/account/password → change own password, sign out everywhere else (any role, #279)
 * - GET  /dashboard/account/sessions → own live sessions, this device marked (any role, #281)
 * - POST /dashboard/account/sessions/:id/revoke → sign out one own session (any role, #281)
 * - POST /dashboard/account/sessions/revoke-others → sign out every other own session (any role, #281)
 * - GET  /dashboard/account/two-factor → 2FA status, enrolment QR code, recovery codes once (any role, #220)
 * - POST /dashboard/account/two-factor/start → new pending TOTP secret on this session (any role, #220)
 * - POST /dashboard/account/two-factor/confirm → first code: 2FA on, recovery codes, other sessions out (any role, #220)
 * - POST /dashboard/account/two-factor/recovery-codes → ten new recovery codes, app code needed (any role, #220)
 * - POST /dashboard/account/two-factor/disable → 2FA off, password and code needed (any role, #220)
 * - GET  /dashboard/account/passkeys → own passkeys, add / rename / remove forms (any role, #223)
 * - POST /dashboard/account/passkeys/options → password, then creation options (any role, #223)
 * - POST /dashboard/account/passkeys → verify and store the new passkey (any role, #223)
 * - POST /dashboard/account/passkeys/:id/rename → rename an own passkey (any role, #223)
 * - POST /dashboard/account/passkeys/:id/delete → remove an own passkey, password needed (any role, #223)
 * - GET  /dashboard/send            → send form (members: own keys only, #219)
 * - GET  /dashboard/emails          → email list with filters
 * - GET  /dashboard/emails/:id      → email detail
 * - GET  /dashboard/api-keys        → API keys list + create form (members: their own keys, #219)
 * - POST /dashboard/api-keys        → create API key (members: restricted only, #219)
 * - POST /dashboard/api-keys/:id/admin → promote/demote a key (admin)
 * - POST /dashboard/api-keys/:id/senders → set allowed senders (members: own keys, #219)
 * - POST /dashboard/api-keys/:id/revoke → revoke API key (members: own keys, #219)
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
 * - POST /dashboard/users/:id/reset-password → one-time reset link, revealed once (admin, #277)
 * - GET  /dashboard/audit-log       → security-relevant actions, filterable, read-only (admin, #221)
 * - GET  /dashboard/domains         → domains list + add form
 * - POST /dashboard/domains         → add domain (form action)
 * - POST /dashboard/domains/:id/delete → delete domain (form action)
 * - GET  /dashboard/domains/:id     → domain detail
 * - POST /dashboard/domains/:id/dkim/rotate          → start a DKIM key rotation (admin, #250)
 * - POST /dashboard/domains/:id/dkim/rotate/complete → switch to the pending key once published (admin, #250)
 * - POST /dashboard/domains/:id/dkim/rotate/cancel   → drop the pending key (admin, #250)
 *
 * Auth (#216): account login with email and password against
 * `user_credentials`, then a server-side session in the `sessions` table
 * whose opaque token rides in the `bm_session` cookie and rotates every
 * minute. An account with a second factor (#220: TOTP; #223: a passkey)
 * gets a `pending` session that only the second step opens; a passkey
 * also signs in on its own (passwordless, #223); `REQUIRE_2FA` holds accounts that must
 * enrol on their Two-factor page. The owner setup, invitation accept and password reset routes
 * are authorized by their one-time token.
 *
 * Roles (#222): the session guard puts the signed-in account on `auth`,
 * and every protected route carries a role check from `guards.tsx` as its
 * own `beforeHandle`: `memberGuard` (any signed-in account), `adminGuard`
 * or `ownerGuard`. A new route needs one of them and an entry in the
 * route table of `dashboard-route-access.integration.test.ts`.
 *
 * Layout (#291): the routes live in one functional plugin per area under
 * `plugins/`, shared helpers under `lib/`. A functional plugin
 * (`(app) => app.get(...)`) is called with this instance itself, so its
 * routes are registered here, in the order below, exactly as if they were
 * written inline: the public routes first, then the session guard
 * (`lib/session-guard.ts`, a local `resolve`), then the protected areas,
 * every one of which therefore runs behind the guard. A separate
 * `new Elysia()` per area would also inherit the guard at runtime, but its
 * handlers would not see the type of `auth`; the protected areas take
 * `GuardedDashboard`, the type the guard returns, so they do, with no
 * cast. That type does not prove a plugin is mounted after the guard: the
 * order below does, and `dashboard-route-access.integration.test.ts`
 * checks every route for the session guard and its role guard.
 */
export const pagesPlugin = new Elysia({
  prefix: "/dashboard",
  normalize: true,
  detail: { hide: true },
})
  /** Enable JSX rendering via @elysiajs/html */
  .use(html())

  /* ─── Public Routes (no session required) ─── */

  /**
   * GET /dashboard/assets/dashboard.css, GET /dashboard/assets/dashboard.js
   * The stylesheet and script every page loads (#255, part 2), public so
   * the login and setup pages can use them. Cached for a year: the pages
   * link them with a content-hash `?v=` (see `static-assets.tsx`).
   */
  .get("/assets/dashboard.css", () => assetResponse("dashboard.css"))
  .get("/assets/dashboard.js", () => assetResponse("dashboard.js"))

  /** Login, logout, owner setup, invitation accept, password reset. */
  .use(authPages)

  /** Passwordless passkey sign-in and the passkey second step (#223). */
  .use(passkeyLoginPages)

  /* ─── Session Guard ─── */

  /** Every route registered after it needs a live session (#216). */
  .use(withSessionGuard)

  /* ─── Protected Routes (each with its own role guard) ─── */

  .use(homePages)
  .use(accountPages)
  .use(passkeyAccountPages)
  .use(emailPages)
  .use(apiKeyPages)
  .use(invitationPages)
  .use(userPages)
  .use(auditLogPages)
  .use(domainPages)
  .use(templatePages)
  .use(webhookPages)
  .use(inboundPages)
  .use(dmarcPages)
  .use(suppressionPages);
