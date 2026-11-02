import type { PublicDashboard } from "../lib/session-guard.ts";
import { passkeySignInPages } from "./passkey-sign-in.plugin.tsx";
import { passkeySecondStepPages } from "./passkey-second-step.plugin.tsx";

export { passkeyAccountPages } from "./passkey-account.plugin.tsx";

/**
 * Passkeys (WebAuthn, #223) in the dashboard: the passwordless sign-in
 * and the second login step (public, before the session guard), and the
 * Passkeys page with its actions (after it). The ceremonies themselves run
 * in the browser (`dashboard.js`); each one is an options request (a
 * same-origin `fetch` POST answering JSON) and a finish form (a normal
 * POST answering a redirect).
 *
 * Every route works only when `APP_BASE_URL` gives a relying party
 * (`relyingPartyFrom`); otherwise passkeys are off and the routes say so.
 */

/**
 * Public passkey routes (#223): the passwordless sign-in and the passkey
 * second login step. Mounted before the session guard; each checks
 * same-origin itself and is authorized by what it binds to (the `bm_wa`
 * cookie, the `pending` session).
 */
export function passkeyLoginPages(app: PublicDashboard) {
  /**
   * Two groups (#387), each registering its routes on this same instance,
   * in this order: the passwordless sign-in, then the passkey second step.
   * The second takes the first one's instance, so the route types are
   * those of one chain. The Passkeys page is `passkey-account.plugin.tsx`.
   */
  return passkeySecondStepPages(passkeySignInPages(app));
}
