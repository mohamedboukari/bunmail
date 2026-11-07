/*
 * Assembles `config` from `src/config/<area>.ts`; builders run in key order, so every
 * reader keeps its order. `@public` marks re-exports only tests use (knip skips test/).
 */
import { optionalEnv, requiredEnv } from "./config/env.ts";
import {
  buildApiRateLimitConfig,
  readAppEnv,
  readDkimEncryptionKey,
  readLogLevel,
} from "./config/app.ts";
import {
  buildMailConfig,
  buildSendingIpDnsblConfig,
  buildSuppressionsConfig,
  readSystemMailFrom,
} from "./config/mail.ts";
import {
  buildDashboardConfig,
  buildInvitesConfig,
  readGeoipSettings,
} from "./config/auth.ts";
import {
  buildAuditLogConfig,
  buildDomainReverifyConfig,
  buildIdempotencyConfig,
  buildTrashConfig,
  buildWebhookDeliveryConfig,
} from "./config/retention.ts";
import {
  buildAttachmentsConfig,
  buildInboundNotifyConfig,
  buildServerConfig,
  buildSmtpConfig,
  buildSmtpSubmissionConfig,
  readSubmissionTls,
} from "./config/smtp.ts";
import { readMetricsToken, readTracingSettings } from "./config/observability.ts";
import { readRedisUrl } from "./config/storage.ts";
import { readSsoSettings } from "./config/sso.ts";

export { optionalBoundedInt, optionalStrictBoolean } from "./config/env.ts";
/** @public */
export type { AppEnv, LogLevel } from "./config/app.ts";
/** @public */
export {
  type IpFamily,
  MAX_MX_RATE_PER_MIN,
  MIN_MX_RATE_PER_MIN,
  mailHostnameProblem,
  readIpFamily,
  readMailHostname,
  readMxRatePerMin,
  readPublicIps,
  readSendingIpDnsblCheck,
  readSuppressionsSharedHard,
  readSystemMailFrom,
} from "./config/mail.ts";
export {
  type GeoipSettings,
  MAX_INVITE_EXPIRY_DAYS,
  ownerEmailProblem,
  readGeoipSettings,
  readInviteExpiryDays,
  readLoginRateLimitNumbers,
  readOwnerEmail,
  readRequire2fa,
} from "./config/auth.ts";
/** @public */
export {
  DEFAULT_AUDIT_LOG_RETENTION_DAYS,
  DEFAULT_DOMAIN_REVERIFY_INTERVAL_HOURS,
  DEFAULT_IDEMPOTENCY_KEY_TTL_HOURS,
  DEFAULT_WEBHOOK_DELIVERY_RETENTION_DAYS,
  DEFAULT_WEBHOOKS_MAX_PER_API_KEY,
  MAX_AUDIT_LOG_RETENTION_DAYS,
  MAX_DOMAIN_REVERIFY_INTERVAL_HOURS,
  MAX_IDEMPOTENCY_KEY_TTL_HOURS,
  MAX_WEBHOOK_DELIVERY_RETENTION_DAYS,
  MAX_WEBHOOKS_MAX_PER_API_KEY,
  MIN_AUDIT_LOG_RETENTION_DAYS,
  MIN_DOMAIN_REVERIFY_INTERVAL_HOURS,
  MIN_IDEMPOTENCY_KEY_TTL_HOURS,
  MIN_WEBHOOK_DELIVERY_RETENTION_DAYS,
  MIN_WEBHOOKS_MAX_PER_API_KEY,
  readAuditLogRetentionDays,
  readDomainReverifyIntervalHours,
  readIdempotencyKeyTtlHours,
  readWebhookDeliveryRetentionDays,
  readWebhooksMaxPerApiKey,
} from "./config/retention.ts";
/** @public */
export {
  type SubmissionTlsMode,
  type SubmissionTlsSettings,
  BYTES_PER_MB,
  DEFAULT_ATTACHMENTS_MAX_TOTAL_MB,
  MAX_ATTACHMENTS_MAX_TOTAL_MB,
  MAX_SMTP_AUTH_ATTEMPTS,
  MAX_SMTP_CONNECTIONS_PER_WINDOW,
  MAX_SMTP_LIMIT_WINDOW_SEC,
  MIN_ATTACHMENTS_MAX_TOTAL_MB,
  base64Length,
  maxRequestBodyBytesFor,
  readAttachmentsMaxTotalMb,
  readInboundConnectionLimit,
  readSubmissionAuthLimit,
  readSmtpLimitSwitch,
  readSubmissionConnectionLimit,
  readSubmissionTls,
  SMTP_LIMIT_SWITCHES,
} from "./config/smtp.ts";
export * from "./config/observability.ts";
export * from "./config/storage.ts";
export * from "./config/sso.ts";

/** The submission server's TLS settings and port, read once at boot (#349). */
const submissionTls = readSubmissionTls();

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

  metrics: {
    /** Bearer token for `GET /metrics` (#362); `null` turns the endpoint off. */
    token: readMetricsToken(),
  },

  redis: {
    /**
     * `REDIS_URL` (#185): shared state for several replicas; `null` keeps
     * it in process memory. Carries the password: never logged.
     */
    url: readRedisUrl(),
  },
  /**
   * OpenTelemetry tracing (#363): off unless an OTLP endpoint is set (or
   * `OTEL_TRACES_EXPORTER=otlp`). See `readTracingSettings`.
   */
  tracing: readTracingSettings(),

  /** HTTP listener; see {@link buildServerConfig}. */
  server: buildServerConfig(),

  /** Attachments on sends (#181), REST and SMTP submission; see {@link buildAttachmentsConfig}. */
  attachments: buildAttachmentsConfig(),

  /** Per-API-key REST request limit; see {@link buildApiRateLimitConfig}. */
  apiRateLimit: buildApiRateLimitConfig(),

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

  /** Outbound delivery and the send queue; see {@link buildMailConfig}. */
  mail: buildMailConfig(),

  /** Inbound SMTP server for receiving emails; see {@link buildSmtpConfig}. */
  smtp: buildSmtpConfig(),

  /** SMTP submission server (#120); see {@link buildSmtpSubmissionConfig}. */
  smtpSubmission: buildSmtpSubmissionConfig(submissionTls),

  /** Inbound notification (#106); see {@link buildInboundNotifyConfig}. */
  inboundNotify: buildInboundNotifyConfig(),

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

  /**
   * OpenID Connect single sign-on (#224): the providers from
   * `SSO_PROVIDERS` (and the presets whose credentials are set), those
   * skipped for lack of credentials, and the base URL their redirect URIs
   * use. Off when no provider is configured, or when `APP_BASE_URL` is not `https://` (or
   * loopback `http://`). See `readSsoSettings`.
   */
  sso: readSsoSettings(),

  /** Dashboard invitations (#217); see {@link buildInvitesConfig}. */
  invites: buildInvitesConfig(),

  /** Web dashboard at /dashboard (#216); see {@link buildDashboardConfig}. */
  dashboard: buildDashboardConfig(),

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

  /** Trash / soft-delete retention; see {@link buildTrashConfig}. */
  trash: buildTrashConfig(),

  /** The suppression list's send gate (#250); see {@link buildSuppressionsConfig}. */
  suppressions: buildSuppressionsConfig(),

  /** Scheduled DNS re-verification (#250); see {@link buildDomainReverifyConfig}. */
  domainReverify: buildDomainReverifyConfig(),

  /** Daily DNSBL self-check of the sending IPs (#250); see {@link buildSendingIpDnsblConfig}. */
  sendingIpDnsbl: buildSendingIpDnsblConfig(),

  /** Audit log retention (#221); see {@link buildAuditLogConfig}. */
  auditLog: buildAuditLogConfig(),

  /** Idempotency keys on the send API (#188); see {@link buildIdempotencyConfig}. */
  idempotency: buildIdempotencyConfig(),

  /** Webhook delivery queue (#30); see {@link buildWebhookDeliveryConfig}. */
  webhookDelivery: buildWebhookDeliveryConfig(),
} as const;
