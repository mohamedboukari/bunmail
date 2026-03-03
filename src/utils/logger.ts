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

function formatLog(level: LogLevel, message: string, data?: Record<string, unknown>): string {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  return JSON.stringify(entry);
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
