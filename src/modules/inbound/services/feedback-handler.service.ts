/**
 * What happens to a feedback-loop report (ARF, RFC 5965, #191) once the
 * receiver has recognised one: link it to the email BunMail sent, choose
 * the recipient who complained, then suppress them and fire
 * `email.complained` (or, for an `opt-out` report, unsubscribe them).
 *
 * Reports arrive as unauthenticated inbound mail, so the Message-ID link
 * is the security boundary: a report counts only when its
 * Original-Message-ID is exactly the Message-ID of an email BunMail sent.
 * Those ids are 128 random bits, so only someone holding the delivered
 * message (its recipients, their mailbox provider) can name one. DKIM on
 * the report is checked and logged, but not required: not every provider
 * signs its reports.
 *
 * Same shape as the bounce handler: a core (`handleFeedbackReport`) that
 * takes its side effects as callbacks for unit tests, and a wrapper
 * (`handleInboundFeedbackReport`) that wires the real ones.
 */

import { eq } from "drizzle-orm";
import { dkimVerify } from "mailauth/lib/dkim/verify";
import { db, type Tx } from "../../../db/index.ts";
import { emails, type EmailTags } from "../../emails/models/email.schema.ts";
import { addFromComplaint } from "../../suppressions/services/suppression.service.ts";
import {
  unsubscribe,
  type UnsubscribeTarget,
} from "../../suppressions/services/unsubscribe.service.ts";
import type { AddFromComplaintInput } from "../../suppressions/types/suppression.types.ts";
import { enqueueEvent } from "../../webhooks/services/webhook-dispatch.service.ts";
import { logger } from "../../../utils/logger.ts";
import { loggableError } from "../../../utils/db-error.ts";
import { parseRecipients } from "../../../utils/recipients.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { parseFeedbackReport } from "./arf-parser.service.ts";
import type {
  FeedbackAction,
  FeedbackOutcome,
  FeedbackReport,
} from "../types/feedback-report.types.ts";

/** Longest `reporter` put in the webhook payload. */
const MAX_REPORTER_LENGTH = 200;

/** DKIM is checked only on reports whose header section ends within this. */
const MAX_DKIM_HEADER_BYTES = 64 * 1024;

/** More signatures than this and DKIM is not checked (each one is a DNS lookup). */
const MAX_DKIM_SIGNATURES = 5;

/** Upper bound on the DKIM check; a slow DNS answer is a `temperror`. */
const DKIM_TIMEOUT_MS = 10_000;

/** The fields of the linked `emails` row the handler needs. */
export interface LinkedEmail {
  id: string;
  apiKeyId: string;
  fromAddress: string;
  toAddress: string;
  cc: string | null;
  bcc: string | null;
  /** The email's tags (#189), carried by `email.complained`; null when none. */
  tags: EmailTags | null;
}

/** DKIM verdict on the report itself, for the log line only. */
export interface DkimCheck {
  /** `pass`, `fail`, `neutral`, `none`, `temperror`, `permerror`, `policy`, or `skipped`. */
  result: string;
  /** `d=` of the signature the verdict is about, when there is one. */
  signingDomain: string | null;
}

/**
 * The handler's side effects. `T` is the transaction handle: `Tx` in
 * production, a plain marker in unit tests, so they can check that the
 * suppression and its event share one transaction.
 */
export interface FeedbackHandlerDeps<T> {
  /** The email BunMail sent with this Message-ID (exact match), if any. */
  findEmailByMessageId: (messageId: string) => Promise<LinkedEmail | undefined>;
  /**
   * Runs `work` in one transaction: it commits when `work` resolves and
   * rolls back when it throws (#184).
   */
  transaction: <R>(work: (tx: T) => Promise<R>) => Promise<R>;
  /** Permanent `complaint` suppression; `undefined` when one was already on file. */
  addFromComplaint: (
    tx: T,
    input: AddFromComplaintInput,
  ) => Promise<{ id: string } | undefined>;
  /** The #249 unsubscribe path (its own transaction); `true` when it created the suppression. */
  unsubscribe: (target: UnsubscribeTarget, source: "fbl") => Promise<boolean>;
  /**
   * Enqueue `email.complained` for the sending key's webhooks, in the
   * transaction of the suppression (see `enqueueEvent`). Throws when the
   * insert fails, which rolls the suppression back with it.
   */
  enqueueEvent: (
    tx: T,
    event: "email.complained",
    data: Record<string, unknown>,
    scope: { apiKeyId: string },
  ) => Promise<unknown>;
  /** DKIM verdict on the report (logged, never required). */
  verifyDkim: () => Promise<DkimCheck>;
}

export interface HandleFeedbackResult {
  outcome: FeedbackOutcome;
  emailId?: string;
}

/**
 * What a `Feedback-Type` asks for: `abuse`, `fraud` or none at all is a
 * complaint, `opt-out` an unsubscribe, anything else (`not-spam`, `virus`,
 * `other`, unregistered values) is not acted on.
 */
export function classifyFeedbackType(feedbackType: string | null): FeedbackAction {
  if (feedbackType === null || feedbackType === "abuse" || feedbackType === "fraud") {
    return "complaint";
  }
  if (feedbackType === "opt-out") return "opt-out";
  return "ignore";
}

/**
 * The recipient the report is about: the first `Original-Rcpt-To` that was
 * a recipient (to, cc or bcc) of the linked email, else the email's only
 * recipient, else `null` (several recipients and no usable
 * `Original-Rcpt-To`, often because the provider redacted it).
 */
function chooseRecipient(report: FeedbackReport, email: LinkedEmail): string | null {
  const recipients = parseRecipients(email.toAddress, email.cc, email.bcc).map((r) =>
    r.address.toLowerCase(),
  );
  const named = report.originalRcptTo.find((address) => recipients.includes(address));
  if (named !== undefined) return named;
  return recipients.length === 1 ? recipients[0]! : null;
}

/** Who sent the report, for the webhook: its `User-Agent`, else its domain. */
function reporterOf(report: FeedbackReport): string | null {
  const reporter = (report.userAgent ?? report.reporterDomain ?? "")
    .trim()
    .slice(0, MAX_REPORTER_LENGTH);
  return reporter === "" ? null : reporter;
}

/**
 * Orchestration core. `report` is the parser's result (`null` when the
 * message was a `feedback-report` without a readable feedback part). Never
 * throws for a bad report: every drop is logged and returned as an outcome.
 * A failed write is logged and thrown: the receiver answers with a
 * temporary error, so the provider delivers the report again later.
 */
export async function handleFeedbackReport<T>(
  report: FeedbackReport | null,
  deps: FeedbackHandlerDeps<T>,
): Promise<HandleFeedbackResult> {
  if (report === null) {
    logger.warn("Feedback report dropped: no readable feedback part");
    return { outcome: "dropped-unparseable" };
  }

  const reportContext = {
    feedbackType: report.feedbackType,
    reporterDomain: report.reporterDomain,
  };

  const action = classifyFeedbackType(report.feedbackType);
  if (action === "ignore") {
    logger.info("Feedback report ignored: feedback type not acted on", reportContext);
    return { outcome: "dropped-ignored-type" };
  }

  const original =
    report.originalMessageId === null
      ? undefined
      : await deps.findEmailByMessageId(report.originalMessageId);
  if (!original) {
    logger.warn("Feedback report dropped: no original email matches Message-ID", {
      ...reportContext,
      hasMessageId: report.originalMessageId !== null,
      originalRcptTo: report.originalRcptTo.map((address) => redactEmail(address)),
    });
    return { outcome: "dropped-no-original" };
  }

  const dkim = await deps.verifyDkim();
  const recipient = chooseRecipient(report, original);
  const linkedContext = {
    ...reportContext,
    emailId: original.id,
    apiKeyId: original.apiKeyId,
    dkim: dkim.result,
    dkimDomain: dkim.signingDomain,
  };

  if (action === "opt-out") {
    if (recipient === null) {
      logger.warn(
        "Feedback opt-out not applied: recipient could not be determined",
        linkedContext,
      );
      return { outcome: "dropped-no-recipient", emailId: original.id };
    }
    const created = await deps.unsubscribe(
      {
        emailId: original.id,
        apiKeyId: original.apiKeyId,
        recipient,
        senderDomain: original.fromAddress.split("@")[1]?.trim().toLowerCase() ?? "",
        tags: original.tags,
      },
      "fbl",
    );
    logger.info("Feedback opt-out handled", {
      ...linkedContext,
      recipient: redactEmail(recipient),
      outcome: created ? "unsubscribed" : "already-unsubscribed",
    });
    return {
      outcome: created ? "unsubscribed" : "already-unsubscribed",
      emailId: original.id,
    };
  }

  const payload = {
    emailId: original.id,
    recipient,
    feedbackType: report.feedbackType,
    reporter: reporterOf(report),
    arrivalDate: report.arrivalDate?.toISOString() ?? null,
    receivedAt: new Date().toISOString(),
    tags: original.tags,
  };

  if (recipient === null) {
    logger.warn("Complaint not suppressed: recipient could not be determined", {
      ...linkedContext,
      originalRcptTo: report.originalRcptTo.map((address) => redactEmail(address)),
    });
    /** No state change to commit with: the event gets a transaction of its own. */
    await recorded(linkedContext, () =>
      deps.transaction((tx) =>
        deps.enqueueEvent(tx, "email.complained", payload, {
          apiKeyId: original.apiKeyId,
        }),
      ),
    );
    return { outcome: "complained-no-recipient", emailId: original.id };
  }

  /** The suppression and its event commit together, or neither does (#184). */
  const suppression = await recorded(linkedContext, () =>
    deps.transaction(async (tx) => {
      const changed = await deps.addFromComplaint(tx, {
        apiKeyId: original.apiKeyId,
        email: recipient,
        emailId: original.id,
      });
      if (changed) {
        await deps.enqueueEvent(tx, "email.complained", payload, {
          apiKeyId: original.apiKeyId,
        });
      }
      return changed;
    }),
  );
  if (!suppression) {
    logger.debug("Complaint already on file, nothing to do", {
      ...linkedContext,
      recipient: redactEmail(recipient),
    });
    return { outcome: "already-complained", emailId: original.id };
  }

  logger.info("Complaint handled", {
    ...linkedContext,
    recipient: redactEmail(recipient),
    suppressionId: suppression.id,
  });
  return { outcome: "complained", emailId: original.id };
}

/**
 * Runs a complaint's transaction; a failure is logged with the email's ids
 * and thrown, so the caller can refuse the report temporarily.
 */
async function recorded<R>(
  context: { emailId: string; apiKeyId: string },
  write: () => Promise<R>,
): Promise<R> {
  try {
    return await write();
  } catch (error) {
    logger.error("Complaint not recorded: transaction rolled back", {
      emailId: context.emailId,
      apiKeyId: context.apiKeyId,
      error: loggableError(error),
    });
    throw error;
  }
}

/**
 * Looks up the email BunMail sent with this Message-ID: the stored form is
 * `<id@host>`, the parser strips the brackets, so the wrapped form is tried
 * first and the bare one second (the same lookup as the bounce handler).
 */
async function findEmailByMessageId(messageId: string): Promise<LinkedEmail | undefined> {
  const columns = {
    id: emails.id,
    apiKeyId: emails.apiKeyId,
    fromAddress: emails.fromAddress,
    toAddress: emails.toAddress,
    cc: emails.cc,
    bcc: emails.bcc,
    tags: emails.tags,
  };
  for (const candidate of [`<${messageId}>`, messageId]) {
    const [row] = await db
      .select(columns)
      .from(emails)
      .where(eq(emails.messageId, candidate))
      .limit(1);
    if (row) return row;
  }
  return undefined;
}

/**
 * DKIM verdict on the report with mailauth, bounded: no signature means no
 * lookup at all; a header section past 64 KB or more than five signatures
 * (each a DNS lookup) is `skipped`; the whole check gives up after 10 s.
 * Runs only after the report was linked to one of our emails, so an
 * unlinkable flood never reaches DNS.
 */
async function verifyReportDkim(raw: string, rawBytes: Buffer): Promise<DkimCheck> {
  const end = /\r?\n\r?\n/.exec(raw.slice(0, MAX_DKIM_HEADER_BYTES));
  if (!end) return { result: "skipped", signingDomain: null };
  const signatures =
    raw.slice(0, end.index).match(/^(?:dkim-signature|arc-message-signature)[ \t]*:/gim)
      ?.length ?? 0;
  if (signatures === 0) return { result: "none", signingDomain: null };
  if (signatures > MAX_DKIM_SIGNATURES) return { result: "skipped", signingDomain: null };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const verified = await Promise.race([
      dkimVerify(rawBytes),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), DKIM_TIMEOUT_MS);
      }),
    ]);
    if (verified === null) return { result: "temperror", signingDomain: null };
    const best =
      verified.results.find((result) => result.status.result === "pass") ??
      verified.results[0];
    return {
      result: best?.status.result ?? "none",
      signingDomain: best?.signingDomain ?? null,
    };
  } catch (error) {
    logger.warn("Feedback report DKIM check failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { result: "temperror", signingDomain: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Public entry point, called by the SMTP receiver for every message whose
 * top-level type is a `feedback-report`. The caller acknowledges the SMTP
 * transaction and stores nothing, whatever the outcome.
 */
export async function handleInboundFeedbackReport(
  raw: string,
  rawBytes: Buffer,
): Promise<HandleFeedbackResult> {
  return handleFeedbackReport<Tx>(parseFeedbackReport(raw), {
    findEmailByMessageId,
    transaction: (work) => db.transaction(work),
    addFromComplaint: (tx, input) => addFromComplaint(input, tx),
    unsubscribe,
    enqueueEvent,
    verifyDkim: () => verifyReportDkim(raw, rawBytes),
  });
}
