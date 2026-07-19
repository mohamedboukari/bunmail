import { readFileSync } from "fs";
import { SMTPServer } from "smtp-server";
import type {
  SMTPServerAuthentication,
  SMTPServerSession,
  SMTPServerAuthenticationResponse,
  SMTPServerDataStream,
} from "smtp-server";
import { simpleParser } from "mailparser";
import type { AddressObject } from "mailparser";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { hashApiKey } from "../../../utils/crypto.ts";
import { findByHash } from "../../api-keys/services/api-key.service.ts";
import { createEmail } from "../../emails/services/email.service.ts";
import { SuppressedRecipientError } from "../../suppressions/errors.ts";
import type { SendEmailInput } from "../../emails/types/email.types.ts";
import { buildSubmissionInput } from "../message-mapper.ts";
import { recordOutcome, getAcceptedToday } from "./usage.service.ts";

/**
 * The SMTP submission server (#120) lets any SMTP-capable app (Infisical,
 * Netbird, Dify, a NestJS/Nodemailer backend, …) send *through* BunMail by
 * pointing its SMTP settings here and authenticating with a `bm_live_` API
 * key as the password. Accepted messages are handed to the normal outbound
 * pipeline via `createEmail` (queue → DKIM → direct-to-MX).
 *
 * This is deliberately distinct from the inbound receiver
 * (`src/modules/inbound/services/smtp-receiver.service.ts`): inbound has
 * AUTH disabled and validates recipient domains (it's an MX receiver);
 * submission *requires* AUTH and relays to any recipient (the open-relay
 * guard here is authentication, not recipient-domain validation).
 */

/**
 * Maximum size (bytes) of a submitted message — advertised via the SIZE
 * ESMTP extension and enforced inside `onData`. Matches the inbound cap.
 */
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/**
 * Maximum recipients accepted per transaction. A submission client that
 * blows past this is almost certainly misbehaving; legitimate
 * transactional mail rarely exceeds a handful.
 */
const MAX_RECIPIENTS_PER_TRANSACTION = 50;

/** The running server instance, or null when stopped. */
let server: SMTPServer | null = null;

/** Interval handle for the periodic rate-limit map cleanup. */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/* ─── Per-IP sliding-window counters ─── */

interface WindowEntry {
  /** Number of events in the current window. */
  count: number;
  /** Timestamp (ms) when the current window started. */
  windowStart: number;
}

/** IP → connection-count state (connection rate limiting). */
const connectionMap = new Map<string, WindowEntry>();
/** IP → failed-AUTH-count state (key brute-force throttle). */
const authFailureMap = new Map<string, WindowEntry>();

/**
 * Generic sliding-window check-and-increment. Returns true once `max`
 * events have accumulated for `ip` within `windowSec`. A fresh window
 * starts on the first event or after the previous one expired.
 */
function hitWindow(
  map: Map<string, WindowEntry>,
  ip: string,
  max: number,
  windowSec: number,
): boolean {
  const windowMs = windowSec * 1000;
  const now = Date.now();
  const entry = map.get(ip);

  if (!entry || now - entry.windowStart >= windowMs) {
    map.set(ip, { count: 1, windowStart: now });
    return 1 > max;
  }

  entry.count += 1;
  return entry.count > max;
}

/**
 * Read-only check of whether an IP is currently over the failed-AUTH
 * limit, without recording a new failure. Used to reject before the key
 * lookup so a locked-out IP can't keep probing keys.
 */
function isAuthLockedOut(ip: string): boolean {
  const { maxAttempts, windowSec } = config.smtpSubmission.authRateLimit;
  const entry = authFailureMap.get(ip);
  if (!entry || Date.now() - entry.windowStart >= windowSec * 1000) return false;
  return entry.count >= maxAttempts;
}

/** Record a failed AUTH for an IP (starts/extends its window). */
function recordAuthFailure(ip: string): void {
  const { windowSec } = config.smtpSubmission.authRateLimit;
  hitWindow(authFailureMap, ip, Number.POSITIVE_INFINITY, windowSec);
}

/* ─── Message parsing helpers ─── */

/**
 * Flattens a mailparser address field (single object or array) into a flat
 * list of raw addresses. Shaping (dedup, To/Cc/BCC assignment) is handled
 * by the pure `message-mapper` module.
 */
function extractAddresses(field: AddressObject | AddressObject[] | undefined): string[] {
  if (!field) return [];
  const objs = Array.isArray(field) ? field : [field];
  const out: string[] = [];
  for (const obj of objs) {
    for (const a of obj.value ?? []) {
      const addr = a.address?.trim();
      if (addr) out.push(addr);
    }
  }
  return out;
}

/**
 * Maps an SMTP error to a response with a specific SMTP status code so the
 * submitting client sees a real rejection instead of a generic failure.
 */
function smtpError(message: string, responseCode: number): Error {
  const err = new Error(message) as Error & { responseCode: number };
  err.responseCode = responseCode;
  return err;
}

/* ─── Server lifecycle ─── */

/**
 * Starts the SMTP submission server on the configured port. Requires
 * AUTH; authenticates the password against the API-keys table. STARTTLS is
 * advertised when a cert/key pair is configured; plaintext AUTH is allowed
 * (`allowInsecureAuth`) so the common same-host / private-network setup
 * works with zero TLS configuration.
 */
export function start(portOverride?: number): void {
  const { tls, connectionRateLimit } = config.smtpSubmission;
  /** `portOverride` lets integration tests bind an isolated port. */
  const port = portOverride ?? config.smtpSubmission.port;

  /**
   * Load TLS material if both a cert and key path are configured. When
   * present, smtp-server advertises STARTTLS backed by this cert. A bad
   * path fails loudly at start rather than silently downgrading security.
   */
  let tlsOptions: { key: Buffer; cert: Buffer } | undefined;
  if (tls.certPath && tls.keyPath) {
    try {
      tlsOptions = {
        cert: readFileSync(tls.certPath),
        key: readFileSync(tls.keyPath),
      };
    } catch (error) {
      throw new Error(
        `[smtp-submission] Failed to read TLS cert/key from ` +
          `SMTP_SUBMISSION_TLS_CERT="${tls.certPath}" / ` +
          `SMTP_SUBMISSION_TLS_KEY="${tls.keyPath}"`,
        { cause: error },
      );
    }
  }

  server = new SMTPServer({
    ...tlsOptions,
    secure: false,
    /** AUTH is mandatory — this is the open-relay guard for submission. */
    authOptional: false,
    /** Only password-based mechanisms; the password carries the API key. */
    authMethods: ["PLAIN", "LOGIN"],
    /**
     * Allow AUTH over a plaintext connection. Acceptable on a trusted
     * network (same host / private Docker network) — the common
     * self-hosted case. Operators exposing this beyond a trusted network
     * should configure SMTP_SUBMISSION_TLS_* and front it appropriately.
     */
    allowInsecureAuth: true,
    size: MAX_MESSAGE_BYTES,

    /**
     * Per-IP connection rate limiting (instant, no I/O). Runs before AUTH
     * to blunt connection churn. SMTP 421 = temporary rejection.
     */
    onConnect(session: SMTPServerSession, callback: (err?: Error) => void) {
      const ip = session.remoteAddress;
      if (
        connectionRateLimit.enabled &&
        hitWindow(
          connectionMap,
          ip,
          connectionRateLimit.max,
          connectionRateLimit.windowSec,
        )
      ) {
        logger.warn("SMTP submission connection rate limited", { ip });
        return callback(smtpError("Too many connections, try again later", 421));
      }
      callback();
    },

    /**
     * Authenticate the client. The password (falling back to the username
     * for clients that only fill one field) is treated as a `bm_live_` API
     * key: SHA-256 hashed and looked up. A per-IP failed-AUTH throttle
     * blunts key brute-forcing; a success clears the counter.
     */
    onAuth(
      auth: SMTPServerAuthentication,
      session: SMTPServerSession,
      callback: (
        err: Error | null | undefined,
        response?: SMTPServerAuthenticationResponse,
      ) => void,
    ) {
      const ip = session.remoteAddress;
      const { authRateLimit } = config.smtpSubmission;

      if (authRateLimit.enabled && isAuthLockedOut(ip)) {
        logger.warn("SMTP submission AUTH rate limited", { ip });
        /** 454 = temporary auth failure; client should back off. */
        return callback(smtpError("Too many failed authentication attempts", 454));
      }

      /** Password is the API key; some clients only set the username. */
      const candidate = auth.password || auth.username || "";
      if (!candidate) {
        if (authRateLimit.enabled) recordAuthFailure(ip);
        return callback(smtpError("Authentication credentials required", 535));
      }

      findByHash(hashApiKey(candidate))
        .then((apiKey) => {
          if (!apiKey || !apiKey.isActive) {
            if (authRateLimit.enabled) recordAuthFailure(ip);
            logger.warn("SMTP submission AUTH failed — invalid or inactive key", { ip });
            return callback(smtpError("Invalid API key", 535));
          }
          /** Success — clear the failure counter and stash the key id. */
          authFailureMap.delete(ip);
          logger.info("SMTP submission client authenticated", {
            ip,
            apiKeyId: apiKey.id,
          });
          callback(null, { user: apiKey.id });
        })
        .catch((error) => {
          logger.error("SMTP submission AUTH lookup failed", {
            ip,
            error: error instanceof Error ? error.message : String(error),
          });
          /** 451 = local error; don't leak details, don't count as a guess. */
          callback(smtpError("Temporary authentication failure", 451));
        });
    },

    /**
     * Cap recipients per transaction (open-relay-fanout defence). Unlike
     * the inbound receiver we do NOT validate the recipient domain —
     * submission legitimately sends to arbitrary external recipients; AUTH
     * is what prevents abuse.
     */
    onRcptTo(
      _address: { address: string },
      session: SMTPServerSession,
      callback: (err?: Error) => void,
    ) {
      const acceptedSoFar = session.envelope.rcptTo?.length ?? 0;
      if (acceptedSoFar >= MAX_RECIPIENTS_PER_TRANSACTION) {
        logger.warn("SMTP submission RCPT TO rejected — too many recipients", {
          acceptedSoFar,
          ip: session.remoteAddress,
        });
        return callback(
          smtpError(
            `Too many recipients (max ${MAX_RECIPIENTS_PER_TRANSACTION} per transaction)`,
            452,
          ),
        );
      }
      callback();
    },

    /**
     * Parse the submitted message and enqueue it via the outbound
     * pipeline, attributed to the authenticated API key.
     */
    onData(
      stream: SMTPServerDataStream,
      session: SMTPServerSession,
      callback: (err?: Error) => void,
    ) {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let aborted = false;

      stream.on("data", (chunk: Buffer) => {
        if (aborted) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_MESSAGE_BYTES) {
          aborted = true;
          logger.warn("SMTP submission DATA rejected — message exceeds size cap", {
            ip: session.remoteAddress,
            totalBytes,
            cap: MAX_MESSAGE_BYTES,
          });
          chunks.length = 0;
          stream.unpipe();
          stream.resume();
          callback(smtpError("Message size exceeds limit", 552));
          return;
        }
        chunks.push(chunk);
      });

      stream.on("end", async () => {
        if (aborted) return;

        /** onAuth stashed the API key id here; guard defensively. */
        const apiKeyId = session.user;
        if (!apiKeyId) {
          logger.error("SMTP submission DATA without an authenticated session");
          callback(smtpError("Authentication required", 530));
          return;
        }

        try {
          /**
           * Per-key daily quota (#123). Checked before the send so an
           * over-quota key never queues. `452` is temporary — the quota
           * window resets at the next UTC day, so the client should retry
           * later rather than treat it as a permanent failure.
           */
          const { dailyQuota } = config.smtpSubmission;
          if (dailyQuota > 0) {
            const usedToday = await getAcceptedToday(apiKeyId);
            if (usedToday >= dailyQuota) {
              logger.warn("SMTP submission rejected — daily quota exceeded", {
                apiKeyId,
                usedToday,
                dailyQuota,
              });
              await recordOutcome(apiKeyId, "rejected");
              callback(
                smtpError(
                  `Daily send quota of ${dailyQuota} reached for this API key; resets at 00:00 UTC`,
                  452,
                ),
              );
              return;
            }
          }

          const rawMessage = Buffer.concat(chunks).toString("utf-8");
          const parsed = await simpleParser(rawMessage);

          const envelopeFrom =
            session.envelope.mailFrom && typeof session.envelope.mailFrom === "object"
              ? session.envelope.mailFrom.address
              : undefined;

          /** Delegate all shaping (sender resolution, BCC merge, To fallback). */
          const input: SendEmailInput = buildSubmissionInput({
            fromHeader: parsed.from?.value?.[0]?.address,
            envelopeFrom,
            toHeader: extractAddresses(parsed.to),
            ccHeader: extractAddresses(parsed.cc),
            envelopeRecipients: (session.envelope.rcptTo ?? []).map((r) => r.address),
            subject: parsed.subject ?? "",
            html: typeof parsed.html === "string" ? parsed.html : undefined,
            text: typeof parsed.text === "string" ? parsed.text : undefined,
          });

          const email = await createEmail(input, apiKeyId);
          await recordOutcome(apiKeyId, "accepted");

          logger.info("SMTP submission accepted — email queued", {
            id: email.id,
            apiKeyId,
            from: redactEmail(input.from),
            to: redactEmail(input.to),
          });

          callback();
        } catch (error) {
          /** Post-auth rejection — count it against the key's daily usage. */
          await recordOutcome(apiKeyId, "rejected").catch(() => {});
          if (error instanceof SuppressedRecipientError) {
            logger.warn("SMTP submission rejected — recipient suppressed", {
              apiKeyId,
              suppressionId: error.suppressionId,
            });
            callback(smtpError(error.message, 550));
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          logger.warn("SMTP submission rejected", { apiKeyId, error: message });
          /** Sender-domain / validation errors from createEmail → 550. */
          callback(smtpError(message, 550));
        }
      });
    },
  });

  server.listen(port, () => {
    logger.info("SMTP submission server started", {
      port,
      tls: tlsOptions ? "STARTTLS available" : "plaintext (allowInsecureAuth)",
    });
  });

  server.on("error", (err: Error) => {
    logger.error("SMTP submission server error", { error: err.message });
  });

  /** Periodic sweep of expired rate-limit entries (every 5 minutes). */
  cleanupInterval = setInterval(
    () => {
      const now = Date.now();
      const connMs = connectionRateLimit.windowSec * 1000;
      const authMs = config.smtpSubmission.authRateLimit.windowSec * 1000;
      for (const [ip, entry] of connectionMap) {
        if (now - entry.windowStart >= connMs) connectionMap.delete(ip);
      }
      for (const [ip, entry] of authFailureMap) {
        if (now - entry.windowStart >= authMs) authFailureMap.delete(ip);
      }
    },
    5 * 60 * 1000,
  );
}

/** Stops the SMTP submission server gracefully (called on shutdown). */
export function stop(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  if (server) {
    server.close(() => {
      logger.info("SMTP submission server stopped");
    });
    server = null;
  }
}
