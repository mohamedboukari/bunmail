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

  mail: {
    /** Hostname used in SMTP HELO command and Message-ID header */
    hostname: optionalEnv("MAIL_HOSTNAME", "localhost"),
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
