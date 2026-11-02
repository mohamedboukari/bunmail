import { MAX_ADDRESS_LENGTH, isEmailAddress } from "../utils/recipients.ts";
import {
  TWO_FACTOR_POLICIES,
  isTwoFactorPolicy,
  type TwoFactorPolicy,
} from "../modules/users/types/user.types.ts";
import { readAppEnv, readLegacyAuthEnv, type AppEnv } from "./app.ts";
import { optionalBoundedInt, optionalEnv } from "./env.ts";

/**
 * Why `raw` can't be used as `BUNMAIL_OWNER_EMAIL`, or `null` if it can
 * (#215). Checks the trimmed, lower-cased value, which is what gets
 * stored. Uses the recipient parser's address check so the codebase has a
 * single address regex. Pure, for tests.
 */
export function ownerEmailProblem(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email === "") return "it is not set";
  if (email.length > MAX_ADDRESS_LENGTH) {
    return `it is longer than ${MAX_ADDRESS_LENGTH} characters`;
  }
  if (!isEmailAddress(email)) return "it is not a valid email address";
  return null;
}

/**
 * Reads `BUNMAIL_OWNER_EMAIL`, the address of the single dashboard owner
 * account (#215), trimmed and lower-cased so it satisfies the
 * `users.email = lower(email)` check and a case-only edit is not a
 * mismatch.
 *
 * - Unset in production: refuses to boot. This is the production
 *   dashboard guard since account login (#216) replaced the shared
 *   password: a deploy cannot come up without an owner who can claim
 *   and sign in to the dashboard.
 * - Unset in development: `null`; `src/index.ts` warns and skips the owner
 *   bootstrap (this file cannot log: the logger imports config).
 * - Set but malformed, or over 254 characters: refuses to boot in every
 *   environment, because an explicit value with a typo is a mistake to
 *   report, not to ignore.
 */
export function readOwnerEmail(
  env: AppEnv,
  raw: string = optionalEnv("BUNMAIL_OWNER_EMAIL", ""),
): string | null {
  const email = raw.trim().toLowerCase();
  if (email === "") {
    if (env === "production") {
      throw new Error(
        "[config] BUNMAIL_OWNER_EMAIL must be set when BUNMAIL_ENV=production.\n" +
          "  → It is the email of the dashboard owner account. On first boot\n" +
          "    BunMail creates that account and logs a one-time setup link\n" +
          "    (`Owner setup link`) to claim it. Set it in your .env, e.g.\n" +
          "    BUNMAIL_OWNER_EMAIL=you@yourcompany.com",
      );
    }
    return null;
  }
  const problem = ownerEmailProblem(email);
  if (problem) {
    throw new Error(
      `[config] BUNMAIL_OWNER_EMAIL is not usable: ${problem}.\n` +
        "  → Set it to the dashboard owner's email address (one address,\n" +
        "    no name or angle brackets), e.g. you@yourcompany.com",
    );
  }
  return email;
}

/** Lifetime of an invitation link when `INVITE_EXPIRY_DAYS` is unset (#217). */
const DEFAULT_INVITE_EXPIRY_DAYS = 7;

/**
 * Longest invitation lifetime accepted (#217). A pending link is a live
 * credential for a new account, so a typo such as `700` must not keep one
 * open for two years; it also keeps the expiry date arithmetic in range.
 */
export const MAX_INVITE_EXPIRY_DAYS = 90;

/**
 * Reads `INVITE_EXPIRY_DAYS`, how many days an invitation link stays
 * valid (#217). Unset or empty: 7. Anything other than a whole number
 * from 1 to {@link MAX_INVITE_EXPIRY_DAYS} refuses to boot, in every
 * environment: a typo must not silently fall back to the default.
 */
export function readInviteExpiryDays(
  raw: string = optionalEnv("INVITE_EXPIRY_DAYS", ""),
): number {
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_INVITE_EXPIRY_DAYS;
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || value < 1 || value > MAX_INVITE_EXPIRY_DAYS) {
    throw new Error(
      `[config] INVITE_EXPIRY_DAYS must be a whole number of days from 1 to ${MAX_INVITE_EXPIRY_DAYS}, got "${raw}"`,
    );
  }
  return value;
}

/**
 * Reads `REQUIRE_2FA` (#220): who must set up two-factor authentication
 * before using the dashboard. `none` (unset or empty, the default)
 * requires it of nobody, so upgrading never locks an account out;
 * `owner` requires it of the owner; `admin` of admins and the owner.
 * Case and surrounding spaces are ignored. Anything else refuses to boot
 * in every environment: a typo must not silently leave the policy off.
 */
export function readRequire2fa(
  raw: string = optionalEnv("REQUIRE_2FA", ""),
): TwoFactorPolicy {
  const value = raw.trim().toLowerCase();
  if (value === "") return "none";
  if (!isTwoFactorPolicy(value)) {
    throw new Error(
      `[config] Invalid REQUIRE_2FA "${raw}", must be one of: ${TWO_FACTOR_POLICIES.join(", ")}`,
    );
  }
  return value;
}

/**
 * Reads `DASHBOARD_LOGIN_RATE_LIMIT_MAX` (a whole number from 1 to 100,
 * default 5) and `DASHBOARD_LOGIN_RATE_LIMIT_WINDOW` (seconds, 60 to
 * 86400, default 900). Anything else (not a number, 0, a sign, a
 * decimal, an absurd value) refuses to boot (#220): these numbers budget
 * the login and the password checks of the ownership transfer, the
 * password change and the 2FA enrolment start, and a `NaN` used to turn
 * the login budget off silently. Exported for tests.
 */
export function readLoginRateLimitNumbers(
  env: { max: string | undefined; window: string | undefined } = {
    max: process.env["DASHBOARD_LOGIN_RATE_LIMIT_MAX"],
    window: process.env["DASHBOARD_LOGIN_RATE_LIMIT_WINDOW"],
  },
): { maxAttempts: number; windowSec: number } {
  return {
    maxAttempts: optionalBoundedInt("DASHBOARD_LOGIN_RATE_LIMIT_MAX", 5, 1, 100, env.max),
    windowSec: optionalBoundedInt(
      "DASHBOARD_LOGIN_RATE_LIMIT_WINDOW",
      900,
      60,
      86_400,
      env.window,
    ),
  };
}

/** Online GeoIP providers BunMail can ask (#281). Opt-in only. */
const GEOIP_PROVIDERS = ["ipinfo"] as const;
type GeoipProvider = (typeof GEOIP_PROVIDERS)[number];

/** Narrows a configured provider name to the supported ones. */
function isGeoipProvider(value: string): value is GeoipProvider {
  return (GEOIP_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Where the approximate location of a session's IP comes from (#281):
 * nowhere (`off`, the default), an offline `.mmdb` file, or an online
 * provider that receives every sign-in IP.
 */
export type GeoipSettings =
  | { source: "off" }
  | { source: "mmdb"; dbPath: string }
  | { source: "ipinfo"; token: string };

/** The raw GeoIP environment variables, injectable for tests. */
interface GeoipEnv {
  dbPath: string | undefined;
  provider: string | undefined;
  token: string | undefined;
}

/**
 * Reads the GeoIP settings (#281): `GEOIP_DB_PATH` (an offline DB-IP Lite
 * or GeoLite2 `.mmdb` file), else `GEOIP_PROVIDER` with `GEOIP_API_TOKEN`
 * (online, opt-in), else off. Unset and blank mean unset. Strict, in every
 * environment: an unknown provider, a provider without a token, a token
 * without a provider, or a token with characters a token never has
 * refuses to boot, so a typo cannot silently leave location off or send
 * a malformed token. The provider is validated even when the file wins.
 * Exported for tests.
 */
export function readGeoipSettings(
  env: GeoipEnv = {
    dbPath: process.env["GEOIP_DB_PATH"],
    provider: process.env["GEOIP_PROVIDER"],
    token: process.env["GEOIP_API_TOKEN"],
  },
): GeoipSettings {
  const dbPath = env.dbPath?.trim() ?? "";
  const provider = env.provider?.trim().toLowerCase() ?? "";
  const token = env.token?.trim() ?? "";

  if (provider === "" && token !== "") {
    throw new Error(
      "[config] GEOIP_API_TOKEN is set but GEOIP_PROVIDER is not.\n" +
        `  → Set GEOIP_PROVIDER to one of: ${GEOIP_PROVIDERS.join(", ")}, or remove the token.`,
    );
  }
  let online: GeoipSettings = { source: "off" };
  if (provider !== "") {
    if (!isGeoipProvider(provider)) {
      throw new Error(
        `[config] Invalid GEOIP_PROVIDER "${env.provider}", must be one of: ${GEOIP_PROVIDERS.join(", ")}`,
      );
    }
    if (token === "") {
      throw new Error(
        `[config] GEOIP_PROVIDER=${provider} needs GEOIP_API_TOKEN (the provider's access token).`,
      );
    }
    /** Goes into a URL query: letters, digits, `-` and `_` only. Never echoed. */
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(token)) {
      throw new Error(
        "[config] GEOIP_API_TOKEN must be 1 to 128 letters, digits, '-' or '_'.",
      );
    }
    online = { source: provider, token };
  }

  if (dbPath !== "") return { source: "mmdb", dbPath };
  return online;
}

/** Dashboard invitations (#217). */
export function buildInvitesConfig() {
  return {
    /** Days an invitation link stays valid (`INVITE_EXPIRY_DAYS`, default 7, at most 90). */
    expiryDays: readInviteExpiryDays(),
  } as const;
}

/** Web dashboard at /dashboard, signed in to with dashboard accounts (#216) */
export function buildDashboardConfig() {
  return {
    /**
     * Legacy dashboard auth env vars (`DASHBOARD_PASSWORD`,
     * `SESSION_SECRET`) that are still set although #216 removed them.
     * Only read by `src/index.ts`, which logs one warning at boot.
     */
    legacyAuthEnv: readLegacyAuthEnv(),

    /**
     * Email of the single dashboard owner account (#215), lower-cased.
     * Required in production; `null` in development when unset, which
     * skips the owner bootstrap. See `readOwnerEmail`.
     */
    ownerEmail: readOwnerEmail(readAppEnv()),

    /**
     * Who must have two-factor authentication (#220): `none` (default),
     * `owner`, or `admin` (admins and the owner). An account in scope
     * without a second factor can open only its Two-factor page until it
     * enrols. See `readRequire2fa`.
     */
    require2fa: readRequire2fa(),

    /**
     * Number of trusted reverse-proxy hops in front of BunMail, used to
     * resolve the real client IP for login rate limiting (#109). `0` (the
     * default) means don't trust `X-Forwarded-For` at all: use the raw
     * socket address, which is spoof-proof and correct when BunMail is
     * directly exposed. `N >= 1` takes the `N`-th `X-Forwarded-For` entry
     * from the right (the address your trusted proxy observed); counting
     * from the right is the spoof-resistant approach (the leftmost entry is
     * attacker-controlled). Set to `1` behind a single nginx/Caddy/Cloudflare.
     */
    trustedProxyHops: Math.max(
      0,
      parseInt(optionalEnv("DASHBOARD_TRUSTED_PROXY_HOPS", "0"), 10),
    ),

    /**
     * Brute-force protection for the login form (#109). Every attempt is
     * counted per client IP in a fixed window, before the password check;
     * once `maxAttempts` is reached the login POST returns HTTP 429 until
     * the window expires. A successful login gives back only its own
     * attempt on the IP's counter (#256), so earlier failures stay until
     * the window ends. Shared by every replica when `REDIS_URL` is set
     * (#185), else in memory per replica.
     */
    loginRateLimit: {
      /** Master switch: set to "false" to disable login throttling. */
      enabled: optionalEnv("DASHBOARD_LOGIN_RATE_LIMIT_ENABLED", "true") === "true",
      /**
       * Failed attempts allowed per IP per window before lockout, and the
       * window in seconds (default 5 per 900 = 15 minutes). Strict bounds,
       * see `readLoginRateLimitNumbers`.
       */
      ...readLoginRateLimitNumbers(),
    },
  } as const;
}
