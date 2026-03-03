import nodemailer from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";

/**
 * Direct transport options — not included in @types/nodemailer
 * because it's a lesser-known Nodemailer feature. The `direct` flag
 * tells Nodemailer to resolve MX records and deliver straight to
 * the recipient's mail server without an intermediate SMTP relay.
 */
interface DirectTransportOptions {
  /** Enable direct MX delivery (no relay server) */
  direct: true;
  /** Hostname used in the SMTP HELO command */
  name: string;
}

/**
 * Nodemailer transport configured in "direct" mode.
 *
 * Direct mode means emails are sent straight to the recipient's MX server
 * without going through an SMTP relay (no SendGrid, no Gmail SMTP, etc.).
 * The `name` option is used in the SMTP HELO command — it should match
 * the server's PTR record for best deliverability.
 */
const transport = nodemailer.createTransport({
  direct: true,
  name: config.mail.hostname,
} as DirectTransportOptions as nodemailer.TransportOptions);

/**
 * The result returned after a successful SMTP send.
 */
export interface SendMailResult {
  /** The SMTP Message-ID assigned by the receiving server */
  messageId: string;
}

/**
 * Sends a single email via SMTP direct delivery.
 *
 * This is called by the queue processor for each email it picks up.
 * It resolves the recipient's MX records and delivers directly.
 * Throws on failure (network error, rejected by MX server, etc.).
 *
 * @param options - Standard email fields (from, to, subject, html/text)
 * @returns The SMTP Message-ID on success
 */
export async function sendMail(options: {
  from: string;
  to: string;
  cc?: string | null;
  bcc?: string | null;
  subject: string;
  html?: string | null;
  text?: string | null;
}): Promise<SendMailResult> {
  logger.info("Sending email via SMTP", {
    from: options.from,
    to: options.to,
    subject: options.subject,
  });

  /**
   * Build the Nodemailer message options.
   * Undefined fields are omitted — Nodemailer ignores them.
   */
  const mailOptions: Mail.Options = {
    from: options.from,
    to: options.to,
    cc: options.cc ?? undefined,
    bcc: options.bcc ?? undefined,
    subject: options.subject,
    html: options.html ?? undefined,
    text: options.text ?? undefined,
  };

  /** Send the email and capture the SMTP response */
  const info = await transport.sendMail(mailOptions);

  logger.info("Email sent successfully", {
    messageId: info.messageId,
    to: options.to,
  });

  return { messageId: info.messageId };
}
