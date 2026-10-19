import { eq } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails, type EmailTags } from "../../emails/models/email.schema.ts";
import { enqueueEvent } from "../../webhooks/services/webhook-dispatch.service.ts";
import { logger } from "../../../utils/logger.ts";
import { loggableError } from "../../../utils/db-error.ts";
import { addFromUnsubscribe } from "./suppression.service.ts";
import {
  parseUnsubscribeToken,
  soleRecipient,
  unsubscribeMacMatches,
} from "./unsubscribe-token.ts";
import type { UnsubscribeSource } from "../types/suppression.types.ts";

/**
 * The unsubscribe flow behind `/u/:token` and the `unsub+<token>` mailto
 * (#249): verify a token against its email row, then suppress the one
 * recipient it names.
 */

/** What a verified token resolves to. Every field comes from the email row. */
export interface UnsubscribeTarget {
  emailId: string;
  apiKeyId: string;
  /** The email's only recipient, lowercased. */
  recipient: string;
  /** Domain of the email's From address, lowercased. */
  senderDomain: string;
  /** The email's tags (#189), carried by `email.unsubscribed`; null when none. */
  tags: EmailTags | null;
}

/**
 * Verifies a presented token. Returns `null` for every kind of failure:
 * malformed, an email id that does not exist (never sent, or purged), an
 * email that has cc or bcc, a MAC that does not match. One result for all
 * of them, so the caller can only ever say "not valid".
 *
 * @param key Token key override, for tests; defaults to the configured one.
 */
export async function resolveUnsubscribeToken(
  token: string,
  key?: Buffer,
): Promise<UnsubscribeTarget | null> {
  const parsed = parseUnsubscribeToken(token);
  if (!parsed) return null;

  const [row] = await db
    .select({
      apiKeyId: emails.apiKeyId,
      fromAddress: emails.fromAddress,
      toAddress: emails.toAddress,
      cc: emails.cc,
      bcc: emails.bcc,
      tags: emails.tags,
    })
    .from(emails)
    .where(eq(emails.id, parsed.emailId))
    .limit(1);
  if (!row) return null;

  const recipient = soleRecipient(row.toAddress, row.cc, row.bcc);
  if (recipient === null) return null;

  const subject = { emailId: parsed.emailId, recipient };
  if (!unsubscribeMacMatches(subject, parsed.mac, key)) return null;

  const senderDomain = row.fromAddress.split("@")[1]?.trim().toLowerCase();
  if (!senderDomain) return null;

  return { ...subject, apiKeyId: row.apiKeyId, senderDomain, tags: row.tags };
}

/**
 * Suppresses a verified target (permanent, reason `unsubscribe`, scoped to
 * the sending key) and, the first time only, enqueues `email.unsubscribed`
 * for that key's webhooks. A repeated request succeeds and fires nothing.
 *
 * The suppression and its event are one transaction (#184): either both
 * are stored or neither is. A failure is logged and thrown, so the page
 * answers with an error and the mailto is refused with a temporary error
 * (the sender retries), instead of a suppression without its event.
 *
 * @returns `true` when this request created the suppression.
 */
export async function unsubscribe(
  target: UnsubscribeTarget,
  source: UnsubscribeSource,
): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      const row = await addFromUnsubscribe(
        {
          apiKeyId: target.apiKeyId,
          email: target.recipient,
          emailId: target.emailId,
          source,
        },
        tx,
      );
      if (!row) return false;

      await enqueueEvent(
        tx,
        "email.unsubscribed",
        {
          emailId: target.emailId,
          recipient: target.recipient,
          source,
          unsubscribedAt: new Date().toISOString(),
          tags: target.tags,
        },
        { apiKeyId: target.apiKeyId },
      );
      return true;
    });
  } catch (error) {
    logger.error("Unsubscribe not recorded: transaction rolled back", {
      emailId: target.emailId,
      apiKeyId: target.apiKeyId,
      source,
      error: loggableError(error),
    });
    throw error;
  }
}
