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
  direct: true;
  name: string;
}

const transport = nodemailer.createTransport({
  direct: true,
  name: config.mail.hostname,
} as DirectTransportOptions as nodemailer.TransportOptions);

export interface SendMailResult {
  messageId: string;
}

/** DKIM signing options passed from the queue processor. */
export interface DkimOptions {
  domainName: string;
  keySelector: string;
  privateKey: string;
}

/**
 * Sends a single email via SMTP direct delivery.
 *
 * When DKIM options are provided, signs the outgoing message with the
 * domain's private key so the recipient's server can verify the signature
 * via DNS TXT lookup.
 */
export async function sendMail(options: {
  from: string;
  to: string;
  cc?: string | null;
  bcc?: string | null;
  subject: string;
  html?: string | null;
  text?: string | null;
  dkim?: DkimOptions;
}): Promise<SendMailResult> {
  logger.info("Sending email via SMTP", {
    from: options.from,
    to: options.to,
    subject: options.subject,
    dkim: options.dkim ? options.dkim.domainName : "none",
  });

  const mailOptions: Mail.Options = {
    from: options.from,
    to: options.to,
    cc: options.cc ?? undefined,
    bcc: options.bcc ?? undefined,
    subject: options.subject,
    html: options.html ?? undefined,
    text: options.text ?? undefined,
  };

  if (options.dkim) {
    mailOptions.dkim = {
      domainName: options.dkim.domainName,
      keySelector: options.dkim.keySelector,
      privateKey: options.dkim.privateKey,
    };
  }

  const info = await transport.sendMail(mailOptions);

  logger.info("Email sent successfully", {
    messageId: info.messageId,
    to: options.to,
  });

  return { messageId: info.messageId };
}
