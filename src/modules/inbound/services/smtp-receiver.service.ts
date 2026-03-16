import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { db } from "../../../db/index.ts";
import { inboundEmails } from "../models/inbound-email.schema.ts";
import { generateId } from "../../../utils/id.ts";
import { dispatchEvent } from "../../webhooks/services/webhook-dispatch.service.ts";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";

/** Reference to the running SMTP server instance */
let server: SMTPServer | null = null;

/**
 * Starts the inbound SMTP server.
 *
 * Listens on the configured SMTP_PORT (default 2525) and accepts
 * incoming emails. Each message is parsed, stored in the database,
 * and forwarded to webhooks as an `email.received` event.
 *
 * Uses permissive auth (accepts all senders) — suitable for
 * receiving inbound mail on a domain's MX record.
 */
export function start(): void {
  const port = config.smtp.port;

  server = new SMTPServer({
    secure: false,
    authOptional: true,
    disabledCommands: ["STARTTLS", "AUTH"],

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
  });

  server.on("error", (err) => {
    logger.error("SMTP server error", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Stops the inbound SMTP server gracefully.
 * Called during application shutdown (SIGINT / SIGTERM).
 */
export function stop(): void {
  if (server) {
    server.close(() => {
      logger.info("Inbound SMTP server stopped");
    });
    server = null;
  }
}
