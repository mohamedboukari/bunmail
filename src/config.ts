import { randomUUID } from "crypto";

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

/** Allowed log-level values — must match the logger implementation. */
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Reads `LOG_LEVEL` and validates it against the allowed union.
 * Throws at startup with a clear message on a typo so the operator
 * notices immediately rather than silently getting `info`-equivalent behaviour.
 */
function readLogLevel(): LogLevel {
  const raw = optionalEnv("LOG_LEVEL", "info");
  if (!(LOG_LEVELS as readonly string[]).includes(raw)) {
    throw new Error(
      `[config] Invalid LOG_LEVEL "${raw}" — must be one of: ${LOG_LEVELS.join(", ")}`,
    );
  }
  return raw as LogLevel;
}

/**
 * Reads `DKIM_ENCRYPTION_KEY` (32 bytes, base64-encoded) and returns it as
 * a `Buffer`. The key encrypts `domains.dkim_private_key` at rest using
 * AES-256-GCM via `src/utils/crypto.ts`.
 *
 * Required in **both** dev and prod — silently allowing dev to store
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
 * Reads `DASHBOARD_PASSWORD` and refuses to boot in production with an empty
 * value. The dashboard exposes unscoped read/write across all API keys, so a
 * production instance with no password is a tenant-isolation incident waiting
 * to happen. In development the empty default still disables the dashboard.
 */
function readDashboardPassword(env: "development" | "production"): string {
  const password = optionalEnv("DASHBOARD_PASSWORD", "");
  if (env === "production" && password === "") {
    throw new Error(
      "[config] DASHBOARD_PASSWORD must be set when BUNMAIL_ENV=production.\n" +
        "  → The dashboard reads/writes across all API keys; an empty\n" +
        "    password leaves it disabled but the routes still mount. Set a\n" +
        "    strong value in your .env (or unset BUNMAIL_ENV for dev).",
    );
  }
  return password;
}

/**
 * Central application configuration.
 *
 * Every setting is read from environment variables at import time.
 * Missing required variables cause a clear error on startup.
 * See `.env.example` for the full list with descriptions.
 */
export const config = {
  /** "development" — relaxed; "production" — strict domain enforcement */
  env: optionalEnv("BUNMAIL_ENV", "development") as "development" | "production",

  database: {
    /** PostgreSQL connection URL (required) */
    url: requiredEnv("DATABASE_URL"),
  },

  server: {
    /** HTTP port for the REST API and dashboard */
    port: parseInt(optionalEnv("PORT", "3000"), 10),
    /** Bind address */
    host: optionalEnv("HOST", "0.0.0.0"),
  },

  /**
   * Public base URL of this BunMail instance (e.g. "https://mail.example.com"),
   * no trailing slash. Used to build absolute links in outbound system mail —
   * currently the "view in dashboard" link in inbound notifications (#106).
   * Optional: when empty, those emails simply omit the link. Trailing slash
   * is stripped so callers can always append "/dashboard/...".
   */
  appBaseUrl: optionalEnv("APP_BASE_URL", "").replace(/\/+$/, ""),

  mail: {
    /** Hostname used in SMTP HELO command and Message-ID header */
    hostname: optionalEnv("MAIL_HOSTNAME", "localhost"),

    /**
     * Max parallel SMTP sessions per destination MX host. Direct-to-MX
     * delivery means strict receivers (Outlook, Yahoo) reject parallel
     * sessions from the same source IP with `421 Too many concurrent
     * SMTP connections`. Default `1` is safe for new self-hosters with
     * cold IP reputation; operators with established reputation can
     * raise it to 2-3. Sends to different MXs are unaffected. (#91)
     */
    mxConcurrency: Math.max(1, parseInt(optionalEnv("MAIL_MX_CONCURRENCY", "1"), 10)),
  },

  /** Inbound SMTP server for receiving emails */
  smtp: {
    /** Port for the inbound SMTP server (default 2525) */
    port: parseInt(optionalEnv("SMTP_PORT", "2525"), 10),
    /** Set to "true" to enable the inbound SMTP server */
    enabled: optionalEnv("SMTP_ENABLED", "false") === "true",

    /** Spam protection layers — all enabled by default when SMTP is on */
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
    /** Port for the submission server (default 587 — the IANA submission port). */
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
     * (`allowInsecureAuth`) — acceptable only on a trusted network
     * (same host / private Docker network), which is the common
     * self-hosted case. Paths are read from disk at server start.
     */
    tls: {
      certPath: optionalEnv("SMTP_SUBMISSION_TLS_CERT", ""),
      keyPath: optionalEnv("SMTP_SUBMISSION_TLS_KEY", ""),
    },

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
     * per-domain `notify_email` being null is the real opt-in — this is
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
  },

  /** Password-protected web dashboard at /dashboard */
  dashboard: {
    /**
     * Empty = dashboard disabled. In production an empty password causes
     * `readDashboardPassword` to throw; see the helper for the rationale.
     */
    password: readDashboardPassword(
      optionalEnv("BUNMAIL_ENV", "development") as "development" | "production",
    ),
    /** HMAC secret for session cookies; random UUID by default (resets on restart) */
    sessionSecret: optionalEnv("SESSION_SECRET", randomUUID()),

    /**
     * Number of trusted reverse-proxy hops in front of BunMail, used to
     * resolve the real client IP for login rate limiting (#109). `0` (the
     * default) means don't trust `X-Forwarded-For` at all — use the raw
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
     * Brute-force protection for the login form (#109). Failed password
     * attempts are counted per client IP in a sliding window; once
     * `maxAttempts` is reached the login POST returns HTTP 429 until the
     * window expires. A successful login clears the counter. State is
     * in-memory and per-replica (same caveat as the API rate limiter).
     */
    loginRateLimit: {
      /** Master switch — set to "false" to disable login throttling. */
      enabled: optionalEnv("DASHBOARD_LOGIN_RATE_LIMIT_ENABLED", "true") === "true",
      /** Failed attempts allowed per IP per window before lockout. */
      maxAttempts: parseInt(optionalEnv("DASHBOARD_LOGIN_RATE_LIMIT_MAX", "5"), 10),
      /** Lockout window in seconds (default 900 = 15 minutes). */
      windowSec: parseInt(optionalEnv("DASHBOARD_LOGIN_RATE_LIMIT_WINDOW", "900"), 10),
    },
  },

  /** Log level: debug | info | warn | error — validated at startup */
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
   * and reused — never logged. Rotation is documented in `SECURITY.md`.
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
     * days — long enough to cover most receiver feedback windows.
     */
    tombstoneRetentionDays: parseInt(optionalEnv("TOMBSTONE_RETENTION_DAYS", "90"), 10),
  },

  /**
   * Webhook delivery queue (#30). Persisted retry loop config —
   * tuned for the realistic consumer-outage profile rather than burst
   * latency. The retry schedule itself (1m / 5m / 15m / 1h / 6h) lives
   * in `webhook-delivery.service.ts` because it's a behavioural
   * contract, not an operator knob.
   */
  webhookDelivery: {
    /**
     * How many days `delivered` rows are retained before the cleanup
     * task deletes them. `failed` rows are kept indefinitely for
     * forensics — operators want to answer "did this event ever land?"
     * months after the fact.
     */
    retentionDays: parseInt(optionalEnv("WEBHOOK_DELIVERY_RETENTION_DAYS", "30"), 10),
  },
} as const;
