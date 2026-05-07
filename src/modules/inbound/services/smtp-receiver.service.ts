import { resolve4 } from "dns/promises";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { db } from "../../../db/index.ts";
import { inboundEmails } from "../models/inbound-email.schema.ts";
import { generateId } from "../../../utils/id.ts";
import { dispatchEvent } from "../../webhooks/services/webhook-dispatch.service.ts";
import { domainExistsByName } from "../../domains/services/domain.service.ts";
import { parseBounce } from "../../bounces/services/bounce-parser.service.ts";
import { handleParsedBounce } from "../../bounces/services/bounce-handler.service.ts";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";

/**
 * Maximum size (bytes) of any single inbound message — RFC 5321 SIZE
 * extension value advertised on connect, and the upper bound enforced
 * inside `onData`. 10 MB matches typical receiving-MTA defaults.
 */
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/**
 * Maximum number of recipients accepted per SMTP transaction. Without
 * a cap a single connection can RCPT-bomb us into using the server as
 * a fan-out relay; legitimate transactional inbound rarely exceeds 5.
 */
const MAX_RECIPIENTS_PER_TRANSACTION = 50;

/**
 * Permissive RFC-5321-ish address validator — rejects obviously broken
 * envelopes (`MAIL FROM:<>` is allowed for bounces, see `onMailFrom`).
 * We don't enforce full RFC 5321 here because real-world senders are
 * varied and a strict regex would drop legitimate mail.
 */
const BASIC_ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Reference to the running SMTP server instance */
let server: SMTPServer | null = null;

/** Interval handle for rate limit map cleanup */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/* ─── Per-IP SMTP connection rate limiting ─── */

/** Tracks connection count and window start per IP */
interface SmtpRateLimitEntry {
  /** Number of connections in the current window */
  count: number;
  /** Timestamp (ms) when the current window started */
  windowStart: number;
}

/** In-memory map of IP → rate limit state */
const rateLimitMap = new Map<string, SmtpRateLimitEntry>();

/**
 * Checks and increments the per-IP SMTP connection counter.
 * Returns true if the IP has exceeded the configured limit.
 *
 * Uses a sliding window identical to the HTTP rate limiter pattern
 * in src/middleware/rate-limit.ts.
 *
 * @param ip - The connecting client's IP address
 */
function isRateLimited(ip: string): boolean {
  const { rateLimitMax, rateLimitWindowSec } = config.smtp.spamProtection;
  const windowMs = rateLimitWindowSec * 1000;
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  /** New IP or expired window — start fresh */
  if (!entry || now - entry.windowStart >= windowMs) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return false;
  }

  entry.count += 1;
  return entry.count > rateLimitMax;
}

/* ─── DNSBL (DNS-based blackhole list) check ─── */

/**
 * Checks an IPv4 address against a DNSBL zone (e.g. Spamhaus ZEN).
 *
 * Algorithm: reverse the IP octets → query `<reversed>.<zone>`.
 * If the DNS lookup returns any A records, the IP is listed.
 * A NOTFOUND / timeout means the IP is clean.
 *
 * Skips private, loopback, and IPv6 addresses (not indexed by most DNSBLs).
 *
 * @param ip   - The connecting client's IP address
 * @param zone - The DNSBL zone to query (e.g. "zen.spamhaus.org")
 * @returns true if the IP is blacklisted
 */
async function isBlacklistedIp(ip: string, zone: string): Promise<boolean> {
  /** Skip private / loopback IPs — they're never in DNSBLs */
  if (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("172.")
  ) {
    return false;
  }

  /** IPv6 not supported by most DNSBLs — skip */
  if (ip.includes(":")) return false;

  const reversed = ip.split(".").reverse().join(".");
  const query = `${reversed}.${zone}`;

  try {
    const results = await resolve4(query);
    return results.length > 0;
  } catch {
    /** NOTFOUND, TIMEOUT, etc. — IP is not listed (fail open) */
    return false;
  }
}

/**
 * Starts the inbound SMTP server.
 *
 * Listens on the configured SMTP_PORT (default 2525) and accepts
 * incoming emails. Each message is parsed, stored in the database,
 * and forwarded to webhooks as an `email.received` event.
 *
 * Three spam protection layers run before message processing:
 * 1. Per-IP rate limiting (in-memory, instant)
 * 2. DNSBL IP check (async DNS lookup against Spamhaus ZEN)
 * 3. Recipient domain validation (DB check against registered domains)
 */
export function start(): void {
  const port = config.smtp.port;
  const { spamProtection } = config.smtp;

  server = new SMTPServer({
    secure: false,
    authOptional: true,
    disabledCommands: ["STARTTLS", "AUTH"],

    /**
     * Maximum message size (bytes). The SMTP server advertises this via
     * the `SIZE` ESMTP extension at the EHLO greeting and rejects
     * `MAIL FROM` with `SIZE=` exceeding it. We also belt-and-suspenders
     * the cap inside `onData` against streams that don't pre-declare size.
     */
    size: MAX_MESSAGE_BYTES,

    /**
     * Called when a client connects.
     * Runs rate limiting (instant) and DNSBL check (async DNS)
     * to reject bad IPs before they can send any data.
     */
    onConnect(session, callback) {
      const ip = session.remoteAddress;

      /** Layer 2: Per-IP rate limiting (runs first — instant, no I/O) */
      if (spamProtection.rateLimitEnabled && isRateLimited(ip)) {
        logger.warn("SMTP connection rate limited", { ip });
        const err = new Error("Too many connections, try again later") as Error & {
          responseCode: number;
        };
        err.responseCode = 421;
        return callback(err);
      }

      /** Layer 1: DNSBL check (async DNS lookup) */
      if (!spamProtection.dnsblEnabled) {
        return callback();
      }

      isBlacklistedIp(ip, spamProtection.dnsblZone)
        .then((listed) => {
          if (listed) {
            logger.warn("SMTP connection rejected — IP blacklisted", { ip });
            const err = new Error(
              "Connection rejected — your IP is blacklisted",
            ) as Error & {
              responseCode: number;
            };
            err.responseCode = 554;
            return callback(err);
          }
          callback();
        })
        .catch(() => {
          /** DNS lookup failed — allow connection (fail open) */
          callback();
        });
    },

    /**
     * Called for each MAIL FROM command. Performs cheap envelope-level
     * validation only — sender authenticity is enforced via SPF/DKIM
     * later (and via DNSBL in `onConnect`). The empty envelope sender
     * `<>` is explicitly allowed because it's how DSN bounces address
     * themselves per RFC 3464.
     */
    onMailFrom(address, _session, callback) {
      const value = address.address;

      /** Empty envelope sender = legitimate DSN bounce; let it through. */
      if (value === "") {
        return callback();
      }

      if (!BASIC_ADDRESS_RE.test(value)) {
        logger.warn("SMTP MAIL FROM rejected — malformed address", {
          address: redactEmail(value),
        });
        const err = new Error("Sender address is not a valid email address") as Error & {
          responseCode: number;
        };
        err.responseCode = 553;
        return callback(err);
      }

      callback();
    },

    /**
     * Called for each RCPT TO command.
     * Validates that the recipient's domain is registered in BunMail
     * and that the transaction hasn't blown past the per-transaction
     * recipient cap (open-relay defence).
     * Rejects mail to unknown domains with SMTP 550.
     */
    onRcptTo(address, session, callback) {
      /**
       * Cap recipients per transaction. `session.envelope.rcptTo` is the
       * already-accepted list; this hook fires before the new address is
       * appended, so reject when the existing length is at or above the
       * cap. SMTP 452 = "too many recipients" (RFC 5321 §3.5).
       */
      const acceptedSoFar = session.envelope.rcptTo?.length ?? 0;
      if (acceptedSoFar >= MAX_RECIPIENTS_PER_TRANSACTION) {
        logger.warn("SMTP RCPT TO rejected — too many recipients", {
          acceptedSoFar,
          ip: session.remoteAddress,
        });
        const err = new Error(
          `Too many recipients (max ${MAX_RECIPIENTS_PER_TRANSACTION} per transaction)`,
        ) as Error & { responseCode: number };
        err.responseCode = 452;
        return callback(err);
      }

      if (!spamProtection.recipientValidationEnabled) {
        return callback();
      }

      const recipientAddress = address.address;
      const domain = recipientAddress.split("@")[1]?.toLowerCase();

      if (!domain) {
        logger.warn("SMTP RCPT TO rejected — invalid address", {
          address: redactEmail(recipientAddress),
        });
        const err = new Error("Invalid recipient address") as Error & {
          responseCode: number;
        };
        err.responseCode = 550;
        return callback(err);
      }

      domainExistsByName(domain)
        .then((exists) => {
          if (!exists) {
            logger.warn("SMTP RCPT TO rejected — unknown domain", {
              address: redactEmail(recipientAddress),
              domain,
              ip: session.remoteAddress,
            });
            const err = new Error(
              `Recipient domain "${domain}" is not handled here`,
            ) as Error & { responseCode: number };
            err.responseCode = 550;
            return callback(err);
          }
          callback();
        })
        .catch((error) => {
          /** DB query failed — allow through (fail open) */
          logger.error("Domain lookup failed during RCPT TO check", {
            error: error instanceof Error ? error.message : String(error),
          });
          callback();
        });
    },

    /**
     * Called for each incoming email.
     * Parses the RFC 822 message, inserts it into `inbound_emails`,
     * and fires an `email.received` webhook event.
     */
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      /**
       * Tracks whether we've already aborted this stream because of the
       * size cap; needed because `data` events keep arriving briefly
       * after we call `stream.unpipe()` / `destroy()`.
       */
      let aborted = false;

      stream.on("data", (chunk: Buffer) => {
        if (aborted) return;
        totalBytes += chunk.length;

        /**
         * Belt-and-suspenders: even though `SMTPServer({ size })` already
         * advertises and enforces the cap at the protocol level, an
         * over-cooperative client can ignore the SIZE extension and just
         * push bytes anyway. Drain the rest, log, and reject with 552.
         */
        if (totalBytes > MAX_MESSAGE_BYTES) {
          aborted = true;
          logger.warn("SMTP DATA rejected — message exceeds size cap", {
            ip: session.remoteAddress,
            totalBytes,
            cap: MAX_MESSAGE_BYTES,
          });
          /** Drop accumulated chunks to free memory before the error. */
          chunks.length = 0;
          stream.unpipe();
          stream.resume();
          const err = new Error("Message size exceeds limit") as Error & {
            responseCode: number;
          };
          err.responseCode = 552;
          callback(err);
          return;
        }

        chunks.push(chunk);
      });

      stream.on("end", async () => {
        if (aborted) return;
        try {
          const rawMessage = Buffer.concat(chunks).toString("utf-8");
          const parsed = await simpleParser(rawMessage);

          /**
           * Bounce branch (#24). If the message is a DSN, route it to
           * the bounce handler — suppress the recipient, mark the
           * original email as `bounced`, fire `email.bounced` webhook —
           * and skip the regular `inbound_emails` insert. Bounces
           * shouldn't pollute the inbound list (operators get noise
           * about delivery failures from mailer-daemon@gmail every
           * time someone mistypes an address).
           */
          const bounce = parseBounce(rawMessage);
          if (bounce) {
            const result = await handleParsedBounce(bounce);
            /**
             * `dropped-no-original` means we couldn't link the bounce
             * back to one of our `emails` rows. We still acknowledge
             * the SMTP transaction (returning ok keeps the upstream MTA
             * from retrying); the warning was already logged by the
             * handler.
             */
            logger.debug("Bounce branch handled inbound message", { result });
            callback();
            return;
          }

          const mailFrom = session.envelope.mailFrom;
          const from =
            parsed.from?.value?.[0]?.address ??
            (mailFrom && typeof mailFrom === "object" ? mailFrom.address : undefined) ??
            "unknown";

          const to = parsed.to
            ? ((Array.isArray(parsed.to)
                ? parsed.to[0]?.value?.[0]?.address
                : parsed.to.value?.[0]?.address) ?? "")
            : (session.envelope.rcptTo?.[0]?.address ?? "unknown");

          const id = generateId("inb");

          await db.insert(inboundEmails).values({
            id,
            fromAddress: from,
            toAddress: to,
            subject: parsed.subject ?? null,
            html: typeof parsed.html === "string" ? parsed.html : null,
            textContent: parsed.text ?? null,
            rawMessage,
          });

          logger.info("Inbound email received and stored", {
            id,
            from: redactEmail(from),
            to: redactEmail(to),
            subject: parsed.subject,
          });

          /** Fire webhook event asynchronously (fire-and-forget) */
          dispatchEvent("email.received", {
            inboundEmailId: id,
            from,
            to,
            subject: parsed.subject ?? null,
          });

          callback();
        } catch (error) {
          logger.error("Failed to process inbound email", {
            error: error instanceof Error ? error.message : String(error),
          });
          callback(
            new Error("Failed to process message") as Error & { responseCode: number },
          );
        }
      });
    },
  });

  server.listen(port, () => {
    logger.info("Inbound SMTP server started", { port });

    /** Log which protection layers are active */
    logger.info("SMTP spam protection", {
      dnsbl: spamProtection.dnsblEnabled ? spamProtection.dnsblZone : "disabled",
      recipientValidation: spamProtection.recipientValidationEnabled,
      rateLimit: spamProtection.rateLimitEnabled
        ? `${spamProtection.rateLimitMax}/${spamProtection.rateLimitWindowSec}s`
        : "disabled",
    });
  });

  server.on("error", (err) => {
    logger.error("SMTP server error", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  /** Periodic cleanup of expired rate limit entries (every 5 minutes) */
  cleanupInterval = setInterval(
    () => {
      const now = Date.now();
      const windowMs = spamProtection.rateLimitWindowSec * 1000;
      for (const [ip, entry] of rateLimitMap) {
        if (now - entry.windowStart >= windowMs) {
          rateLimitMap.delete(ip);
        }
      }
    },
    5 * 60 * 1000,
  );
}

/**
 * Stops the inbound SMTP server gracefully.
 * Called during application shutdown (SIGINT / SIGTERM).
 */
export function stop(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }

  if (server) {
    server.close(() => {
      logger.info("Inbound SMTP server stopped");
    });
    server = null;
  }
}
