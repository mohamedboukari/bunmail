import { randomBytes } from "crypto";
import { config } from "../../../config.ts";
import { sendMail } from "../../emails/services/mailer.service.ts";
import type {
  DkimOptions,
  SendMailResult,
} from "../../emails/services/mailer.service.ts";
import { getDomainByName } from "../../domains/services/domain.service.ts";
import { resolveDomainDkim } from "../../domains/services/domain-dkim.service.ts";
import type { Domain } from "../../domains/types/domain.types.ts";
import { UserStoreError, withSanitizedErrors } from "../errors.ts";

/**
 * BunMail's own mail to its users: invitation emails (#217) and
 * new-device sign-in alerts (#282). Sent out-of-band with `sendMail` (no
 * `emails` row, no API key), like inbound notifications (#106), from
 * `SYSTEM_MAIL_FROM` and signed with that domain's DKIM key.
 *
 * Sent only when the sender is usable: `SYSTEM_MAIL_FROM` is set, its
 * domain is registered in BunMail with a verified DKIM record, and its
 * key decrypts. Never sent unsigned. Never throws and never logs: the
 * caller gets the outcome, with sanitized details, and writes its own
 * log line (it knows the ids to put on it).
 */

/** Why a system email did not go out. */
export type SystemMailFailure = "not_configured" | "sender_unavailable" | "send_failed";

/** Outcome of `sendSystemMail`. `detail` is safe to log (no address, no raw error). */
export type SystemMailResult =
  | { sent: true; domain: string }
  | { sent: false; reason: SystemMailFailure; detail: Record<string, unknown> };

/** One composed system email. */
export interface SystemMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** What `sendSystemMail` needs from the outside, injectable for tests. */
export interface SystemMailDeps {
  /** `SYSTEM_MAIL_FROM`, or `null` when unset. */
  from: string | null;
  /** Domain lookup by name (lower-cased). */
  findDomain: (name: string) => Promise<Domain | undefined>;
  /** DKIM options for a domain, or `undefined` when its key is unusable. */
  resolveDkim: (domain: Domain) => DkimOptions | undefined;
  /** The direct-to-MX mailer. */
  send: typeof sendMail;
  /** Message-ID domain (`MAIL_HOSTNAME`). */
  hostname: string;
}

/** The production dependencies. */
export function systemMailDeps(): SystemMailDeps {
  return {
    from: config.systemMailFrom,
    /** A drizzle error would carry the query params: sanitized to its SQLSTATE. */
    findDomain: (name) => withSanitizedErrors(() => getDomainByName(name)),
    resolveDkim: resolveDomainDkim,
    send: sendMail,
    hostname: config.mail.hostname,
  };
}

/** Escapes the five HTML-significant characters. */
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c] ?? c,
  );
}

/**
 * Flattens a value for one line of a plain-text part: control characters
 * become spaces, so a hostile value cannot add lines that look like part
 * of the message.
 */
export function oneLine(value: string): string {
  return value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Sends one system email when the system sender is usable. `sent` means
 * a receiving MX accepted the message. A thrown lookup or send error is
 * reported by its name and, for the users store, its SQLSTATE, never by
 * its raw message: a database error's message carries the query and its
 * parameters, and an SMTP error's can quote addresses.
 */
export async function sendSystemMail(
  message: SystemMessage,
  deps: SystemMailDeps,
): Promise<SystemMailResult> {
  const notSent = (
    reason: SystemMailFailure,
    detail: Record<string, unknown> = {},
  ): SystemMailResult => ({ sent: false, reason, detail });

  if (!deps.from) return notSent("not_configured");
  const domainName = deps.from.split("@")[1] ?? "";

  let result: SendMailResult;
  try {
    const domain = await deps.findDomain(domainName);
    if (!domain) return notSent("sender_unavailable", { domain: domainName });
    if (!domain.dkimVerified) {
      return notSent("sender_unavailable", { domain: domainName, dkimVerified: false });
    }
    const dkim = deps.resolveDkim(domain);
    if (!dkim) return notSent("sender_unavailable", { domain: domainName, dkim: "none" });

    result = await deps.send({
      from: deps.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      messageId: `<${randomBytes(16).toString("hex")}@${deps.hostname}>`,
      dkim,
      /** BunMail's own automatic mail (#250). */
      feedback: { source: "system", apiKeyId: null },
      autoSubmitted: true,
    });
  } catch (err) {
    return notSent("send_failed", {
      domain: domainName,
      errorName: err instanceof Error ? err.name : typeof err,
      ...(err instanceof UserStoreError ? { sqlState: err.sqlState } : {}),
    });
  }

  /** `sendMail` reports a dead MX per group instead of throwing. */
  const groups = Object.values(result.deliveryState);
  if (!groups.some((g) => g.status === "sent")) {
    return notSent("send_failed", {
      domain: domainName,
      groups: groups.map((g) => g.status),
    });
  }
  return { sent: true, domain: domainName };
}
