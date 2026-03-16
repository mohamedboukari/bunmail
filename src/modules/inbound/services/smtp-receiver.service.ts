import { resolve4 } from "dns/promises";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { db } from "../../../db/index.ts";
import { inboundEmails } from "../models/inbound-email.schema.ts";
import { generateId } from "../../../utils/id.ts";
import { dispatchEvent } from "../../webhooks/services/webhook-dispatch.service.ts";
import { domainExistsByName } from "../../domains/services/domain.service.ts";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";

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
     * Called for each RCPT TO command.
     * Validates that the recipient's domain is registered in BunMail.
     * Rejects mail to unknown domains with SMTP 550.
     */
    onRcptTo(address, session, callback) {
      if (!spamProtection.recipientValidationEnabled) {
        return callback();
      }

      const recipientAddress = address.address;
      const domain = recipientAddress.split("@")[1]?.toLowerCase();

      if (!domain) {
        logger.warn("SMTP RCPT TO rejected — invalid address", {
          address: recipientAddress,
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
              address: recipientAddress,
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

      stream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      stream.on("end", async () => {
        try {
          const rawMessage = Buffer.concat(chunks).toString("utf-8");
          const parsed = await simpleParser(rawMessage);

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
            from,
            to,
            subject: parsed.subject,
          });

          /** Fire webhook event asynchronously (fire-and-forget) */
          dispatchEvent("email.received" as "email.queued", {
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
