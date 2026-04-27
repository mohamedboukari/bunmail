import nodemailer from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import { resolveMx } from "dns/promises";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";

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
 * Resolves the MX server for a recipient's domain and returns
 * the lowest-priority (highest preference) mail exchange host.
 */
async function getMxHost(email: string): Promise<string> {
  const domain = email.split("@")[1];
  if (!domain) throw new Error(`Invalid email address: ${email}`);

  const records = await resolveMx(domain);
  if (!records || records.length === 0) {
    throw new Error(`No MX records found for domain: ${domain}`);
  }

  records.sort((a, b) => a.priority - b.priority);
  return records[0]!.exchange;
}

/**
 * Sends a single email via direct SMTP delivery.
 *
 * Instead of relying on Nodemailer's `direct: true` mode (which can
 * fall back to localhost:587 inside Docker), we manually resolve the
 * recipient's MX record and connect to it on port 25.
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

  /** Resolve the recipient's MX server */
  const mxHost = await getMxHost(options.to);
  logger.debug("Resolved MX host", { to: options.to, mxHost });

  /**
   * Create a transport that connects directly to the recipient's MX
   * server on port 25. A new transport per message ensures we always
   * connect to the correct MX for the recipient's domain.
   *
   * `opportunisticTLS` makes Nodemailer issue STARTTLS whenever the
   * receiving server advertises support for it, but still allows
   * delivery in the clear when the MX doesn't speak TLS at all (legacy
   * receivers). Cipher / cert validation is intentionally relaxed
   * (`rejectUnauthorized: false`) — MTA-to-MTA delivery routinely
   * encounters self-signed and expired certs, and refusing them would
   * mean dropping legitimate mail. Tracked in #42 for stricter handling.
   */
  const transport = nodemailer.createTransport({
    host: mxHost,
    port: 25,
    secure: false,
    opportunisticTLS: true,
    name: config.mail.hostname,
    tls: {
      rejectUnauthorized: false,
    },
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
    mxHost,
  });

  return { messageId: info.messageId };
}
