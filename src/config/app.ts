import { optionalEnv, optionalPositiveInt } from "./env.ts";

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
export function readAppEnv(): AppEnv {
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

export function readLogLevel(): LogLevel {
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
export function readDkimEncryptionKey(): Buffer {
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
export function readLegacyAuthEnv(): string[] {
  return LEGACY_AUTH_ENV.filter((key) => (process.env[key] ?? "") !== "");
}

/**
 * Per-API-key request limit on the REST API: at most `max` requests per
 * `windowSec`, then HTTP 429 with `Retry-After`. Shared by every
 * replica when `REDIS_URL` is set (#185), else in memory per replica.
 */
export function buildApiRateLimitConfig() {
  return {
    /** Requests allowed per key per window (default 100). */
    max: optionalPositiveInt("API_RATE_LIMIT_MAX", 100),
    /** Window length in seconds (default 60). */
    windowSec: optionalPositiveInt("API_RATE_LIMIT_WINDOW", 60),
  } as const;
}
