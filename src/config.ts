import { randomUUID } from "crypto";

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  database: {
    url: requiredEnv("DATABASE_URL"),
  },
  server: {
    port: parseInt(optionalEnv("PORT", "3000"), 10),
    host: optionalEnv("HOST", "0.0.0.0"),
  },
  mail: {
    hostname: optionalEnv("MAIL_HOSTNAME", "localhost"),
  },
  /** Dashboard settings — password-protected web UI */
  dashboard: {
    /** Empty string = dashboard disabled (shows "Dashboard disabled" page) */
    password: optionalEnv("DASHBOARD_PASSWORD", ""),
    /** Secret used to sign session cookies — defaults to random UUID (sessions reset on restart) */
    sessionSecret: optionalEnv("SESSION_SECRET", randomUUID()),
  },
  logLevel: optionalEnv("LOG_LEVEL", "info"),
} as const;
