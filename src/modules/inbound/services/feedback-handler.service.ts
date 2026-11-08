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
 * message (its recipients, their mailbox provider) can name one. That is
 * enough for the sending key's own list, but not across keys: the tenant
 * that sent the email holds its Message-ID too. So DKIM on the report is
 * checked, and the complaint is stored as **verified** only when a
 * signature passes for one of the operator's `FEEDBACK_LOOP_DOMAINS` (see
 * {@link isVerifiedReport}); only a verified complaint is shared with the
 * other keys by `SUPPRESSIONS_SHARED_HARD`. An unverified one still
 * suppresses under the email's own key, and fires `email.complained`, as
 * before: not every provider signs its reports.
 *
 * Same shape as the bounce handler: a core (`handleFeedbackReport`) that
 * takes its side effects as callbacks for unit tests, and a wrapper
 * (`handleInboundFeedbackReport`) that wires the real ones.
 */

import { eq } from "drizzle-orm";
import { db, type Tx } from "../../../db/index.ts";
import { emails, type EmailTags } from "../../emails/models/email.schema.ts";
import { addFromComplaint } from "../../suppressions/services/suppression.service.ts";
import {
  unsubscribe,
  type UnsubscribeTarget,
} from "../../suppressions/services/unsubscribe.service.ts";
import type { AddFromComplaintInput } from "../../suppressions/types/suppression.types.ts";
import { enqueueEvent } from "../../webhooks/services/webhook-dispatch.service.ts";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { loggableError } from "../../../utils/db-error.ts";
import { parseRecipients } from "../../../utils/recipients.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { parseFeedbackReport } from "./arf-parser.service.ts";
import {
  verifyDkimSignatures,
  type DkimSignatureResult,
  type DkimVerifyDeps,
} from "./dkim-verifier.service.ts";
import { lowerAscii, signingDomainOf } from "./dkim-verifier-parse.service.ts";
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

/** DKIM verdict on the report itself: logged, and the input of {@link isVerifiedReport}. */
export interface DkimCheck {
  /** `pass`, `fail`, `neutral`, `none`, `temperror`, `permerror`, `policy`, or `skipped`. */
  result: string;
  /** `d=` of the signature the verdict is about, when there is one. */
  signingDomain: string | null;
  /**
   * The signing domain (`d=`, as a lowercase A-label) of EVERY signature
   * that passed and may vouch for the report (see {@link signatureCanVouch}),
   * in header order; empty when none did or DKIM was not checked. A report
   * may carry several signatures (its provider's and a forwarder's), and
   * any of them may be the one that makes it verified.
   */
  passingDomains: string[];
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
  /** DKIM verdict on the report (logged; decides whether the complaint is verified). */
  verifyDkim: () => Promise<DkimCheck>;
  /**
   * `FEEDBACK_LOOP_DOMAINS`, normalised: the signing domains whose passing
   * signature makes a complaint verified. Empty: nothing is verified.
   */
  feedbackLoopDomains: readonly string[];
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
 * Whether a report is a **verified** feedback-loop report: at least one of
 * its DKIM signatures passed and may vouch for it (see `signatureCanVouch`:
 * no testing-mode key, no `l=`, `h=` covering From and Content-Type)
 * and its `d=` is exactly one of `allowedDomains` (`FEEDBACK_LOOP_DOMAINS`),
 * compared without ASCII case and without a final dot. An empty allowlist
 * verifies nothing.
 *
 * A passing signature alone is not enough: anyone can sign a hand-made
 * report with a domain of their own. Only the domains the operator listed
 * (their providers' feedback-loop signers) count.
 *
 * Exact match only, no subdomains: a listed `example.net` does not accept
 * `d=fbl.example.net`. A subdomain rule would trust every name under the
 * listed one, so one mistaken entry (a two-label public suffix such as
 * `co.uk`, or a provider that hands out subdomains to its users) would let
 * anyone verify; and there is no public suffix list here to guard against
 * it. A miss only means the complaint stays per key, which is the safe
 * side, and the log line's `dkimDomain` shows the exact `d=` to list.
 */
export function isVerifiedReport(
  dkim: DkimCheck,
  allowedDomains: readonly string[],
): boolean {
  if (allowedDomains.length === 0) return false;
  const canonical = (domain: string): string =>
    lowerAscii(domain.trim()).replace(/\.$/, "");
  const allowed = new Set(allowedDomains.map(canonical));
  return dkim.passingDomains.some((domain) => allowed.has(canonical(domain)));
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

  /** Whether the complaint may be shared with other keys (see `isVerifiedReport`). */
  const verified = isVerifiedReport(dkim, deps.feedbackLoopDomains);
  const complaintContext = { ...linkedContext, verified };

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
      ...complaintContext,
      originalRcptTo: report.originalRcptTo.map((address) => redactEmail(address)),
    });
    /** No state change to commit with: the event gets a transaction of its own. */
    await recorded(complaintContext, () =>
      deps.transaction((tx) =>
        deps.enqueueEvent(tx, "email.complained", payload, {
          apiKeyId: original.apiKeyId,
        }),
      ),
    );
    return { outcome: "complained-no-recipient", emailId: original.id };
  }

  /** The suppression and its event commit together, or neither does (#184). */
  const suppression = await recorded(complaintContext, () =>
    deps.transaction(async (tx) => {
      const changed = await deps.addFromComplaint(tx, {
        apiKeyId: original.apiKeyId,
        email: recipient,
        emailId: original.id,
        verified,
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
      ...complaintContext,
      recipient: redactEmail(recipient),
    });
    return { outcome: "already-complained", emailId: original.id };
  }

  logger.info("Complaint handled", {
    ...complaintContext,
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

/** Header fields a signature must cover to vouch for a report (lowercase). */
const REQUIRED_SIGNED_HEADERS = ["from", "content-type"] as const;

/**
 * Why a PASSING signature still cannot make a report verified, or `null`
 * when it can. A pass only proves the signed parts were not changed, so
 * the signature must cover everything the handler reads:
 *
 * - its key is not in testing mode (`t=y`): RFC 6376 section 3.6.1 says a
 *   verifier must treat such a message like unsigned mail;
 * - it has no `l=` tag (body length limit), whatever length it gives:
 *   content appended after the signed part (another MIME part, or a whole
 *   new body under a changed boundary) would still verify (RFC 6376
 *   section 8.2);
 * - its `h=` covers `From` and `Content-Type`: the report's parts are
 *   found through the top-level `Content-Type` (its type and boundary), so
 *   an unsigned one could be replaced to make a different part the
 *   feedback report.
 *
 * @public Exported for its unit test only.
 */
export function signatureCanVouch(
  signature: Pick<DkimSignatureResult, "testing" | "hasLengthLimit" | "signedHeaders">,
): string | null {
  if (signature.testing) return "key in testing mode";
  if (signature.hasLengthLimit) return "body length limit (l=)";
  const signed = new Set(signature.signedHeaders.map((name) => lowerAscii(name.trim())));
  const missing = REQUIRED_SIGNED_HEADERS.filter((name) => !signed.has(name));
  return missing.length === 0 ? null : `h= does not cover ${missing.join(", ")}`;
}

/**
 * DKIM verdict on the report (`dkim-verifier.service.ts`), bounded: no
 * DKIM-Signature means no lookup at all; a header section past 64 KB or
 * more than five signatures (each a DNS lookup) is `skipped`; the whole
 * check gives up after 10 s. Runs only after the report was linked to one
 * of our emails, so an unlinkable flood never reaches DNS. ARC header
 * fields are not DKIM signatures and are not counted or verified.
 *
 * `passingDomains` lists the `d=` of every passing signature that may
 * vouch for the report ({@link signatureCanVouch}). Every way the check
 * gives up leaves the list empty.
 *
 * @public Exported for its unit test only (a signed fixture, a fixed key).
 */
export async function verifyReportDkim(
  raw: string,
  rawBytes: Buffer,
  dkimDeps: DkimVerifyDeps,
): Promise<DkimCheck> {
  const end = /\r?\n\r?\n/.exec(raw.slice(0, MAX_DKIM_HEADER_BYTES));
  if (!end) return { result: "skipped", signingDomain: null, passingDomains: [] };
  const signatures =
    raw.slice(0, end.index).match(/^dkim-signature[ \t]*:/gim)?.length ?? 0;
  if (signatures === 0)
    return { result: "none", signingDomain: null, passingDomains: [] };
  if (signatures > MAX_DKIM_SIGNATURES) {
    return { result: "skipped", signingDomain: null, passingDomains: [] };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const verified = await Promise.race([
      verifyDkimSignatures(rawBytes, dkimDeps),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), DKIM_TIMEOUT_MS);
      }),
    ]);
    if (verified === null) {
      return { result: "temperror", signingDomain: null, passingDomains: [] };
    }
    const best = verified.find((result) => result.result === "pass") ?? verified[0];
    const passingDomains: string[] = [];
    for (const result of verified) {
      if (result.result !== "pass") continue;
      const domain = signingDomainOf(result.signingDomain ?? "");
      if (domain === null) continue;
      const refusal = signatureCanVouch(result);
      if (refusal !== null) {
        logger.debug("Feedback report signature passed but cannot verify the report", {
          signingDomain: domain,
          reason: refusal,
        });
        continue;
      }
      passingDomains.push(domain);
    }
    return {
      result: best?.result ?? "none",
      signingDomain: best?.signingDomain ?? null,
      passingDomains,
    };
  } catch (error) {
    logger.warn("Feedback report DKIM check failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { result: "temperror", signingDomain: null, passingDomains: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Public entry point, called by the SMTP receiver for every message whose
 * top-level type is a `feedback-report`. The caller acknowledges the SMTP
 * transaction and stores nothing, whatever the outcome.
 *
 * @param dkimDeps - The DKIM verifier's TXT lookup and clock; the real ones
 *   unless a test passes its own (a signed fixture's key, a fixed time).
 */
export async function handleInboundFeedbackReport(
  raw: string,
  rawBytes: Buffer,
  dkimDeps: DkimVerifyDeps = {},
): Promise<HandleFeedbackResult> {
  return handleFeedbackReport<Tx>(parseFeedbackReport(raw), {
    findEmailByMessageId,
    transaction: (work) => db.transaction(work),
    addFromComplaint: (tx, input) => addFromComplaint(input, tx),
    unsubscribe,
    enqueueEvent,
    verifyDkim: () => verifyReportDkim(raw, rawBytes, dkimDeps),
    /** Read per report, so the list in effect is the current config. */
    feedbackLoopDomains: config.suppressions.feedbackLoopDomains,
  });
}
