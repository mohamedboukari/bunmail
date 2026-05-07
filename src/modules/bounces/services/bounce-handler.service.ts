/**
 * Orchestrates everything that happens when the parser identifies a
 * bounce: lookup the original email, decide hard vs soft (with
 * escalation on repeat), persist the suppression, mark the original
 * email row as bounced, and fire the `email.bounced` webhook.
 *
 * The orchestration is split into a pure-ish core (`handleBounce`)
 * that takes its dependencies as callbacks, and a thin public wrapper
 * (`handleParsedBounce`) that wires the real implementations. Tests
 * exercise the core with fake callbacks — no DB needed.
 */

import { eq } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../../emails/models/email.schema.ts";
import {
  addFromBounce,
  isSuppressed,
} from "../../suppressions/services/suppression.service.ts";
import { dispatchEvent } from "../../webhooks/services/webhook-dispatch.service.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import type { ParsedBounce } from "../types/bounce.types.ts";

/** Soft suppression backoff window. */
const SOFT_BOUNCE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Public-facing email status string for bounced rows. */
const STATUS_BOUNCED = "bounced";

export interface BounceHandlerDeps {
  /**
   * Look up the original email row this bounce refers to. Returns
   * `undefined` when no row matches — the handler then drops the
   * bounce (we never suppress under an unknown tenant).
   */
  findEmailByMessageId: (
    messageId: string,
  ) => Promise<{ id: string; apiKeyId: string; toAddress: string } | undefined>;

  /**
   * Lookup of the existing suppression row (or undefined). Used to
   * decide if a second soft bounce should escalate to hard.
   */
  isSuppressed: (
    apiKeyId: string,
    email: string,
  ) => Promise<{ id: string; bounceType: string | null } | undefined>;

  /**
   * Persist the suppression. Idempotent upsert in production — see
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
   * Fire `email.bounced` to subscribed webhooks. Fire-and-forget — the
   * handler doesn't await it (matches `dispatchEvent`'s contract).
   */
  dispatchEvent: (event: "email.bounced", data: Record<string, unknown>) => void;
}

export interface HandleBounceResult {
  outcome: "applied" | "dropped-no-original" | "escalated";
  emailId?: string;
  apiKeyId?: string;
  suppressionId?: string;
  bounceType?: "hard" | "soft";
}

/**
 * Decide whether this bounce should escalate. A second soft bounce
 * while a previous soft suppression is still active escalates to hard
 * — repeated transient failures are effectively permanent for IP
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
    logger.warn("Bounce dropped — no original email matches Message-ID", {
      originalMessageId: parsed.originalMessageId,
      recipient: redactEmail(parsed.recipient),
      status: parsed.status,
      source: parsed.source,
    });
    return { outcome: "dropped-no-original" };
  }

  /**
   * Cross-check the recipient — defensive. The original `to` should
   * match the bounce's recipient. A mismatch usually means the message
   * was a multi-recipient send and this bounce only concerns one of
   * them; we trust the parsed recipient over the original toAddress.
   */
  if (original.toAddress.toLowerCase() !== parsed.recipient) {
    logger.debug("Bounce recipient differs from original toAddress", {
      original: redactEmail(original.toAddress),
      bounced: redactEmail(parsed.recipient),
      emailId: original.id,
    });
  }

  const existing = await deps.isSuppressed(original.apiKeyId, parsed.recipient);
  const finalKind = escalateIfRepeat(parsed.kind, existing);

  const expiresAt =
    finalKind === "hard" ? null : new Date(Date.now() + SOFT_BOUNCE_WINDOW_MS);

  const suppression = await deps.addFromBounce(original.apiKeyId, {
    email: parsed.recipient,
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
  deps.dispatchEvent("email.bounced", {
    emailId: original.id,
    to: parsed.recipient,
    bounceType: finalKind,
    status: parsed.status,
    diagnostic: parsed.diagnostic ?? null,
    suppressionId: suppression.id,
  });

  const escalated = parsed.kind === "soft" && finalKind === "hard";

  logger.info("Bounce handled", {
    emailId: original.id,
    apiKeyId: original.apiKeyId,
    to: redactEmail(parsed.recipient),
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
       * brackets — the parser already stripped them, but we look up
       * with both shapes to be safe across SMTP-flavour quirks.
       */
      const wrapped = `<${messageId}>`;
      const [row] = await db
        .select({
          id: emails.id,
          apiKeyId: emails.apiKeyId,
          toAddress: emails.toAddress,
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
      await db
        .update(emails)
        .set({ status: STATUS_BOUNCED, updatedAt: new Date() })
        .where(eq(emails.id, emailId));
    },
    dispatchEvent,
  });
}
