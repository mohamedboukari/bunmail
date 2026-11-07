import type { Context } from "elysia";
import { config, type SsoProviderSettings } from "../../config.ts";
import { rateLimitBucket } from "../../middleware/login-rate-limit.ts";
import type {
  RemovedSsoLink,
  SsoLinkRefusal,
} from "../../modules/users/types/sso.types.ts";
import { auditProviderOf } from "../../modules/users/services/sso-link-policy.service.ts";
import type { SsoAlertFacts } from "../../modules/users/services/two-factor-alert.service.ts";
import { ssoLogoKind, type SsoLogoKind } from "../components/sso-logo.tsx";
import { redirect } from "./responses.ts";

/**
 * What the SSO routes share (#224): the sign-in routes
 * (`sso-login.plugin.tsx`, public) and the Sign-in methods page
 * (`sso.plugin.tsx`, after the session guard).
 */

/** The Sign-in methods page. */
export const SSO_PAGE = "/dashboard/account/sso";

/** What the page says for a refused link. */
export const LINK_REFUSAL: Record<SsoLinkRefusal | "rate_limited", string> = {
  rate_limited: "Too many attempts. Try again later.",
  wrong_password: "Current password is incorrect.",
  second_factor_required:
    "As the owner, you need a second factor before you can link a single sign-on account.",
  provider_already_linked: "Your account already has an account linked at that provider.",
  already_linked:
    "That account at the provider is already linked to another BunMail account.",
  session_changed:
    "Your session changed while you were at the provider. Sign in and try again.",
};

/** The configured provider with this id, or `null`. */
export function providerById(id: string): SsoProviderSettings | null {
  return config.sso.providers.find((provider) => provider.id === id) ?? null;
}

/** Redirects to the Sign-in methods page with a flash banner. */
export function toSsoPage(
  set: Context["set"],
  message: string,
  type: "success" | "error",
): string {
  return redirect(
    set,
    `${SSO_PAGE}?flash=${encodeURIComponent(message)}&flashType=${type}`,
  );
}

/**
 * The login page's "Sign in with <label>" buttons: every configured
 * provider while SSO is on (an `https://` `APP_BASE_URL`), none otherwise.
 * A provider is configured only with its client credentials set, so one
 * without them never gets a button. Only the id, the label and the logo
 * chosen by its issuer's host (`ssoLogoKind`): never the client secret.
 */
export function ssoSignInButtons(): Array<{
  id: string;
  label: string;
  logo: SsoLogoKind;
}> {
  if (config.sso.baseUrl === null) return [];
  return config.sso.providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    logo: ssoLogoKind(provider),
  }));
}

/**
 * The label of a stored `oidc:<issuer>` for the new-device alert (#224):
 * the configured provider's label, or the issuer's host once it is gone;
 * `undefined` for a session opened with anything but SSO.
 */
export function ssoProviderLabelOf(key: string | null | undefined): string | undefined {
  return key === null || key === undefined || key === ""
    ? undefined
    : auditProviderOf(key, config.sso.providers).label;
}

/**
 * The SSO links a reset removed (#224), as the `removed_by_reset` email
 * lists them: the provider's label (its issuer's host once it is no longer
 * configured) and the provider account named at link time.
 */
export function removedLinkFacts(links: readonly RemovedSsoLink[]): SsoAlertFacts[] {
  return links.map((link) => ({
    provider: auditProviderOf(link.provider, config.sso.providers).label,
    account: link.name,
  }));
}

/**
 * Why a callback request is refused before anything is counted (#224), or
 * `null` when it goes on to the limiter and the flow checks:
 *
 * - `not_a_navigation`: `Sec-Fetch-Dest` is present and is not `document`.
 *   The provider sends the browser back with a top-level navigation; an
 *   `<img>`, a script or a frame pointing at the callback from another
 *   site is not one.
 * - `no_flow_cookie`: no `bm_sso` cookie. A flow always has one, and
 *   another site cannot set it.
 *
 * Neither is counted against the per-IP login limiter nor recorded:
 * otherwise any page could spend a visitor's sign-in budget (and write
 * audit rows) with a handful of embedded requests. A request that carries
 * a flow cookie is counted as before.
 */
export function uncountedCallbackRefusal(
  headers: Headers,
  flowCookie: string | undefined,
): "not_a_navigation" | "no_flow_cookie" | null {
  const dest = headers.get("sec-fetch-dest");
  if (dest !== null && dest !== "document") return "not_a_navigation";
  if (flowCookie === undefined) return "no_flow_cookie";
  return null;
}

/** Starts of an SSO sign-in allowed per client address (bucket) and window. */
export const SSO_START_MAX = 20;

/** The window of {@link SSO_START_MAX}, in milliseconds (15 minutes). */
export const SSO_START_WINDOW_MS = 15 * 60 * 1000;

/**
 * The start budget's key for a client address (#224): `sso-start:ip:` and
 * the address's bucket (`rateLimitBucket`: an IPv6 /64 counts as one), on
 * the login limiter's shared window counters (Redis with `REDIS_URL`).
 */
export function ssoStartKey(ip: string): string {
  return `sso-start:ip:${rateLimitBucket(ip)}`;
}
