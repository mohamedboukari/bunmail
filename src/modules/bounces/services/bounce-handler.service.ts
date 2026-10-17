/**
 * Orchestrates everything that happens when the parser identifies a
 * bounce: lookup the original email, decide hard vs soft (with
 * escalation on repeat), persist the suppression, mark the original
 * email row as bounced, and fire the `email.bounced` webhook.
 *
 * The orchestration is split into a pure-ish core (`handleBounce`)
 * that takes its dependencies as callbacks, and a thin public wrapper
 * (`handleParsedBounce`) that wires the real implementations. Tests
 * exercise the core with fake callbacks: no DB needed.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../../emails/models/email.schema.ts";
import {
  addFromBounce,
  isSuppressed,
} from "../../suppressions/services/suppression.service.ts";
import { dispatchEvent } from "../../webhooks/services/webhook-dispatch.service.ts";
import { logger } from "../../../utils/logger.ts";
import { parseRecipients } from "../../../utils/recipients.ts";
import { redactEmail } from "../../../utils/redact.ts";
import type { ParsedBounce } from "../types/bounce.types.ts";

/** Soft suppression backoff window. */
const SOFT_BOUNCE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Public-facing email status string for bounced rows. */
const STATUS_BOUNCED = "bounced";

/** The fields of the original `emails` row the handler needs. */
export interface OriginalEmail {
  id: string;
  apiKeyId: string;
  toAddress: string;
  cc: string | null;
  bcc: string | null;
}

export interface BounceHandlerDeps {
  /**
   * Look up the original email row this bounce refers to. Returns
   * `undefined` when no row matches: the handler then drops the
   * bounce (we never suppress under an unknown tenant).
   */
  findEmailByMessageId: (messageId: string) => Promise<OriginalEmail | undefined>;

  /**
   * Lookup of the existing suppression row (or undefined). Used to
   * decide if a second soft bounce should escalate to hard.
   */
  isSuppressed: (
    apiKeyId: string,
    email: string,
  ) => Promise<{ id: string; bounceType: string | null } | undefined>;

  /**
   * Persist the suppression. Idempotent upsert in production, see
   * `suppressionService.addFromBounce`.
   */
  addFromBounce: (
    apiKeyId: string,
    input: {
      email: string;
      bounceType: "hard" | "soft";
      diagnosticCode?: string;
      sourceEmailId?: string;
      expiresAt?: Date | null;
    },
  ) => Promise<{ id: string }>;

  /** Update the original email row's status column to `bounced`. */
  markEmailBounced: (emailId: string) => Promise<void>;

  /**
   * Fire `email.bounced` to subscribed webhooks. Fire-and-forget: the
   * handler doesn't await it (matches `dispatchEvent`'s contract).
   */
  dispatchEvent: (
    event: "email.bounced",
    data: Record<string, unknown>,
    scope: { apiKeyId: string },
  ) => void;
}

export interface HandleBounceResult {
  outcome: "applied" | "dropped-no-original" | "dropped-recipient-mismatch" | "escalated";
  emailId?: string;
  apiKeyId?: string;
  suppressionId?: string;
  bounceType?: "hard" | "soft";
}

/**
 * Decide whether this bounce should escalate. A second soft bounce
 * while a previous soft suppression is still active escalates to hard:
 * repeated transient failures are effectively permanent for IP
 * reputation purposes.
 */
function escalateIfRepeat(
  parsedKind: "hard" | "soft",
  existing: { bounceType: string | null } | undefined,
): "hard" | "soft" {
  if (parsedKind === "hard") return "hard";
  if (existing?.bounceType === "soft") return "hard";
  return "soft";
}

/**
 * Pure-ish orchestration core. Dependencies are injected so unit tests
 * can assert exactly which side effects fire and in what order.
 */
export async function handleBounce(
  parsed: ParsedBounce,
  deps: BounceHandlerDeps,
): Promise<HandleBounceResult> {
  const original = await deps.findEmailByMessageId(parsed.originalMessageId);

  if (!original) {
    logger.warn("Bounce dropped: no original email matches Message-ID", {
      originalMessageId: parsed.originalMessageId,
      recipient: redactEmail(parsed.recipient),
      status: parsed.status,
      source: parsed.source,
    });
    return { outcome: "dropped-no-original" };
  }

  /**
   * The bounced address must be one the email was actually sent to.
   * Bounces arrive over unauthenticated inbound SMTP and are linked only
   * by Message-ID, which every recipient can see, so without this check
   * a forged DSN could suppress any address under the sender's key.
   * `Original-Recipient` also counts (forwarding and aliases change
   * `Final-Recipient`); the suppression is filed for the address we sent
   * to, since that is what a later send would use.
   */
  const sentTo = new Set(
    parseRecipients(original.toAddress, original.cc, original.bcc).map((r) =>
      r.address.toLowerCase(),
    ),
  );
  const recipient = [parsed.recipient, parsed.originalRecipient].find(
    (address) => address !== undefined && sentTo.has(address),
  );
  if (!recipient) {
    logger.warn("Bounce dropped: recipient was not a recipient of the original email", {
      emailId: original.id,
      recipient: redactEmail(parsed.recipient),
      source: parsed.source,
    });
    return { outcome: "dropped-recipient-mismatch", emailId: original.id };
  }

  const existing = await deps.isSuppressed(original.apiKeyId, recipient);
  const finalKind = escalateIfRepeat(parsed.kind, existing);

  const expiresAt =
    finalKind === "hard" ? null : new Date(Date.now() + SOFT_BOUNCE_WINDOW_MS);

  const suppression = await deps.addFromBounce(original.apiKeyId, {
    email: recipient,
    bounceType: finalKind,
    diagnosticCode: parsed.diagnostic ?? parsed.status,
    sourceEmailId: original.id,
    expiresAt,
  });

  await deps.markEmailBounced(original.id);

  /**
   * Fire-and-forget webhook. Carries the suppressionId so receivers can
   * cross-reference the just-created suppression row in the dashboard
   * or via API without a separate lookup.
   */
  deps.dispatchEvent(
    "email.bounced",
    {
      emailId: original.id,
      to: recipient,
      bounceType: finalKind,
      status: parsed.status,
      diagnostic: parsed.diagnostic ?? null,
      suppressionId: suppression.id,
    },
    { apiKeyId: original.apiKeyId },
  );

  const escalated = parsed.kind === "soft" && finalKind === "hard";

  logger.info("Bounce handled", {
    emailId: original.id,
    apiKeyId: original.apiKeyId,
    to: redactEmail(recipient),
    bounceType: finalKind,
    status: parsed.status,
    source: parsed.source,
    escalated,
    suppressionId: suppression.id,
  });

  return {
    outcome: escalated ? "escalated" : "applied",
    emailId: original.id,
    apiKeyId: original.apiKeyId,
    suppressionId: suppression.id,
    bounceType: finalKind,
  };
}

/**
 * Public wrapper. Wires the real DB / service implementations. Called
 * by `inbound/services/smtp-receiver.service.ts` after the parser
 * returns a non-null `ParsedBounce`.
 */
export async function handleParsedBounce(
  parsed: ParsedBounce,
): Promise<HandleBounceResult> {
  return handleBounce(parsed, {
    findEmailByMessageId: async (messageId) => {
      /**
       * When BunMail sends, nodemailer fills `messageId` like
       * `<id@host>` and we persist it on `emails.message_id`. The
       * bounce's `Original-Message-ID` arrives with or without angle
       * brackets: the parser already stripped them, but we look up
       * with both shapes to be safe across SMTP-flavour quirks.
       */
      const wrapped = `<${messageId}>`;
      const [row] = await db
        .select({
          id: emails.id,
          apiKeyId: emails.apiKeyId,
          toAddress: emails.toAddress,
          cc: emails.cc,
          bcc: emails.bcc,
        })
        .from(emails)
        .where(eq(emails.messageId, wrapped))
        .limit(1);
      if (row) return row;
      const [unwrapped] = await db
        .select({
          id: emails.id,
          apiKeyId: emails.apiKeyId,
          toAddress: emails.toAddress,
          cc: emails.cc,
          bcc: emails.bcc,
        })
        .from(emails)
        .where(eq(emails.messageId, messageId))
        .limit(1);
      return unwrapped;
    },
    isSuppressed: async (apiKeyId, email) => {
      const row = await isSuppressed(apiKeyId, email);
      return row ? { id: row.id, bounceType: row.bounceType } : undefined;
    },
    addFromBounce: async (apiKeyId, input) => {
      const row = await addFromBounce(apiKeyId, input);
      return { id: row.id };
    },
    markEmailBounced: async (emailId) => {
      /**
       * Only rows the queue has finished with. A row still `queued` or
       * `sending` has groups being retried (multi-MX sends can bounce for
       * one recipient while another is deferred); marking it `bounced`
       * would stop those retries. The suppression is still recorded.
       */
      await db
        .update(emails)
        .set({ status: STATUS_BOUNCED, updatedAt: new Date() })
        .where(and(eq(emails.id, emailId), inArray(emails.status, ["sent", "failed"])));
    },
    dispatchEvent,
  });
}
