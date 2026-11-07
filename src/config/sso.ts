import { optionalStrictBoolean } from "./env.ts";

/** An SSO provider id (#224): lowercase letters, digits and `-`, 1 to 32. */
const SSO_PROVIDER_ID_RE = /^[a-z0-9-]{1,32}$/;

/** Scopes requested when `SSO_<ID>_SCOPES` is unset. */
export const DEFAULT_SSO_SCOPES = "openid email profile";

/**
 * Longest issuer URL accepted, in characters. A link is stored as
 * `oidc:<issuer>` in `user_credentials.provider`, which SSO widens to 255
 * characters (#224), so the issuer may take 250 of them.
 */
export const MAX_SSO_ISSUER_LENGTH = 250;

/** Longest `SSO_<ID>_LABEL`, in characters (it is button text). */
const MAX_SSO_LABEL_LENGTH = 64;

/**
 * Client ids and secrets: printable ASCII without spaces, as every
 * provider issues them, so a value pasted with a stray quote or line break
 * refuses to boot instead of failing every sign-in.
 */
const SSO_CLIENT_VALUE_RE = /^[\x21-\x7e]{1,512}$/;

/** One scope token (RFC 6749 section 3.3): printable ASCII but `"` and `\`. */
const SSO_SCOPE_TOKEN_RE = /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/;

/**
 * Issuer hosts of Microsoft Entra ID (#224, part 4), the global cloud and
 * the sovereign and national ones (US Gov, China operated by 21Vianet,
 * the legacy Germany cloud). Entra's `email` claim is not a verified,
 * immutable value (the "nOAuth" class of takeover), so linking by email
 * is refused at boot for these issuers. Matched exactly, by host name.
 */
const ENTRA_ISSUER_HOSTS: ReadonlySet<string> = new Set([
  "login.microsoftonline.com",
  "sts.windows.net",
  "login.microsoftonline.us",
  "login.partner.microsoftonline.cn",
  "login.chinacloudapi.cn",
  "sts.chinacloudapi.cn",
  "login.microsoftonline.de",
]);

/** True for a Microsoft Entra ID issuer host (see {@link ENTRA_ISSUER_HOSTS}). */
export function isEntraIssuerHost(hostname: string): boolean {
  return ENTRA_ISSUER_HOSTS.has(hostname);
}

/**
 * Defaults for a provider id that names a well-known OpenID provider
 * (#224): its issuer and button label, so its client id and secret are
 * all it needs. An explicit `SSO_<ID>_ISSUER` or `SSO_<ID>_LABEL` wins (a
 * self-hosted GitLab, for one). A preset is also enabled without being
 * listed in `SSO_PROVIDERS` once its client id or secret is set. Every
 * other id needs `SSO_<ID>_ISSUER`: Microsoft's carries the tenant.
 */
const SSO_PROVIDER_PRESETS: ReadonlyMap<string, { issuer: string; label: string }> =
  new Map([
    ["google", { issuer: "https://accounts.google.com", label: "Google" }],
    ["gitlab", { issuer: "https://gitlab.com", label: "GitLab" }],
  ]);

/** One label of a domain name in `SSO_<ID>_ALLOWED_DOMAINS`. */
const DOMAIN_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Lower-cases ASCII letters only (#224). `String#toLowerCase` folds some
 * non-ASCII characters into ASCII ones (the Kelvin sign U+212A becomes
 * `k`), which would let a look-alike pass a domain or email comparison.
 */
export function asciiLowerCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * True for a lower-case ASCII fully qualified domain name of at most 253
 * characters (#224): labels of letters, digits and inner hyphens, at
 * least two of them. Used for `SSO_<ID>_ALLOWED_DOMAINS` and for the email
 * and `hd` claims of an ID token.
 */
export function isLowerAsciiDomain(value: string): boolean {
  return (
    value.length <= 253 &&
    value.includes(".") &&
    value.split(".").every((label) => DOMAIN_LABEL_RE.test(label))
  );
}

/** One OpenID Connect provider configured in `SSO_PROVIDERS` (#224). */
export interface SsoProviderSettings {
  /** The id from `SSO_PROVIDERS`; also the path segment of its routes. */
  id: string;
  /** `SSO_<ID>_ISSUER`, exactly as configured: compared byte for byte. */
  issuer: string;
  /** `SSO_<ID>_CLIENT_ID`. */
  clientId: string;
  /** `SSO_<ID>_CLIENT_SECRET`. Never logged, never rendered. */
  clientSecret: string;
  /** `SSO_<ID>_LABEL`, the button text; the id when unset. Rendered escaped. */
  label: string;
  /** `SSO_<ID>_SCOPES`, space-separated, always with `openid`. */
  scopes: string;
  /** `SSO_<ID>_ALLOWED_DOMAINS`, lower-cased; empty means any domain. */
  allowedDomains: readonly string[];
  /** `SSO_<ID>_AUTO_LINK`: link by verified email (needs allowed domains). */
  autoLink: boolean;
}

/** The SSO settings (#224), see {@link readSsoSettings}. */
export interface SsoSettings {
  /** The configured providers, validated; empty when none has credentials. */
  providers: readonly SsoProviderSettings[];
  /**
   * Providers listed in `SSO_PROVIDERS` with neither a client id nor a
   * client secret: left out (no button, no routes), and `src/index.ts`
   * warns once at boot, naming the missing variables (never values).
   */
  skipped: ReadonlyArray<{ id: string; missing: readonly string[] }>;
  /**
   * The `APP_BASE_URL` the redirect URIs are built on, without a trailing
   * slash, or `null` when it is not `https://` (or plain `http://` on a
   * loopback host). `null` with providers configured means SSO is off;
   * `src/index.ts` warns once at boot (this file cannot log).
   */
  baseUrl: string | null;
}

/**
 * True for the host names that never leave the machine: `localhost`,
 * `127.0.0.1` and `[::1]` (as `URL.hostname` spells it). Plain `http://`
 * is accepted for these only.
 */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * The base URL SSO redirect URIs are built on (#224), or `null` when
 * `raw` cannot carry them: empty, not a URL, a query or fragment, or not
 * `https://` (plain `http://` only on a loopback host). Trailing slashes
 * are dropped, as for `config.appBaseUrl`.
 */
export function ssoBaseUrlFrom(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  if (url.protocol === "https:") return trimmed;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return trimmed;
  return null;
}

/** The env-var prefix of a provider id: `my-idp` reads `SSO_MY_IDP_*`. */
export function ssoEnvPrefix(id: string): string {
  return `SSO_${id.toUpperCase().replace(/-/g, "_")}_`;
}

/** True when an environment value is unset or only whitespace. */
function isBlank(raw: string | undefined): boolean {
  return (raw?.trim() ?? "") === "";
}

/**
 * Reads `SSO_<ID>_ISSUER`: an absolute `https://` URL (plain `http://`
 * only on a loopback host) with no credentials, query or fragment (OpenID
 * Connect Discovery section 2), at most {@link MAX_SSO_ISSUER_LENGTH}
 * characters. Kept exactly as written: the discovery document and every
 * ID token must carry this exact string. Unset or blank: the preset's
 * issuer (`fallback`) when the id has one, otherwise refused. The preset
 * goes through the same checks as a configured value.
 */
function readSsoIssuer(
  key: string,
  raw: string | undefined,
  fallback: string | undefined,
): string {
  const issuer = isBlank(raw) ? (fallback ?? "") : (raw?.trim() ?? "");
  if (issuer === "") {
    throw new Error(`[config] ${key} must be set: the provider's issuer URL.`);
  }
  if (issuer.length > MAX_SSO_ISSUER_LENGTH) {
    throw new Error(
      `[config] ${key} must be at most ${MAX_SSO_ISSUER_LENGTH} characters, got ${issuer.length}.`,
    );
  }
  /**
   * The value is echoed only once it is known to hold no credentials,
   * query or fragment: a URL that fails to parse, or carries
   * `user:pass@` or a token in its query, must never reach the boot log.
   */
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error(`[config] ${key} must be an absolute URL (value not shown).`);
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      `[config] ${key} must not carry credentials, a query or a fragment (value not shown).`,
    );
  }
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && isLoopbackHost(url.hostname));
  if (!secure) {
    throw new Error(
      `[config] ${key} must be an https:// URL (plain http:// only for localhost), got "${issuer}".`,
    );
  }
  return issuer;
}

/** Reads a client id or secret; the value is never echoed in the error. */
function readSsoClientValue(key: string, raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (!SSO_CLIENT_VALUE_RE.test(value)) {
    throw new Error(
      `[config] ${key} must be set: 1 to 512 printable characters without spaces.`,
    );
  }
  return value;
}

/**
 * Reads `SSO_<ID>_LABEL`: 1 to 64 characters, no control characters.
 * Unset or blank: `fallback` (the preset's label, otherwise the id).
 */
function readSsoLabel(key: string, fallback: string, raw: string | undefined): string {
  const label = raw?.trim() ?? "";
  if (label === "") return fallback;
  if (label.length > MAX_SSO_LABEL_LENGTH || /\p{Cc}/u.test(label)) {
    throw new Error(
      `[config] ${key} must be 1 to ${MAX_SSO_LABEL_LENGTH} characters with no control characters.`,
    );
  }
  return label;
}

/**
 * Reads `SSO_<ID>_SCOPES`: scope tokens separated by spaces, which must
 * include `openid`. Unset or blank: {@link DEFAULT_SSO_SCOPES}. Repeated
 * spaces and duplicate tokens are folded.
 */
function readSsoScopes(key: string, raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return DEFAULT_SSO_SCOPES;
  const tokens = [...new Set(trimmed.split(/\s+/))];
  if (!tokens.every((token) => SSO_SCOPE_TOKEN_RE.test(token))) {
    throw new Error(
      `[config] ${key} must be scope names separated by spaces, got "${raw}".`,
    );
  }
  if (!tokens.includes("openid")) {
    throw new Error(`[config] ${key} must include "openid", got "${raw}".`);
  }
  return tokens.join(" ");
}

/**
 * Reads `SSO_<ID>_ALLOWED_DOMAINS`: email domains separated by commas,
 * lower-cased, each a fully qualified domain name (no `@`, no wildcard).
 * Unset or blank: none.
 */
function readSsoAllowedDomains(key: string, raw: string | undefined): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => asciiLowerCase(entry.trim()).replace(/\.$/, ""))
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    if (!isLowerAsciiDomain(entry)) {
      throw new Error(
        `[config] ${key} must be email domains separated by commas (e.g. example.com), got "${entry}".`,
      );
    }
  }
  return [...new Set(entries)];
}

/**
 * The provider ids to read (#224): those listed in `SSO_PROVIDERS` (ids
 * separated by commas), in order, then every preset id not listed whose
 * client id or secret is set. A preset with only one of the two is read
 * too, so the half-configured provider refuses to boot.
 */
function ssoProviderIds(env: Record<string, string | undefined>): string[] {
  const ids = (env["SSO_PROVIDERS"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const presetId of SSO_PROVIDER_PRESETS.keys()) {
    const prefix = ssoEnvPrefix(presetId);
    const hasCredential =
      !isBlank(env[`${prefix}CLIENT_ID`]) || !isBlank(env[`${prefix}CLIENT_SECRET`]);
    if (hasCredential && !ids.includes(presetId)) ids.push(presetId);
  }
  return ids;
}

/**
 * Reads the SSO settings (#224). The providers are the ids of
 * `SSO_PROVIDERS` (each `^[a-z0-9-]{1,32}$`, no duplicates) plus the
 * presets (`google`, `gitlab`) whose credentials are set (see
 * `ssoProviderIds`). Per id, the `SSO_<ID>_*` variables (see
 * `ssoEnvPrefix`):
 *
 * - `CLIENT_ID` and `CLIENT_SECRET` are the switch: with neither set the
 *   provider is skipped (listed in `skipped`, warned about at boot), with
 *   one of the two it refuses to boot (almost always a typo, which a
 *   hidden button would mask).
 * - `ISSUER` (required, except for a preset: its issuer), `LABEL`
 *   (default: the preset's label, else the id), `SCOPES` (default
 *   `openid email profile`), `ALLOWED_DOMAINS` (optional) and `AUTO_LINK`
 *   (strict boolean, default false; `true` needs allowed domains and is
 *   refused for a Microsoft Entra issuer).
 *
 * Two ids with the same issuer are refused: a link is keyed by the
 * issuer (`oidc:<issuer>`), so they would share every link while keeping
 * their own client settings and labels.
 *
 * Strict, in every environment: any malformed value refuses to boot, so a
 * typo cannot silently widen who may sign in. The base URL is checked
 * separately ({@link ssoBaseUrlFrom}): one that cannot carry SSO turns it
 * off with a boot warning instead, as passkeys do. Exported for tests.
 */
export function readSsoSettings(
  env: Record<string, string | undefined> = process.env,
): SsoSettings {
  const baseUrl = ssoBaseUrlFrom(env["APP_BASE_URL"] ?? "");
  const seen = new Set<string>();
  const providers: SsoProviderSettings[] = [];
  const skipped: Array<{ id: string; missing: readonly string[] }> = [];
  for (const id of ssoProviderIds(env)) {
    if (!SSO_PROVIDER_ID_RE.test(id)) {
      throw new Error(
        `[config] SSO_PROVIDERS entries must be 1 to 32 lowercase letters, digits or '-', got "${id}".`,
      );
    }
    if (seen.has(id)) {
      throw new Error(`[config] SSO_PROVIDERS lists "${id}" twice.`);
    }
    seen.add(id);
    const prefix = ssoEnvPrefix(id);
    const clientIdKey = `${prefix}CLIENT_ID`;
    const clientSecretKey = `${prefix}CLIENT_SECRET`;
    if (isBlank(env[clientIdKey]) && isBlank(env[clientSecretKey])) {
      skipped.push({ id, missing: [clientIdKey, clientSecretKey] });
      continue;
    }
    /** Read first: a half-configured provider names its missing variable. */
    const clientId = readSsoClientValue(clientIdKey, env[clientIdKey]);
    const clientSecret = readSsoClientValue(clientSecretKey, env[clientSecretKey]);
    const preset = SSO_PROVIDER_PRESETS.get(id);
    const allowedDomains = readSsoAllowedDomains(
      `${prefix}ALLOWED_DOMAINS`,
      env[`${prefix}ALLOWED_DOMAINS`],
    );
    const autoLink = optionalStrictBoolean(
      `${prefix}AUTO_LINK`,
      false,
      env[`${prefix}AUTO_LINK`],
    );
    if (autoLink && allowedDomains.length === 0) {
      throw new Error(
        `[config] ${prefix}AUTO_LINK=true needs ${prefix}ALLOWED_DOMAINS:\n` +
          "  → Linking by email is only safe for the email domains you control.",
      );
    }
    const issuer = readSsoIssuer(
      `${prefix}ISSUER`,
      env[`${prefix}ISSUER`],
      preset?.issuer,
    );
    const issuerHost = new URL(issuer).hostname;
    if (autoLink && isEntraIssuerHost(issuerHost)) {
      throw new Error(
        `[config] ${prefix}AUTO_LINK=true is not allowed for a Microsoft Entra issuer (${issuerHost}):\n` +
          "  → Entra's email claim is not a verified, immutable value; link identities under Account > Sign-in methods.",
      );
    }
    const sameIssuer = providers.find((provider) => provider.issuer === issuer);
    if (sameIssuer) {
      throw new Error(
        `[config] ${prefix}ISSUER is also the issuer of "${sameIssuer.id}":\n` +
          "  → Configure each identity provider once: its links are keyed by the issuer.",
      );
    }
    providers.push({
      id,
      issuer,
      clientId,
      clientSecret,
      label: readSsoLabel(`${prefix}LABEL`, preset?.label ?? id, env[`${prefix}LABEL`]),
      scopes: readSsoScopes(`${prefix}SCOPES`, env[`${prefix}SCOPES`]),
      allowedDomains,
      autoLink,
    });
  }
  return { providers, skipped, baseUrl };
}
