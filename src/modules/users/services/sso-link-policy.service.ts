import type { SsoProviderSettings } from "../../../config.ts";
import type {
  SsoAutoLinkRefusal,
  SsoIdentity,
  SsoSignInRefusal,
} from "../types/sso.types.ts";

/**
 * The pure rules of SSO links (#224): how a link is keyed and named, how a
 * stored link is matched back to a configured provider, who may sign in
 * with one, and when an unknown identity is linked by its email. No
 * database, no config read: `sso-link.service.ts`, the sign-in and the
 * Sign-in methods page pass the providers in.
 */

/** The credential type of an SSO link. */
export const SSO_CREDENTIAL = "oauth";

/** Prefix of `user_credentials.provider` for an OpenID Connect issuer. */
const OIDC_PREFIX = "oidc:";

/** Longest `user_credentials.name` (varchar(100)): the label kept at link time. */
const MAX_LINK_NAME_LENGTH = 100;

/**
 * The `user_credentials.provider` value of a link: `oidc:<issuer>`. Keyed
 * by the issuer, not by the id in `SSO_PROVIDERS`, so renaming a provider's
 * id in `.env` does not orphan its links. With the subject, it is the
 * identity key `(issuer, sub)`: never the email, which providers let users
 * change and reassign.
 */
export function ssoProviderKey(issuer: string): string {
  return `${OIDC_PREFIX}${issuer}`;
}

/**
 * Control (`Cc`) and format (`Cf`: bidi overrides, zero-width characters)
 * characters, removed from a link's name as invitations refuse them: they
 * can make a name look like another one.
 */
const CONTROL_OR_FORMAT_RE = /[\p{Cc}\p{Cf}]/gu;

/**
 * The label kept with a link (`user_credentials.name`): the provider email
 * at link time, else the `name` claim, with control and format characters
 * removed and trimmed, when something is left and it fits the column (in
 * characters, as Postgres counts them); `null` otherwise (the page then
 * shows the provider only). Shown to the account holder, never used to
 * decide anything.
 */
export function ssoLinkName(
  identity: Pick<SsoIdentity, "email" | "name">,
): string | null {
  for (const candidate of [identity.email, identity.name]) {
    if (candidate === null) continue;
    const cleaned = candidate.replace(CONTROL_OR_FORMAT_RE, "").trim();
    const length = Array.from(cleaned).length;
    if (length > 0 && length <= MAX_LINK_NAME_LENGTH) return cleaned;
  }
  return null;
}

/** The configured provider a stored link belongs to (by its issuer), or `null`. */
export function providerOfLink(
  key: string,
  providers: readonly SsoProviderSettings[],
): SsoProviderSettings | null {
  return providers.find((provider) => ssoProviderKey(provider.issuer) === key) ?? null;
}

/**
 * How a stored link is named on the page when its provider is no longer
 * configured: the issuer's host, or the stored value when it does not
 * parse.
 */
export function unconfiguredLinkLabel(key: string): string {
  const issuer = key.startsWith(OIDC_PREFIX) ? key.slice(OIDC_PREFIX.length) : key;
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

/**
 * How the audit log names a link's provider: its id in `SSO_PROVIDERS` and
 * its label; when no configured provider has that issuer any more, the
 * stored `oidc:<issuer>` and the issuer's host.
 */
export function auditProviderOf(
  key: string,
  providers: readonly SsoProviderSettings[],
): { id: string; label: string } {
  const provider = providerOfLink(key, providers);
  return provider
    ? { id: provider.id, label: provider.label }
    : { id: key, label: unconfiguredLinkLabel(key) };
}

/**
 * The owner rule (#224): the owner may link an identity only while it has
 * a BunMail second factor, so SSO never becomes a one-factor way into the
 * owner account (a takeover at the provider, or by its administrator,
 * still meets BunMail's own second factor).
 */
export function ownerNeedsSecondFactor(role: string, hasSecondFactor: boolean): boolean {
  return role === "owner" && !hasSecondFactor;
}

/**
 * Why a proven identity may not sign in (#224), or `null` when it may.
 * `account` is the account linked to `(issuer, sub)`, `null` when none is.
 * In order: no linked account (`unknown_identity`: never looked up by
 * email), a disabled one (`deactivated`), then the owner rule
 * (`owner_second_factor_required`): an owner without a BunMail second
 * factor never gets a one-factor session from SSO, whatever made the
 * link rules not hold.
 */
export function ssoSignInRefusal(
  account: { disabled: boolean; role: string; hasSecondFactor: boolean } | null,
): SsoSignInRefusal | null {
  if (account === null) return "unknown_identity";
  if (account.disabled) return "deactivated";
  if (ownerNeedsSecondFactor(account.role, account.hasSecondFactor)) {
    return "owner_second_factor_required";
  }
  return null;
}

/** Google's issuer: its `hd` claim says whether Google is authoritative for an address. */
const GOOGLE_ISSUER = "https://accounts.google.com";

/** The one domain Google is authoritative for without an `hd` claim. */
const GMAIL_DOMAIN = "gmail.com";

/**
 * The email an unknown identity may be linked by (#224, part 4:
 * `SSO_<ID>_AUTO_LINK=true`), or why not. Pure: the claims only, before
 * any account is looked up. In order:
 *
 * 1. `email_unverified`: the ID token's email was not kept (absent, not
 *    plain ASCII) or `email_verified` was not the boolean `true`
 *    (`SsoIdentity.emailVerified`, set by `completeSsoCallback`).
 * 2. `domain_not_allowed`: the email's domain (already ASCII lower-cased)
 *    is not in `SSO_<ID>_ALLOWED_DOMAINS`, compared exactly: no
 *    subdomains, so `corp.com` does not let `x.corp.com` in.
 * 3. `hosted_domain_not_allowed`: Google's `hd` claim, when present, must
 *    be an allowed domain too (the Workspace organization the account
 *    belongs to; a user of a secondary domain carries the primary one).
 *    For Google's issuer, `hd` is required unless the address is
 *    `gmail.com`: a consumer Google account can carry any address that
 *    was verified once, and Google is not authoritative for it after
 *    that (a former employee keeps a Google account on their old work
 *    address).
 *
 * The configuration guarantees allowed domains whenever auto-link is on;
 * an empty list refuses everything here anyway.
 */
export function ssoAutoLinkEmail(
  provider: Pick<SsoProviderSettings, "issuer" | "allowedDomains">,
  identity: Pick<SsoIdentity, "email" | "emailVerified" | "hostedDomain">,
): { ok: true; email: string } | { ok: false; reason: SsoAutoLinkRefusal } {
  const { email } = identity;
  if (email === null || !identity.emailVerified) {
    return { ok: false, reason: "email_unverified" };
  }
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (!provider.allowedDomains.includes(domain)) {
    return { ok: false, reason: "domain_not_allowed" };
  }
  const hd = identity.hostedDomain;
  const hdRefused =
    hd === null
      ? provider.issuer === GOOGLE_ISSUER && domain !== GMAIL_DOMAIN
      : !provider.allowedDomains.includes(hd);
  if (hdRefused) return { ok: false, reason: "hosted_domain_not_allowed" };
  return { ok: true, email };
}

/**
 * Why the account an email matched may not be linked automatically
 * (#224, part 4), or `null` when it may. Only an enabled **member without
 * a BunMail second factor** and without an identity at this provider is.
 * `accounts` are the accounts with that address (emails are unique, so at
 * most one; anything but exactly one is `no_account_for_email`). In
 * order: none, a disabled account (`deactivated`), the owner
 * (`owner_not_auto_linked`), an admin (`admin_not_auto_linked`), an
 * account with a second factor (`second_factor_enrolled`: the link would
 * be written before that factor is passed and outlive it, a dormant
 * single-factor way in once the factor is removed; such accounts link
 * explicitly, behind the password), then an account that already has an
 * identity at this provider (`provider_already_linked`).
 * `identityLinkedElsewhere` is true when the identity itself is linked to
 * another account (only possible through a racing link): `already_linked`.
 */
export function ssoAutoLinkRefusal(
  accounts: ReadonlyArray<{ disabled: boolean; role: string; hasSecondFactor: boolean }>,
  links: { providerLinked: boolean; identityLinkedElsewhere: boolean },
): SsoAutoLinkRefusal | null {
  const [account] = accounts;
  if (account === undefined || accounts.length !== 1) return "no_account_for_email";
  if (account.disabled) return "deactivated";
  if (account.role === "owner") return "owner_not_auto_linked";
  if (account.role !== "member") return "admin_not_auto_linked";
  if (account.hasSecondFactor) return "second_factor_enrolled";
  if (links.providerLinked) return "provider_already_linked";
  if (links.identityLinkedElsewhere) return "already_linked";
  return null;
}
