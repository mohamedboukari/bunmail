import { config } from "../config.ts";
import { getLogContext } from "./log-context.ts";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  const current = LOG_LEVELS[config.logLevel as LogLevel] ?? LOG_LEVELS.info;
  return LOG_LEVELS[level] >= current;
}

/** ANSI color codes for terminal output */
const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m", // gray
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
};

/** Emoji prefix per log level */
const EMOJIS: Record<LogLevel, string> = {
  debug: "🔍",
  info: "✅",
  warn: "⚠️",
  error: "❌",
};

/** ANSI reset code */
const RESET = "\x1b[0m";

/** What a redacted value is replaced with. */
const REDACTED = "[REDACTED]";

/**
 * Key names whose values are secrets (#284), compared after lower-casing
 * and dropping everything but letters, so `api_key`, `apiKey` and
 * `X-Api-Key` match alike. A key is sensitive when it equals one of these
 * or ends with one (`sessionToken`, `newPassword`, `dkimPrivateKey`), so
 * identifiers such as `apiKeyId`, `sessionId` or `tokenCount` stay
 * readable. A bare `key` is not on the list: too generic (dedup keys,
 * lookup keys) to hide by name.
 */
const SENSITIVE_KEYS = [
  "password",
  "passwd",
  "secret",
  "token",
  "tokenhash",
  "secrethash",
  "privatekey",
  "authorization",
  "cookie",
  "setcookie",
  "apikey",
] as const;

/** Deepest nesting the redactor walks; deeper values are replaced whole. */
const REDACT_MAX_DEPTH = 6;

/** True when `key` names a secret (see {@link SENSITIVE_KEYS}). */
function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  return SENSITIVE_KEYS.some((name) => normalized === name || normalized.endsWith(name));
}

/**
 * Central safety net (#284): returns `value` with every secret-named field
 * replaced by `[REDACTED]`, at any depth, in plain objects and arrays.
 * Other values (strings, numbers, dates, errors) pass through unchanged.
 * Call sites still decide what to log; this only stops a secret that slips
 * into a log call from reaching the output. Exported for tests.
 */
export function redactSecrets(value: unknown, depth: number = 0): unknown {
  if (Array.isArray(value)) {
    if (depth >= REDACT_MAX_DEPTH) return REDACTED;
    return value.map((item) => redactSecrets(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    if (depth >= REDACT_MAX_DEPTH) return REDACTED;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactSecrets(item, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * The fields of one log line: the current log context (request, job or
 * SMTP session IDs, #284) first, then the call's own data, with secrets
 * redacted.
 */
function lineFields(data?: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...getLogContext(), ...data };
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(merged)) {
    fields[key] = isSensitiveKey(key) ? REDACTED : redactSecrets(value, 1);
  }
  return fields;
}

/**
 * Formats a log message as a structured JSON string (production)
 * or a colored, human-readable string (development). Every line carries
 * the current log context and has its secrets redacted (#284).
 */
function formatLog(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
): string {
  const fields = lineFields(data);
  /** Production: structured JSON for log aggregators (Grafana, Datadog, etc.) */
  if (config.env === "production") {
    return JSON.stringify({
      level,
      message,
      timestamp: new Date().toISOString(),
      ...fields,
    });
  }

  /** Development: colored terminal output */
  const timestamp = new Date().toISOString();
  const color = COLORS[level];
  const emoji = EMOJIS[level];
  const tag = `${color}${level.toUpperCase()}${RESET}`;
  const MAGENTA = "\x1b[35m";
  const meta =
    Object.keys(fields).length > 0 ? ` ${MAGENTA}${JSON.stringify(fields)}${RESET}` : "";

  return `${MAGENTA}${timestamp}${RESET} ${emoji} ${tag} ${message}${meta}`;
}

/* eslint-disable no-console -- This IS the logger; console is the intended output */
export const logger = {
  debug(message: string, data?: Record<string, unknown>) {
    if (shouldLog("debug")) console.debug(formatLog("debug", message, data));
  },
  info(message: string, data?: Record<string, unknown>) {
    if (shouldLog("info")) console.info(formatLog("info", message, data));
  },
  warn(message: string, data?: Record<string, unknown>) {
    if (shouldLog("warn")) console.warn(formatLog("warn", message, data));
  },
  error(message: string, data?: Record<string, unknown>) {
    if (shouldLog("error")) console.error(formatLog("error", message, data));
  },
};
/* eslint-enable no-console */
