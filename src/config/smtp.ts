import { optionalBoundedInt, optionalEnv, optionalStrictBoolean } from "./env.ts";

/**
 * Default and bounds of `ATTACHMENTS_MAX_TOTAL_MB` (#181), in MB of
 * 1,000,000 bytes. 18 MB of attachments encode to about 24.6 MB of MIME
 * (base64 plus line breaks), which keeps the message under the 25 MB most
 * receivers accept.
 */
export const DEFAULT_ATTACHMENTS_MAX_TOTAL_MB = 5;
export const MIN_ATTACHMENTS_MAX_TOTAL_MB = 1;
export const MAX_ATTACHMENTS_MAX_TOTAL_MB = 18;

/** One MB as `ATTACHMENTS_MAX_TOTAL_MB` counts it. */
export const BYTES_PER_MB = 1_000_000;

/**
 * Reads `ATTACHMENTS_MAX_TOTAL_MB`, the most attachment bytes (decoded)
 * one email may carry, which is also the most one file may have (#181).
 * Unset or blank: 5. Anything other than a whole number from 1 to 18
 * refuses to boot.
 */
export function readAttachmentsMaxTotalMb(
  raw: string | undefined = process.env["ATTACHMENTS_MAX_TOTAL_MB"],
): number {
  return optionalBoundedInt(
    "ATTACHMENTS_MAX_TOTAL_MB",
    DEFAULT_ATTACHMENTS_MAX_TOTAL_MB,
    MIN_ATTACHMENTS_MAX_TOTAL_MB,
    MAX_ATTACHMENTS_MAX_TOTAL_MB,
    raw,
  );
}

/**
 * How the SMTP submission server offers TLS (#349). `implicit`: TLS from
 * the first byte (port 465). `starttls`: plaintext, upgraded by the
 * STARTTLS command (Node only, see {@link readSubmissionTls}). `none`: no
 * certificate, plaintext only.
 */
export type SubmissionTlsMode = "implicit" | "starttls" | "none";

/** The submission server's TLS settings and port, as {@link readSubmissionTls} resolves them. */
export interface SubmissionTlsSettings {
  mode: SubmissionTlsMode;
  /** PEM certificate path, empty in `none` mode. */
  certPath: string;
  /** PEM private-key path, empty in `none` mode. */
  keyPath: string;
  /** Listen port: `SMTP_SUBMISSION_PORT`, else 465 in `implicit` mode and 587 otherwise. */
  port: number;
}

/** The raw environment values {@link readSubmissionTls} reads. */
interface SubmissionTlsEnv {
  mode: string | undefined;
  certPath: string | undefined;
  keyPath: string | undefined;
  port: string | undefined;
}

/**
 * Reads `SMTP_SUBMISSION_TLS_MODE`, `SMTP_SUBMISSION_TLS_CERT`,
 * `SMTP_SUBMISSION_TLS_KEY` and `SMTP_SUBMISSION_PORT` (#349).
 *
 * - The mode is `implicit` or `starttls`; unset or blank, it is `implicit`
 *   when both a cert and a key are set, and `none` without them.
 * - A mode without a cert and key, a cert without a key (or the reverse),
 *   or any other mode value refuses to boot: a typo must never leave the
 *   API keys on a plaintext link.
 * - `starttls` refuses to boot under Bun: Bun cannot upgrade an accepted
 *   socket to TLS on the server side (`new tls.TLSSocket(socket, { isServer:
 *   true })` never handshakes in Bun 1.3.14), so a STARTTLS offer would
 *   never complete and clients could not authenticate at all.
 * - The port defaults to 465 in `implicit` mode and 587 otherwise; a set
 *   port must be a whole number from 1 to 65535.
 *
 * Exported for tests.
 */
export function readSubmissionTls(
  raw: SubmissionTlsEnv = {
    mode: process.env["SMTP_SUBMISSION_TLS_MODE"],
    certPath: process.env["SMTP_SUBMISSION_TLS_CERT"],
    keyPath: process.env["SMTP_SUBMISSION_TLS_KEY"],
    port: process.env["SMTP_SUBMISSION_PORT"],
  },
  onBun: boolean = typeof Bun !== "undefined",
): SubmissionTlsSettings {
  const certPath = raw.certPath?.trim() ?? "";
  const keyPath = raw.keyPath?.trim() ?? "";
  if ((certPath === "") !== (keyPath === "")) {
    throw new Error(
      "[config] SMTP_SUBMISSION_TLS_CERT and SMTP_SUBMISSION_TLS_KEY must be set together:\n" +
        "  one without the other would leave submission without TLS.",
    );
  }
  const hasCertificate = certPath !== "";
  const requested = raw.mode?.trim() ?? "";

  let mode: SubmissionTlsMode;
  if (requested === "") {
    mode = hasCertificate ? "implicit" : "none";
  } else if (requested === "implicit" || requested === "starttls") {
    if (!hasCertificate) {
      throw new Error(
        `[config] SMTP_SUBMISSION_TLS_MODE="${requested}" needs a certificate:\n` +
          "  → Set SMTP_SUBMISSION_TLS_CERT and SMTP_SUBMISSION_TLS_KEY, or leave the mode unset.",
      );
    }
    mode = requested;
  } else {
    throw new Error(
      `[config] SMTP_SUBMISSION_TLS_MODE must be "implicit" or "starttls", got "${raw.mode}"`,
    );
  }

  if (mode === "starttls" && onBun) {
    throw new Error(
      "[config] SMTP_SUBMISSION_TLS_MODE=starttls is not supported on Bun:\n" +
        "  Bun cannot upgrade a connection to TLS on the server side, so a STARTTLS\n" +
        "  handshake would never complete.\n" +
        "  → Use implicit TLS: leave SMTP_SUBMISSION_TLS_MODE unset (or set it to\n" +
        '    "implicit") and point clients at port 465 with "SSL/TLS".',
    );
  }

  const port = optionalBoundedInt(
    "SMTP_SUBMISSION_PORT",
    mode === "implicit" ? 465 : 587,
    1,
    65535,
    raw.port,
  );
  return {
    mode,
    certPath: hasCertificate ? certPath : "",
    keyPath: hasCertificate ? keyPath : "",
    port,
  };
}

/**
 * The largest REST body without attachments: 5 MB of html plus 5 MB of
 * text (the send DTO's caps), with room for the other fields.
 */
const BASE_REQUEST_BODY_BYTES = 12 * 1024 * 1024;

/** JSON room for up to 10 attachment objects: names, types, ids, quotes. */
const ATTACHMENT_JSON_OVERHEAD_BYTES = 64 * 1024;

/** Length of the standard (padded) base64 of `bytes` bytes. */
export function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/**
 * The HTTP body limit for an attachment budget (#181): the largest body
 * without attachments, plus the base64 of the whole budget, plus the JSON
 * around it. Bun refuses a larger body with 413 before reading or parsing
 * it. About 19.3 MB with the default 5 MB, 36.6 MB at 18.
 */
export function maxRequestBodyBytesFor(attachmentsMaxTotalBytes: number): number {
  return (
    BASE_REQUEST_BODY_BYTES +
    base64Length(attachmentsMaxTotalBytes) +
    ATTACHMENT_JSON_OVERHEAD_BYTES
  );
}

/** The `config.server` section: the HTTP listener of the REST API and dashboard. */
export function buildServerConfig() {
  return {
    /** HTTP port for the REST API and dashboard */
    port: parseInt(optionalEnv("PORT", "3000"), 10),
    /** Bind address */
    host: optionalEnv("HOST", "0.0.0.0"),
    /**
     * Largest request body accepted, in bytes. Bun rejects anything larger
     * with 413 before reading it; its default is 128 MB, and request bodies
     * are parsed before authentication runs. The largest legitimate body
     * is a send with 5 MB of html, 5 MB of text and the base64 of the
     * whole attachment budget (`ATTACHMENTS_MAX_TOTAL_MB`, #181), see
     * {@link maxRequestBodyBytesFor}.
     */
    maxRequestBodyBytes: maxRequestBodyBytesFor(
      readAttachmentsMaxTotalMb() * BYTES_PER_MB,
    ),
  } as const;
}

/** Attachments on sends (#181), REST and SMTP submission. */
export function buildAttachmentsConfig() {
  return {
    /**
     * Most attachment bytes (decoded) one email may carry, which is also
     * the most one file may have (`ATTACHMENTS_MAX_TOTAL_MB`, default 5,
     * a whole number from 1 to 18 MB of 1,000,000 bytes).
     */
    maxTotalBytes: readAttachmentsMaxTotalMb() * BYTES_PER_MB,
  } as const;
}

/* ─── Per-IP SMTP limits (#185) ─── */

/** Most connections per IP per window an SMTP connection limit accepts. */
export const MAX_SMTP_CONNECTIONS_PER_WINDOW = 100_000;

/** Most failed AUTHs per IP per window the submission throttle accepts. */
export const MAX_SMTP_AUTH_ATTEMPTS = 10_000;

/** Longest window, in seconds, of any per-IP SMTP limit (one day). */
export const MAX_SMTP_LIMIT_WINDOW_SEC = 86_400;

/** One per-IP limit: at most `max` events per `windowSec`. */
export interface SmtpLimitNumbers {
  max: number;
  windowSec: number;
}

/**
 * Reads one per-IP SMTP limit, `<prefix>_MAX` (1 to `maxCeiling`) and
 * `<prefix>_WINDOW` (seconds, 1 to 86400). Unset or blank gives the
 * default; anything else (0, a sign, a decimal, not a number, out of
 * range) refuses to boot: a bare `parseInt` let 0 refuse every
 * connection or AUTH, and a typo (`NaN`) turn the limit off silently.
 */
function readSmtpLimit(
  prefix: string,
  defaults: SmtpLimitNumbers,
  maxCeiling: number,
  env: { max: string | undefined; window: string | undefined },
): SmtpLimitNumbers {
  return {
    max: optionalBoundedInt(`${prefix}_MAX`, defaults.max, 1, maxCeiling, env.max),
    windowSec: optionalBoundedInt(
      `${prefix}_WINDOW`,
      defaults.windowSec,
      1,
      MAX_SMTP_LIMIT_WINDOW_SEC,
      env.window,
    ),
  };
}

/**
 * The inbound receiver's per-IP connection limit: `SMTP_RATE_LIMIT_MAX`
 * (default 10, 1 to 100000) per `SMTP_RATE_LIMIT_WINDOW` (default 60 s,
 * 1 to 86400). Exported for tests.
 */
export function readInboundConnectionLimit(
  env: { max: string | undefined; window: string | undefined } = {
    max: process.env["SMTP_RATE_LIMIT_MAX"],
    window: process.env["SMTP_RATE_LIMIT_WINDOW"],
  },
): SmtpLimitNumbers {
  return readSmtpLimit(
    "SMTP_RATE_LIMIT",
    { max: 10, windowSec: 60 },
    MAX_SMTP_CONNECTIONS_PER_WINDOW,
    env,
  );
}

/**
 * The submission server's per-IP connection limit:
 * `SMTP_SUBMISSION_RATE_LIMIT_MAX` (default 30, 1 to 100000) per
 * `SMTP_SUBMISSION_RATE_LIMIT_WINDOW` (default 60 s, 1 to 86400).
 * Exported for tests.
 */
export function readSubmissionConnectionLimit(
  env: { max: string | undefined; window: string | undefined } = {
    max: process.env["SMTP_SUBMISSION_RATE_LIMIT_MAX"],
    window: process.env["SMTP_SUBMISSION_RATE_LIMIT_WINDOW"],
  },
): SmtpLimitNumbers {
  return readSmtpLimit(
    "SMTP_SUBMISSION_RATE_LIMIT",
    { max: 30, windowSec: 60 },
    MAX_SMTP_CONNECTIONS_PER_WINDOW,
    env,
  );
}

/**
 * The submission server's failed-AUTH throttle (API-key guessing):
 * `SMTP_SUBMISSION_AUTH_RATE_LIMIT_MAX` (default 10, 1 to 10000) per
 * `SMTP_SUBMISSION_AUTH_RATE_LIMIT_WINDOW` (default 900 s, 1 to 86400).
 * Exported for tests.
 */
export function readSubmissionAuthLimit(
  env: { max: string | undefined; window: string | undefined } = {
    max: process.env["SMTP_SUBMISSION_AUTH_RATE_LIMIT_MAX"],
    window: process.env["SMTP_SUBMISSION_AUTH_RATE_LIMIT_WINDOW"],
  },
): { maxAttempts: number; windowSec: number } {
  const { max, windowSec } = readSmtpLimit(
    "SMTP_SUBMISSION_AUTH_RATE_LIMIT",
    { max: 10, windowSec: 900 },
    MAX_SMTP_AUTH_ATTEMPTS,
    env,
  );
  return { maxAttempts: max, windowSec };
}

/** The on/off switches of the per-IP SMTP limits. */
export const SMTP_LIMIT_SWITCHES = [
  "SMTP_RATE_LIMIT_ENABLED",
  "SMTP_SUBMISSION_RATE_LIMIT_ENABLED",
  "SMTP_SUBMISSION_AUTH_RATE_LIMIT_ENABLED",
] as const;

/** One of {@link SMTP_LIMIT_SWITCHES}. */
export type SmtpLimitSwitch = (typeof SMTP_LIMIT_SWITCHES)[number];

/**
 * Reads a per-IP SMTP limit switch strictly (#185): `true` or `false`,
 * unset or blank for on. Anything else (`TRUE`, `1`, `yes`, `off`)
 * refuses to boot: a bare `=== "true"` turned a typo into "off", which
 * for the failed-AUTH throttle silently removed the API-key brute-force
 * guard. Exported for tests.
 */
export function readSmtpLimitSwitch(
  name: SmtpLimitSwitch,
  raw: string | undefined = process.env[name],
): boolean {
  return optionalStrictBoolean(name, true, raw);
}

/** Inbound SMTP server for receiving emails */
export function buildSmtpConfig() {
  const connectionLimit = readInboundConnectionLimit();
  return {
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
      rateLimitEnabled: readSmtpLimitSwitch("SMTP_RATE_LIMIT_ENABLED"),
      /** Max connections per IP per window (1 to 100000, #185) */
      rateLimitMax: connectionLimit.max,
      /** Rate limit window in seconds (1 to 86400, #185) */
      rateLimitWindowSec: connectionLimit.windowSec,
    },
  } as const;
}

/**
 * SMTP submission server (#120). A separate, AUTH-**required** SMTP
 * listener that lets any SMTP-capable app (Infisical, Netbird, Dify, a
 * NestJS/Nodemailer backend, …) send *through* BunMail by pointing its
 * SMTP settings here. Distinct from the inbound receiver above: inbound
 * has AUTH disabled and validates recipient domains (an MX receiver);
 * submission authenticates with a `bm_live_` API key and relays to any
 * recipient via the normal outbound pipeline (queue → DKIM → direct-to-MX).
 */
export function buildSmtpSubmissionConfig(submissionTls: SubmissionTlsSettings) {
  return {
    /** Set to "true" to start the SMTP submission server. Off by default. */
    enabled: optionalEnv("SMTP_SUBMISSION_ENABLED", "false") === "true",
    /**
     * Port for the submission server (#349): `SMTP_SUBMISSION_PORT`, else
     * 465 with implicit TLS and 587 (the IANA submission port) otherwise.
     */
    port: submissionTls.port,

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
     * TLS (#349). With a cert and key the mode defaults to `implicit`: TLS
     * from the first byte, terminated by the runtime's own TLS server.
     * `starttls` exists for Node only (Bun refuses it at boot). Without a
     * cert the mode is `none`, and plaintext AUTH needs
     * `SMTP_SUBMISSION_ALLOW_INSECURE=true` (#133). Paths are read from
     * disk at server start. See `readSubmissionTls`.
     */
    tls: {
      mode: submissionTls.mode,
      certPath: submissionTls.certPath,
      keyPath: submissionTls.keyPath,
    },

    /**
     * Allow AUTH over a plaintext (non-TLS) connection (#133). The password
     * is a full-privilege `bm_live_…` key, so plaintext AUTH exposes it to
     * anyone who can sniff the link. Defaults to **false**: set
     * `SMTP_SUBMISSION_ALLOW_INSECURE=true` only when the submission server
     * is reachable solely over a trusted network (same host / private
     * Docker network) and you accept the risk. When TLS is configured
     * (`SMTP_SUBMISSION_TLS_*`), AUTH is only accepted over TLS and this
     * flag is ignored (#349). When neither TLS nor this flag is set, the server
     * refuses to start rather than silently accept cleartext credentials.
     */
    allowInsecureAuth: optionalEnv("SMTP_SUBMISSION_ALLOW_INSECURE", "false") === "true",

    /**
     * Per-IP connection rate limiting (fixed window), mirroring the
     * inbound receiver. Blunts abusive connection churn.
     */
    connectionRateLimit: {
      enabled: readSmtpLimitSwitch("SMTP_SUBMISSION_RATE_LIMIT_ENABLED"),
      /** 1 to 100000 per 1 to 86400 seconds; anything else refuses to boot (#185). */
      ...readSubmissionConnectionLimit(),
    },

    /**
     * Per-IP **failed-AUTH** throttle. Because the password is a BunMail
     * API key, unbounded failed AUTH attempts would let an attacker
     * brute-force keys. After `maxAttempts` failures within the window an
     * IP is rejected before the key is even checked. Mirrors the dashboard
     * login throttle (#109). Only failures are counted, and they expire
     * only with their window: a successful AUTH does not clear them (#190).
     */
    authRateLimit: {
      enabled: readSmtpLimitSwitch("SMTP_SUBMISSION_AUTH_RATE_LIMIT_ENABLED"),
      /** 1 to 10000 per 1 to 86400 seconds; anything else refuses to boot (#185). */
      ...readSubmissionAuthLimit(),
    },
  } as const;
}

/**
 * Inbound notification (#106). When an inbound message is accepted by
 * the SMTP receiver for a domain that has a `notify_email` set, BunMail
 * sends a "you have new mail" summary email to that address, signed with
 * the recipient domain's own DKIM key. Per-domain opt-in (set the
 * domain's notify email); these are the instance-wide knobs.
 */
export function buildInboundNotifyConfig() {
  return {
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
  } as const;
}
