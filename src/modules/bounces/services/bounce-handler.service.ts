/**
 * Orchestrates everything that happens when a DSN arrives at a verified
 * signed return path (#236): decide hard vs soft (with escalation on
 * repeat), then, in one transaction (#184), persist the suppression for
 * the one recipient the return path names, mark the original email row as
 * bounced, and enqueue the `email.bounced` webhook.
 *
 * The return path is the only link from a DSN to an email
 * ({@link resolveReturnPath}): the Message-ID in a DSN body is visible to
 * every recipient of the email, so linking by it let one recipient forge
 * a bounce for a co-recipient. A DSN that did not arrive at a valid
 * return path has no effect.
 *
 * The orchestration is split into a pure-ish core (`handleBounce`)
 * that takes its dependencies as callbacks, and a thin public wrapper
 * (`handleParsedBounce`) that wires the real implementations. Tests
 * exercise the core with fake callbacks: no DB needed.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db, type Tx } from "../../../db/index.ts";
import { emails } from "../../emails/models/email.schema.ts";
import {
  addFromBounce,
  findActiveSuppression,
  SOFT_BOUNCE_WINDOW_MS,
} from "../../suppressions/services/suppression.service.ts";
import { enqueueEvent } from "../../webhooks/services/webhook-dispatch.service.ts";
import { logger } from "../../../utils/logger.ts";
import { loggableError } from "../../../utils/db-error.ts";
import { redactEmail } from "../../../utils/redact.ts";
import type { ParsedBounce } from "../types/bounce.types.ts";
import { parseReturnPath, recipientOrder, returnPathMacMatches } from "./return-path.ts";

/** Public-facing email status string for bounced rows. */
const STATUS_BOUNCED = "bounced";

/** The fields of the original `emails` row the handler needs. */
export interface OriginalEmail {
  id: string;
  apiKeyId: string;
}

/**
 * What a verified return path binds a DSN to (#236): one email and one of
 * its recipients. Every field comes from the email row.
 */
export interface ReturnPathBinding {
  email: OriginalEmail;
  /** The recipient the return path names, lowercased. */
  recipient: string;
}

/**
 * Verifies a signed return path (#236) and returns what it binds to, or
 * `null` for every kind of failure: malformed, an email id that does not
 * exist (never sent, or purged), an index past the email's recipients, a
 * MAC that does not match, a domain that is not the email's sender domain.
 * One result for all of them, so the caller can only say "not valid".
 *
 * @param key Return-path key override, for tests; defaults to the configured one.
 */
export async function resolveReturnPath(
  address: string,
  key?: Buffer,
): Promise<ReturnPathBinding | null> {
  const parsed = parseReturnPath(address);
  if (!parsed) return null;

  const [row] = await db
    .select({
      id: emails.id,
      apiKeyId: emails.apiKeyId,
      fromAddress: emails.fromAddress,
      toAddress: emails.toAddress,
      cc: emails.cc,
      bcc: emails.bcc,
    })
    .from(emails)
    .where(eq(emails.id, parsed.emailId))
    .limit(1);
  if (!row) return null;

  const recipient = recipientOrder(row.toAddress, row.cc, row.bcc)[parsed.index];
  if (recipient === undefined) return null;

  const subject = { emailId: row.id, index: parsed.index, recipient };
  if (!returnPathMacMatches(subject, parsed.mac, key)) return null;

  const senderDomain = row.fromAddress.slice(row.fromAddress.lastIndexOf("@") + 1);
  if (senderDomain.trim().toLowerCase() !== parsed.domain) return null;

  return { email: { id: row.id, apiKeyId: row.apiKeyId }, recipient };
}

/**
 * The handler's side effects. `T` is the transaction handle: `Tx` in
 * production, a plain marker in unit tests, so they can check that every
 * write runs inside the one transaction.
 */
export interface BounceHandlerDeps<T> {
  /**
   * Lookup of the existing suppression row (or undefined). Used to
   * decide if a second soft bounce should escalate to hard. Read before
   * the transaction opens.
   */
  isSuppressed: (
    apiKeyId: string,
    email: string,
  ) => Promise<{ id: string; bounceType: string | null } | undefined>;

  /**
   * Runs `work` in one transaction: it commits when `work` resolves and
   * rolls back when it throws (#184).
   */
  transaction: <R>(work: (tx: T) => Promise<R>) => Promise<R>;

  /**
   * Persist the suppression. Idempotent upsert in production, see
   * `suppressionService.addFromBounce`: it never weakens a permanent
   * suppression (#191), so `applied` is false when one was left in place.
   * `suppressionId` is the suppression in effect afterwards, `null` only
   * when it vanished between the write and the read-back.
   */
  addFromBounce: (
    tx: T,
    apiKeyId: string,
    input: {
      email: string;
      bounceType: "hard" | "soft";
      diagnosticCode?: string;
      sourceEmailId?: string;
      expiresAt?: Date | null;
    },
  ) => Promise<{ suppressionId: string | null; applied: boolean }>;

  /** Update the original email row's status column to `bounced`. */
  markEmailBounced: (tx: T, emailId: string) => Promise<void>;

  /**
   * Enqueue `email.bounced` for the key's webhooks, in the same
   * transaction (see `enqueueEvent`). Throws when the insert fails, which
   * rolls the suppression and the status back with it.
   */
  enqueueEvent: (
    tx: T,
    event: "email.bounced",
    data: Record<string, unknown>,
    scope: { apiKeyId: string },
  ) => Promise<unknown>;
}

export interface HandleBounceResult {
  outcome: "applied" | "escalated";
  emailId: string;
  apiKeyId: string;
  /** The suppression in effect for the recipient afterwards, when known. */
  suppressionId?: string;
  bounceType?: "hard" | "soft";
  /** False when a permanent suppression was already on file and kept (#191). */
  suppressionApplied?: boolean;
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
 *
 * The bounce applies to the email and recipient of `binding` only (#236).
 * What the DSN body says about recipients is not trusted: when its
 * `Final-Recipient` / `Original-Recipient` name someone else, that is
 * logged and ignored, and the bound recipient is still the one handled.
 */
export async function handleBounce<T>(
  parsed: ParsedBounce,
  binding: ReturnPathBinding,
  deps: BounceHandlerDeps<T>,
): Promise<HandleBounceResult> {
  const original = binding.email;
  const recipient = binding.recipient;

  if (parsed.recipient !== recipient && parsed.originalRecipient !== recipient) {
    logger.warn(
      "DSN names another recipient than its return path: bound recipient used",
      {
        emailId: original.id,
        recipient: redactEmail(recipient),
        dsnRecipient: redactEmail(parsed.recipient),
        source: parsed.source,
      },
    );
  }

  const existing = await deps.isSuppressed(original.apiKeyId, recipient);
  const finalKind = escalateIfRepeat(parsed.kind, existing);

  const expiresAt =
    finalKind === "hard" ? null : new Date(Date.now() + SOFT_BOUNCE_WINDOW_MS);

  /**
   * The suppression, the status and the event commit together (#184). The
   * event fires whether or not the suppression write applied, and carries
   * the suppressionId (the suppression in effect, which is the existing
   * permanent one when the bounce left it in place) so receivers can
   * cross-reference it without a separate lookup. A failure rolls all
   * three back and is thrown: the receiver answers the DSN with a
   * temporary error, so the sending MTA delivers it again later.
   */
  let suppression: { suppressionId: string | null; applied: boolean };
  try {
    suppression = await deps.transaction(async (tx) => {
      const filed = await deps.addFromBounce(tx, original.apiKeyId, {
        email: recipient,
        bounceType: finalKind,
        diagnosticCode: parsed.diagnostic ?? parsed.status,
        sourceEmailId: original.id,
        expiresAt,
      });

      await deps.markEmailBounced(tx, original.id);

      await deps.enqueueEvent(
        tx,
        "email.bounced",
        {
          emailId: original.id,
          to: recipient,
          bounceType: finalKind,
          status: parsed.status,
          diagnostic: parsed.diagnostic ?? null,
          suppressionId: filed.suppressionId,
        },
        { apiKeyId: original.apiKeyId },
      );
      return filed;
    });
  } catch (error) {
    logger.error("Bounce not recorded: transaction rolled back", {
      emailId: original.id,
      apiKeyId: original.apiKeyId,
      bounceType: finalKind,
      error: loggableError(error),
    });
    throw error;
  }

  const escalated = parsed.kind === "soft" && finalKind === "hard";

  logger.info("Bounce handled", {
    emailId: original.id,
    apiKeyId: original.apiKeyId,
    to: redactEmail(recipient),
    bounceType: finalKind,
    status: parsed.status,
    source: parsed.source,
    escalated,
    suppressionId: suppression.suppressionId,
    suppressionApplied: suppression.applied,
  });

  return {
    outcome: escalated ? "escalated" : "applied",
    emailId: original.id,
    apiKeyId: original.apiKeyId,
    suppressionId: suppression.suppressionId ?? undefined,
    bounceType: finalKind,
    suppressionApplied: suppression.applied,
  };
}

/**
 * Public wrapper. Wires the real DB / service implementations. Called
 * by `inbound/services/smtp-receiver.service.ts` when a DSN arrives at a
 * return path {@link resolveReturnPath} verified.
 */
export async function handleParsedBounce(
  parsed: ParsedBounce,
  binding: ReturnPathBinding,
): Promise<HandleBounceResult> {
  return handleBounce<Tx>(parsed, binding, {
    /**
     * The key's own row only: escalation is about this key's history, so
     * a shared suppression (#250) must not turn this key's soft bounce
     * into a permanent one.
     */
    isSuppressed: async (apiKeyId, email) => {
      const row = await findActiveSuppression(apiKeyId, email);
      return row ? { id: row.id, bounceType: row.bounceType } : undefined;
    },
    transaction: (work) => db.transaction(work),
    addFromBounce: async (tx, apiKeyId, input) => {
      const result = await addFromBounce(apiKeyId, input, tx);
      return { suppressionId: result.suppression?.id ?? null, applied: result.applied };
    },
    markEmailBounced: async (tx, emailId) => {
      /**
       * Only rows the queue has finished with. A row still `queued` or
       * `sending` has groups being retried (multi-MX sends can bounce for
       * one recipient while another is deferred); marking it `bounced`
       * would stop those retries. The suppression is still recorded.
       */
      await tx
        .update(emails)
        .set({ status: STATUS_BOUNCED, updatedAt: new Date() })
        .where(and(eq(emails.id, emailId), inArray(emails.status, ["sent", "failed"])));
    },
    enqueueEvent,
  });
}
