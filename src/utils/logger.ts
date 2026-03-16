import { config } from "../config.ts";

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

/**
 * Formats a log message as a structured JSON string (production)
 * or a colored, human-readable string (development).
 */
function formatLog(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
): string {
  /** Production: structured JSON for log aggregators (Grafana, Datadog, etc.) */
  if (config.env === "production") {
    return JSON.stringify({
      level,
      message,
      timestamp: new Date().toISOString(),
      ...data,
    });
  }

  /** Development: colored terminal output */
  const timestamp = new Date().toISOString();
  const color = COLORS[level];
  const emoji = EMOJIS[level];
  const tag = `${color}${level.toUpperCase()}${RESET}`;
  const MAGENTA = "\x1b[35m";
  const meta =
    data && Object.keys(data).length > 0
      ? ` ${MAGENTA}${JSON.stringify(data)}${RESET}`
      : "";

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
