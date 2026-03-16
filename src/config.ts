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
    /** Empty = dashboard disabled */
    password: optionalEnv("DASHBOARD_PASSWORD", ""),
    /** HMAC secret for session cookies; random UUID by default (resets on restart) */
    sessionSecret: optionalEnv("SESSION_SECRET", randomUUID()),
  },

  /** Log level: debug | info | warn | error */
  logLevel: optionalEnv("LOG_LEVEL", "info"),
} as const;
