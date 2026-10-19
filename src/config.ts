import { isIP } from "net";
import { MAX_ADDRESS_LENGTH, isEmailAddress } from "./utils/recipients.ts";
import {
  TWO_FACTOR_POLICIES,
  isTwoFactorPolicy,
  type TwoFactorPolicy,
} from "./modules/users/types/user.types.ts";

/**
 * Reads a required environment variable. Throws at startup if missing
 * so misconfigurations are caught immediately rather than at runtime.
 */
function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `[config] Missing required environment variable: ${key}\n` +
        `  → Copy .env.example to .env and fill in the values.`,
    );
  }
  return value;
}

/**
 * Reads an optional environment variable, falling back to the provided default.
 */
function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/**
 * Reads an optional positive-integer environment variable. Fails at boot
 * on anything else: a bare `parseInt` turns a typo into `NaN`, and a
 * `count > NaN` check is always false, which would silently disable a
 * limit instead of reporting the mistake.
 */
function optionalPositiveInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`[config] ${key} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * Reads an optional whole number that must lie in `[min, max]` (#176).
 * Unset or blank gives `fallback`; anything else (signs, decimals,
 * exponents, hex, out of range) refuses to boot. Exported for tests.
 */
export function optionalBoundedInt(
  key: string,
  fallback: number,
  min: number,
  max: number,
  raw: string | undefined = process.env[key],
): number {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return fallback;
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || value < min || value > max) {
    throw new Error(
      `[config] ${key} must be a whole number from ${min} to ${max}, got "${raw}"`,
    );
  }
  return value;
}

/**
 * Reads an optional boolean flag strictly: `true` or `false`, unset or
 * blank gives `fallback`. Anything else (`1`, `yes`, `TRUE`) refuses to
 * boot, so a typo cannot silently leave a guard off. Exported for tests.
 */
export function optionalStrictBoolean(
  key: string,
  fallback: boolean,
  raw: string | undefined = process.env[key],
): boolean {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return fallback;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  throw new Error(`[config] ${key} must be "true" or "false", got "${raw}"`);
}

/**
 * Reads `MAIL_PUBLIC_IP` (#247, #248): the public IPv4/IPv6 addresses this
 * server sends mail from, comma-separated. Optional: unset, BunMail uses
 * the A/AAAA records of `MAIL_HOSTNAME`. Set it when they differ (NAT, a
 * separate egress IP). Any entry that is not an IP address refuses to
 * boot. Exported for tests.
 */
export function readPublicIps(
  raw: string | undefined = process.env["MAIL_PUBLIC_IP"],
): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    if (isIP(entry) === 0) {
      throw new Error(
        `[config] MAIL_PUBLIC_IP must be IP addresses separated by commas, got "${entry}"`,
      );
    }
  }
  return [...new Set(entries)];
}

/** Allowed log-level values, must match the logger implementation. */
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Deployment environments the app distinguishes. */
const APP_ENVS = ["development", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/**
 * Reads `BUNMAIL_ENV`, narrowing to the union rather than asserting:
 * several guards key off `production` (#133), so a typo silently
 * landing in the relaxed branch would be a security problem.
 */
function readAppEnv(): AppEnv {
  const raw = optionalEnv("BUNMAIL_ENV", "development");
  if (!(APP_ENVS as readonly string[]).includes(raw)) {
    throw new Error(
      `[config] Invalid BUNMAIL_ENV "${raw}", must be one of: ${APP_ENVS.join(", ")}`,
    );
  }
  return raw === "production" ? "production" : "development";
}

/**
 * Reads `LOG_LEVEL` and validates it against the allowed union.
 * Throws at startup with a clear message on a typo so the operator
 * notices immediately rather than silently getting `info`-equivalent behaviour.
 */
function isLogLevel(v: string): v is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(v);
}

function readLogLevel(): LogLevel {
  const raw = optionalEnv("LOG_LEVEL", "info");
  if (!isLogLevel(raw)) {
    throw new Error(
      `[config] Invalid LOG_LEVEL "${raw}", must be one of: ${LOG_LEVELS.join(", ")}`,
    );
  }
  return raw;
}

/**
 * Reads `DKIM_ENCRYPTION_KEY` (32 bytes, base64-encoded) and returns it as
 * a `Buffer`. The key encrypts `domains.dkim_private_key` at rest using
 * AES-256-GCM via `src/utils/crypto.ts`.
 *
 * Required in **both** dev and prod: silently allowing dev to store
 * plaintext is the kind of thing that ships to production by accident.
 * The error message points at `openssl rand -base64 32` so a fresh
 * checkout has a single one-line setup step.
 */
function readDkimEncryptionKey(): Buffer {
  const raw = process.env["DKIM_ENCRYPTION_KEY"];
  if (!raw) {
    throw new Error(
      "[config] Missing required environment variable: DKIM_ENCRYPTION_KEY\n" +
        "  → Generate one with: openssl rand -base64 32\n" +
        "  → Then add it to your .env. The key encrypts DKIM private keys at rest.",
    );
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 32) {
    throw new Error(
      `[config] DKIM_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${decoded.length}).\n` +
        `  → Generate a fresh one with: openssl rand -base64 32`,
    );
  }
  return decoded;
}

/**
 * Dashboard auth env vars removed by account login (#216). A value left
 * in `.env` no longer does anything; `readLegacyAuthEnv` reports which are
 * still set so `src/index.ts` can warn once at boot (this file cannot
 * log: the logger imports config).
 */
const LEGACY_AUTH_ENV = ["DASHBOARD_PASSWORD", "SESSION_SECRET"] as const;

/** Which of `LEGACY_AUTH_ENV` are set to a non-empty value. */
function readLegacyAuthEnv(): string[] {
  return LEGACY_AUTH_ENV.filter((key) => (process.env[key] ?? "") !== "");
}

/**
 * Suffixes that can never be a real sending host: RFC 2606 / 6761
 * reserved names and the placeholders used in `.env.example` and the docs.
 */
const PLACEHOLDER_HOST_SUFFIXES = [
  "example.com",
  "example.net",
  "example.org",
  "yourdomain.com",
  "example",
  "test",
  "invalid",
  "localhost",
  "local",
];

/**
 * Why `hostname` can't be used as the SMTP EHLO name and Message-ID domain,
 * or `null` if it can. Receivers expect a fully qualified name whose A
 * record and the sending IP's PTR match; `localhost`, an IP literal or a
 * placeholder is a strong spam signal. Pure, for tests.
 */
export function mailHostnameProblem(hostname: string): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host === "") return "it is not set";
  if (host === "localhost") return "it is localhost";
  if (isIP(host) !== 0) return "it is an IP address";
  if (!host.includes(".")) return "it is not a fully qualified domain name";
  if (
    host.length > 253 ||
    !host.split(".").every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))
  ) {
    return "it is not a valid hostname";
  }
  if (PLACEHOLDER_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) {
    return "it is a placeholder or reserved name";
  }
  return null;
}

/**
 * Reads `MAIL_HOSTNAME`, the EHLO name and Message-ID domain of outbound
 * mail. Production refuses to start with a value receivers would distrust
 * (#242); development keeps the `localhost` default.
 */
export function readMailHostname(
  env: AppEnv,
  raw: string = optionalEnv("MAIL_HOSTNAME", ""),
): string {
  const problem = mailHostnameProblem(raw);
  if (env === "production" && problem) {
    throw new Error(
      `[config] MAIL_HOSTNAME is not usable in production: ${problem} ("${raw}").\n` +
        "  → Set it to this server's fully qualified hostname (e.g. mail.yourcompany.com),\n" +
        "    whose A record points at the server and which the sending IP's PTR\n" +
        "    (reverse DNS) resolves to. It is used as the SMTP EHLO name and the\n" +
        "    Message-ID domain; `localhost` or a placeholder lands mail in spam.",
    );
  }
  return raw.trim() === "" ? "localhost" : raw.trim();
}

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

/** Default and bounds of `AUDIT_LOG_RETENTION_DAYS` (#221), in days. */
export const DEFAULT_AUDIT_LOG_RETENTION_DAYS = 365;
export const MIN_AUDIT_LOG_RETENTION_DAYS = 30;
export const MAX_AUDIT_LOG_RETENTION_DAYS = 3650;

/**
 * Reads `AUDIT_LOG_RETENTION_DAYS`, how long audit events are kept
 * (#221). Unset or blank: 365. Anything other than a whole number of days
 * from 30 to 3650 refuses to boot, in every environment: a typo must never
 * shorten the security history silently.
 */
export function readAuditLogRetentionDays(
  raw: string | undefined = process.env["AUDIT_LOG_RETENTION_DAYS"],
): number {
  return optionalBoundedInt(
    "AUDIT_LOG_RETENTION_DAYS",
    DEFAULT_AUDIT_LOG_RETENTION_DAYS,
    MIN_AUDIT_LOG_RETENTION_DAYS,
    MAX_AUDIT_LOG_RETENTION_DAYS,
    raw,
  );
}

/** Default and bounds of `WEBHOOKS_MAX_PER_API_KEY` (#258). */
export const DEFAULT_WEBHOOKS_MAX_PER_API_KEY = 10;
export const MIN_WEBHOOKS_MAX_PER_API_KEY = 1;
export const MAX_WEBHOOKS_MAX_PER_API_KEY = 100;

/**
 * Reads `WEBHOOKS_MAX_PER_API_KEY`, how many webhooks one API key may have
 * (#258). Every event fans out to each of a key's subscribed webhooks, so
 * the cap bounds that fan-out. Unset or blank: 10. Anything other than a
 * whole number from 1 to 100 refuses to boot.
 */
export function readWebhooksMaxPerApiKey(
  raw: string | undefined = process.env["WEBHOOKS_MAX_PER_API_KEY"],
): number {
  return optionalBoundedInt(
    "WEBHOOKS_MAX_PER_API_KEY",
    DEFAULT_WEBHOOKS_MAX_PER_API_KEY,
    MIN_WEBHOOKS_MAX_PER_API_KEY,
    MAX_WEBHOOKS_MAX_PER_API_KEY,
    raw,
  );
}

/** Default and bounds of `WEBHOOK_DELIVERY_RETENTION_DAYS` (#258), in days. */
export const DEFAULT_WEBHOOK_DELIVERY_RETENTION_DAYS = 30;
export const MIN_WEBHOOK_DELIVERY_RETENTION_DAYS = 1;
export const MAX_WEBHOOK_DELIVERY_RETENTION_DAYS = 365;

/**
 * Reads `WEBHOOK_DELIVERY_RETENTION_DAYS`, how long finished webhook
 * deliveries (`delivered` and `failed`) are kept (#258). Unset or blank:
 * 30. Anything other than a whole number of days from 1 to 365 refuses to
 * boot: a bare `parseInt` turned a typo into `NaN`, and a `NaN` cutoff
 * silently purged nothing.
 */
export function readWebhookDeliveryRetentionDays(
  raw: string | undefined = process.env["WEBHOOK_DELIVERY_RETENTION_DAYS"],
): number {
  return optionalBoundedInt(
    "WEBHOOK_DELIVERY_RETENTION_DAYS",
    DEFAULT_WEBHOOK_DELIVERY_RETENTION_DAYS,
    MIN_WEBHOOK_DELIVERY_RETENTION_DAYS,
    MAX_WEBHOOK_DELIVERY_RETENTION_DAYS,
    raw,
  );
}

/** Default and bounds of `IDEMPOTENCY_KEY_TTL_HOURS` (#188), in hours. */
export const DEFAULT_IDEMPOTENCY_KEY_TTL_HOURS = 24;
export const MIN_IDEMPOTENCY_KEY_TTL_HOURS = 1;
export const MAX_IDEMPOTENCY_KEY_TTL_HOURS = 168;

/**
 * Reads `IDEMPOTENCY_KEY_TTL_HOURS`, how long an `Idempotency-Key` on the
 * send API is remembered (#188): a retry with the same key inside this
 * window replays the first response, after it the key is reusable. Unset
 * or blank: 24. Anything other than a whole number of hours from 1 to 168
 * refuses to boot.
 */
export function readIdempotencyKeyTtlHours(
  raw: string | undefined = process.env["IDEMPOTENCY_KEY_TTL_HOURS"],
): number {
  return optionalBoundedInt(
    "IDEMPOTENCY_KEY_TTL_HOURS",
    DEFAULT_IDEMPOTENCY_KEY_TTL_HOURS,
    MIN_IDEMPOTENCY_KEY_TTL_HOURS,
    MAX_IDEMPOTENCY_KEY_TTL_HOURS,
    raw,
  );
}

/**
 * Reads `SYSTEM_MAIL_FROM`, the address BunMail's own mail (invitations,
 * #217) is sent from. Trimmed and lower-cased; unset or empty means no
 * system sender, and the dashboard shows invitation links for the inviter
 * to share instead. A malformed value (anything but one bare address, or
 * over 254 characters) refuses to boot in every environment. Whether its
 * domain is registered and DKIM-verified is checked at send time, since
 * domains change at runtime.
 */
export function readSystemMailFrom(
  raw: string = optionalEnv("SYSTEM_MAIL_FROM", ""),
): string | null {
  const email = raw.trim().toLowerCase();
  if (email === "") return null;
  /** The same single-address check as `BUNMAIL_OWNER_EMAIL`. */
  const problem = ownerEmailProblem(email);
  if (problem) {
    throw new Error(
      `[config] SYSTEM_MAIL_FROM is not usable: ${problem}.\n` +
        "  → Set it to one bare address on a domain registered and DKIM-verified\n" +
        "    in BunMail (no name or angle brackets), e.g. noreply@yourcompany.com,\n" +
        "    or leave it unset to share invitation links by hand.",
    );
  }
  return email;
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

/**
 * Central application configuration.
 *
 * Every setting is read from environment variables at import time.
 * Missing required variables cause a clear error on startup.
 * See `.env.example` for the full list with descriptions.
 */
export const config = {
  /** "development", relaxed; "production", strict domain enforcement */
  env: readAppEnv(),

  database: {
    /** PostgreSQL connection URL (required) */
    url: requiredEnv("DATABASE_URL"),
  },

  server: {
    /** HTTP port for the REST API and dashboard */
    port: parseInt(optionalEnv("PORT", "3000"), 10),
    /** Bind address */
    host: optionalEnv("HOST", "0.0.0.0"),
    /**
     * Largest request body accepted, in bytes. Bun rejects anything larger
     * with 413 before reading it; its default is 128 MB, and request bodies
     * are parsed before authentication runs. The largest legitimate body
     * is a send or template with 5 MB of html plus 5 MB of text.
     */
    maxRequestBodyBytes: 12 * 1024 * 1024,
  },

  /**
   * Per-API-key request limit on the REST API: at most `max` requests per
   * `windowSec`, then HTTP 429 with `Retry-After`. In-memory and
   * per-replica, like the dashboard login limiter.
   */
  apiRateLimit: {
    /** Requests allowed per key per window (default 100). */
    max: optionalPositiveInt("API_RATE_LIMIT_MAX", 100),
    /** Window length in seconds (default 60). */
    windowSec: optionalPositiveInt("API_RATE_LIMIT_WINDOW", 60),
  },

  /**
   * Public base URL of this BunMail instance (e.g. "https://mail.example.com"),
   * no trailing slash. Used to build absolute links: the "view in
   * dashboard" link in inbound notifications (#106), and the owner setup
   * link logged on first boot (#215). Optional: when empty, those emails
   * simply omit the link, and the setup link falls back to
   * `http://localhost:PORT`. Trailing slash is stripped so callers can
   * always append "/dashboard/...".
   */
  appBaseUrl: optionalEnv("APP_BASE_URL", "").replace(/\/+$/, ""),

  mail: {
    /** Hostname used in SMTP HELO command and Message-ID header (#242) */
    hostname: readMailHostname(readAppEnv()),

    /** Public sending IPs (`MAIL_PUBLIC_IP`); empty: use the A/AAAA records of `hostname`. */
    publicIps: readPublicIps(),

    /**
     * Max parallel SMTP sessions per destination MX host. Direct-to-MX
     * delivery means strict receivers (Outlook, Yahoo) reject parallel
     * sessions from the same source IP with `421 Too many concurrent
     * SMTP connections`. Default `1` is safe for new self-hosters with
     * cold IP reputation; operators with established reputation can
     * raise it to 2-3. Sends to different MXs are unaffected. (#91)
     */
    mxConcurrency: Math.max(1, parseInt(optionalEnv("MAIL_MX_CONCURRENCY", "1"), 10)),

    /**
     * How long a temporarily failing email keeps being retried, in hours
     * (#180). Retries follow an escalating schedule (5 m, 15 m, 30 m, 1 h,
     * 2 h, then every 4 h); once the next retry would land past this age
     * the email fails for good. RFC 5321 suggests 4 to 5 days.
     */
    retryMaxAgeHours: optionalPositiveInt("MAIL_RETRY_MAX_AGE_HOURS", 48),

    /**
     * Send queue throughput and its bound (#176). Each poll (every
     * `QUEUE_POLL_INTERVAL_MS`, +/-10% jitter, never overlapping the
     * previous one) claims up to `QUEUE_BATCH_SIZE` due emails, but never
     * more than the free slots under `QUEUE_MAX_CONCURRENT_SENDS`, the cap
     * on sends in flight in this process. A slow receiver holds one slot
     * instead of making the queue open ever more connections. Sends that
     * wait for a busy MX (`MAIL_MX_CONCURRENCY`) hold their slot while
     * they wait.
     */
    queueBatchSize: optionalBoundedInt("QUEUE_BATCH_SIZE", 5, 1, 100),
    queuePollIntervalMs: optionalBoundedInt("QUEUE_POLL_INTERVAL_MS", 2000, 250, 60_000),
    queueMaxConcurrentSends: optionalBoundedInt("QUEUE_MAX_CONCURRENT_SENDS", 10, 1, 500),

    /**
     * Allow delivery to MX hosts that resolve to private, loopback or
     * link-local addresses. Off by default: recipient domains are chosen
     * by API callers, so a private MX would let any key aim the server's
     * port-25 connections at its internal network. Set to "true" only to
     * deliver to an internal mail server on purpose.
     */
    allowPrivateMx: optionalEnv("MAIL_ALLOW_PRIVATE_MX", "false") === "true",

    /**
     * Refuse sends whose sender domain has no verified DKIM record (#245).
     * A registered domain whose stored DKIM flag is false is re-verified
     * inline once (a failure is remembered for 5 minutes per domain); if
     * it is still unverified the send is rejected with
     * `SENDER_DOMAIN_UNVERIFIED` (SMTP 550), and an unregistered domain
     * is rejected in every environment. Off by default: the send is
     * queued and the response carries `warnings`. SPF and DMARC only warn.
     */
    requireVerifiedDomain: optionalStrictBoolean("REQUIRE_VERIFIED_DOMAIN", false),
  },

  /** Inbound SMTP server for receiving emails */
  smtp: {
    /** Port for the inbound SMTP server (default 2525) */
    port: parseInt(optionalEnv("SMTP_PORT", "2525"), 10),
    /** Set to "true" to enable the inbound SMTP server */
    enabled: optionalEnv("SMTP_ENABLED", "false") === "true",

    /** Spam protection layers: all enabled by default when SMTP is on */
    spamProtection: {
      /** Check connecting IPs against a DNSBL (e.g. Spamhaus ZEN) */
      dnsblEnabled: optionalEnv("SMTP_DNSBL_ENABLED", "true") === "true",
      /** DNSBL zone to query (default: zen.spamhaus.org) */
      dnsblZone: optionalEnv("SMTP_DNSBL_ZONE", "zen.spamhaus.org"),
      /** Reject mail to domains not registered in BunMail */
      recipientValidationEnabled:
        optionalEnv("SMTP_RECIPIENT_VALIDATION", "true") === "true",
      /** Per-IP SMTP connection rate limiting */
      rateLimitEnabled: optionalEnv("SMTP_RATE_LIMIT_ENABLED", "true") === "true",
      /** Max connections per IP per window */
      rateLimitMax: parseInt(optionalEnv("SMTP_RATE_LIMIT_MAX", "10"), 10),
      /** Rate limit window in seconds */
      rateLimitWindowSec: parseInt(optionalEnv("SMTP_RATE_LIMIT_WINDOW", "60"), 10),
    },
  },

  /**
   * SMTP submission server (#120). A separate, AUTH-**required** SMTP
   * listener that lets any SMTP-capable app (Infisical, Netbird, Dify, a
   * NestJS/Nodemailer backend, …) send *through* BunMail by pointing its
   * SMTP settings here. Distinct from the inbound receiver above: inbound
   * has AUTH disabled and validates recipient domains (an MX receiver);
   * submission authenticates with a `bm_live_` API key and relays to any
   * recipient via the normal outbound pipeline (queue → DKIM → direct-to-MX).
   */
  smtpSubmission: {
    /** Set to "true" to start the SMTP submission server. Off by default. */
    enabled: optionalEnv("SMTP_SUBMISSION_ENABLED", "false") === "true",
    /** Port for the submission server (default 587: the IANA submission port). */
    port: parseInt(optionalEnv("SMTP_SUBMISSION_PORT", "587"), 10),

    /**
     * Per-API-key daily send quota (#123). Counts messages accepted via the
     * submission server per key per UTC day; once a key reaches it, further
     * submissions are rejected with SMTP 452 until the next UTC day. `0`
     * (default) means unlimited. Applies only to the SMTP submission path,
     * not the REST send API.
     */
    dailyQuota: Math.max(
      0,
      parseInt(optionalEnv("SMTP_SUBMISSION_DAILY_QUOTA", "0"), 10),
    ),

    /**
     * Optional TLS material. When both a cert and key path are provided,
     * the server advertises STARTTLS so clients can upgrade the connection
     * before AUTH. When absent, plaintext AUTH is allowed
     * (`allowInsecureAuth`): acceptable only on a trusted network
     * (same host / private Docker network), which is the common
     * self-hosted case. Paths are read from disk at server start.
     */
    tls: {
      certPath: optionalEnv("SMTP_SUBMISSION_TLS_CERT", ""),
      keyPath: optionalEnv("SMTP_SUBMISSION_TLS_KEY", ""),
    },

    /**
     * Allow AUTH over a plaintext (non-TLS) connection (#133). The password
     * is a full-privilege `bm_live_…` key, so plaintext AUTH exposes it to
     * anyone who can sniff the link. Defaults to **false**: set
     * `SMTP_SUBMISSION_ALLOW_INSECURE=true` only when the submission server
     * is reachable solely over a trusted network (same host / private
     * Docker network) and you accept the risk. When TLS is configured
     * (`SMTP_SUBMISSION_TLS_*`), clients STARTTLS before AUTH and this flag
     * is irrelevant. When neither TLS nor this flag is set, the server
     * refuses to start rather than silently accept cleartext credentials.
     */
    allowInsecureAuth: optionalEnv("SMTP_SUBMISSION_ALLOW_INSECURE", "false") === "true",

    /**
     * Per-IP connection rate limiting (sliding window), mirroring the
     * inbound receiver. Blunts abusive connection churn.
     */
    connectionRateLimit: {
      enabled: optionalEnv("SMTP_SUBMISSION_RATE_LIMIT_ENABLED", "true") === "true",
      max: parseInt(optionalEnv("SMTP_SUBMISSION_RATE_LIMIT_MAX", "30"), 10),
      windowSec: parseInt(optionalEnv("SMTP_SUBMISSION_RATE_LIMIT_WINDOW", "60"), 10),
    },

    /**
     * Per-IP **failed-AUTH** throttle. Because the password is a BunMail
     * API key, unbounded failed AUTH attempts would let an attacker
     * brute-force keys. After `maxAttempts` failures within the window an
     * IP is rejected before the key is even checked. Mirrors the dashboard
     * login throttle (#109). A successful AUTH clears the counter.
     */
    authRateLimit: {
      enabled: optionalEnv("SMTP_SUBMISSION_AUTH_RATE_LIMIT_ENABLED", "true") === "true",
      maxAttempts: parseInt(optionalEnv("SMTP_SUBMISSION_AUTH_RATE_LIMIT_MAX", "10"), 10),
      windowSec: parseInt(
        optionalEnv("SMTP_SUBMISSION_AUTH_RATE_LIMIT_WINDOW", "900"),
        10,
      ),
    },
  },

  /**
   * Inbound notification (#106). When an inbound message is accepted by
   * the SMTP receiver for a domain that has a `notify_email` set, BunMail
   * sends a "you have new mail" summary email to that address, signed with
   * the recipient domain's own DKIM key. Per-domain opt-in (set the
   * domain's notify email); these are the instance-wide knobs.
   */
  inboundNotify: {
    /**
     * Master switch. When false, no inbound notifications are sent
     * regardless of any domain's `notify_email`. Default true (the
     * per-domain `notify_email` being null is the real opt-in: this is
     * an operator kill switch).
     */
    enabled: optionalEnv("INBOUND_NOTIFY_ENABLED", "true") === "true",

    /**
     * Local-part of the From address for notification emails. The full
     * From is `<fromLocalPart>@<recipient domain>`, so notifications are
     * sent from the same domain that received the mail and signed with
     * that domain's DKIM key. Default "notifications".
     */
    fromLocalPart: optionalEnv("INBOUND_NOTIFY_FROM_LOCAL", "notifications"),

    /**
     * Include the original subject and a short preview of the body in
     * notifications (#250). Off by default: the notification is signed
     * by the operator's domain, so it carries no inbound content unless
     * asked. When on, the text stays plain and every `http://`,
     * `https://` and `www.` link is replaced. Strict `true`/`false`.
     */
    preview: optionalStrictBoolean("INBOUND_NOTIFY_PREVIEW", false),
  },

  /**
   * Sender of BunMail's own mail: invitation emails (#217). One bare
   * address on a domain registered and DKIM-verified in BunMail; `null`
   * when unset, in which case the dashboard shows each invitation link
   * once for the inviter to share. See `readSystemMailFrom`.
   */
  systemMailFrom: readSystemMailFrom(),

  /**
   * Approximate location of dashboard sessions (#281): off unless
   * `GEOIP_DB_PATH` (offline, preferred) or `GEOIP_PROVIDER` +
   * `GEOIP_API_TOKEN` (online, sends every sign-in IP to the provider) is
   * set. See `readGeoipSettings`.
   */
  geoip: readGeoipSettings(),

  /** Dashboard invitations (#217). */
  invites: {
    /** Days an invitation link stays valid (`INVITE_EXPIRY_DAYS`, default 7, at most 90). */
    expiryDays: readInviteExpiryDays(),
  },

  /** Web dashboard at /dashboard, signed in to with dashboard accounts (#216) */
  dashboard: {
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
     * Brute-force protection for the login form (#109). Failed logins
     * (any reason) are counted per client IP in a sliding window; once
     * `maxAttempts` is reached the login POST returns HTTP 429 until the
     * window expires. A successful login clears the counter. State is
     * in-memory and per-replica (same caveat as the API rate limiter).
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
  },

  /** Log level: debug | info | warn | error, validated at startup */
  logLevel: readLogLevel(),

  /**
   * When true, email addresses in log records are redacted to a
   * privacy-preserving form (`u***@example.com`). Defaults to true in
   * production and false in development so dev logs stay debuggable.
   * Override explicitly with `LOG_REDACT_PII=true|false`.
   */
  logRedactPii:
    optionalEnv(
      "LOG_REDACT_PII",
      optionalEnv("BUNMAIL_ENV", "development") === "production" ? "true" : "false",
    ) === "true",

  /**
   * 32-byte AES-256 key used to encrypt `domains.dkim_private_key` at
   * rest (AES-256-GCM, see `src/utils/crypto.ts`). Read once at startup
   * and reused: never logged. Rotation is documented in `SECURITY.md`.
   */
  dkimEncryptionKey: readDkimEncryptionKey(),

  /** Trash / soft-delete retention */
  trash: {
    /**
     * How many days a soft-deleted email stays in trash before the purge
     * service permanently removes it. Applies to both outbound and inbound
     * emails. Default 7 days.
     */
    retentionDays: parseInt(optionalEnv("TRASH_RETENTION_DAYS", "7"), 10),

    /**
     * How many days an email tombstone (the post-purge audit-trail row,
     * #34) is kept after the original email was hard-deleted. The
     * tombstone preserves identifiers (id, message_id, to, subject,
     * status) so operators can trace late complaints / bounces back to
     * a sent message even after the body has been purged. Default 90
     * days: long enough to cover most receiver feedback windows.
     */
    tombstoneRetentionDays: parseInt(optionalEnv("TOMBSTONE_RETENTION_DAYS", "90"), 10),
  },

  /** Audit log of security-relevant actions (#221). */
  auditLog: {
    /**
     * Days an audit event is kept before the purge worker deletes it
     * (`AUDIT_LOG_RETENTION_DAYS`, default 365). A whole number from 30 to
     * 3650; anything else refuses to boot, so a typo can never shorten the
     * history silently.
     */
    retentionDays: readAuditLogRetentionDays(),
  },

  /** Idempotency keys on `POST /api/v1/emails/send` (#188). */
  idempotency: {
    /**
     * Hours a key is remembered (`IDEMPOTENCY_KEY_TTL_HOURS`, default 24, a
     * whole number from 1 to 168). Within it a retry with the same key and
     * body replays the first response; after it the key is reusable, and
     * the purge worker deletes the expired row.
     */
    keyTtlHours: readIdempotencyKeyTtlHours(),
  },

  /**
   * Webhook delivery queue (#30). Persisted retry loop config:
   * tuned for the realistic consumer-outage profile rather than burst
   * latency. The retry schedule itself (1m / 5m / 15m / 1h / 6h) lives
   * in `webhook-delivery.service.ts` because it's a behavioural
   * contract, not an operator knob.
   */
  webhookDelivery: {
    /**
     * How many days finished deliveries (`delivered` and `failed`) are
     * kept, counted from their last change, before the hourly cleanup
     * deletes them (`WEBHOOK_DELIVERY_RETENTION_DAYS`, default 30, a whole
     * number from 1 to 365, #258). `failed` rows used to be kept forever.
     */
    retentionDays: readWebhookDeliveryRetentionDays(),

    /**
     * Most webhooks one API key may have (`WEBHOOKS_MAX_PER_API_KEY`,
     * default 10, a whole number from 1 to 100, #258). Creating one more
     * is refused with 422 `WEBHOOK_LIMIT_REACHED`; webhooks that already
     * exceed a lowered cap are kept.
     */
    maxPerApiKey: readWebhooksMaxPerApiKey(),

    /**
     * SSRF guard (#128). Webhook URLs must be `https` and must not resolve
     * to a private/loopback/link-local/metadata address. Set
     * `WEBHOOK_ALLOW_INSECURE_HTTP=true` to also permit `http:` targets
     * (e.g. an internal-but-public receiver without TLS): the
     * private-range block still applies either way.
     */
    allowInsecureHttp: optionalEnv("WEBHOOK_ALLOW_INSECURE_HTTP", "false") === "true",
  },
} as const;
