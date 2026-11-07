import { eq, and } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import type { emails } from "../models/email.schema.ts";
import { templates } from "../../templates/models/template.schema.ts";
import {
  MAX_RENDERED_SUBJECT_LENGTH,
  renderTemplate,
} from "../../templates/services/template.service.ts";
import { isSuppressed } from "../../suppressions/services/suppression.service.ts";
import { SuppressedRecipientError } from "../../suppressions/errors.ts";
import { findById as findApiKeyById } from "../../api-keys/services/api-key.service.ts";
import { InactiveApiKeyError, UnauthorizedSenderError } from "../../api-keys/errors.ts";
import { checkSenderDomain } from "./sender-domain.service.ts";
import { validateCustomHeaders } from "./custom-headers.ts";
import { checkFromName, describeFromNameProblem } from "./from-name.ts";
import { checkTags, describeTagProblem } from "./tags.ts";
import { oneClickBlocker } from "./list-unsubscribe.ts";
import {
  InvalidCustomHeaderError,
  SubjectRequiredError,
  TemplateNotFoundError,
  BodyRequiredError,
  InvalidFromNameError,
  InvalidTagError,
  MarketingRequiresOneClickError,
  EmailSendRejectedError,
  InvalidAttachmentError,
  AttachmentTypeNotAllowedError,
  TooManyRecipientsError,
} from "../errors.ts";
import {
  joinToList,
  MAX_TO_RECIPIENTS,
  MAX_TOTAL_RECIPIENTS,
  normalizeToList,
  recipientCapProblem,
} from "./recipient-limits.ts";
import { prepareAttachments, type PreparedAttachment } from "./attachments.ts";
import { config } from "../../../config.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { parseRecipients } from "../../../utils/recipients.ts";
import type { SendEmailInput, EmailSource, SendWarning } from "../types/email.types.ts";

/** A send that passed every check, ready to insert. */
export interface PreparedEmail {
  /** The `emails` row to insert. */
  values: typeof emails.$inferInsert & { id: string };
  /** The sender-domain warnings (#245). */
  warnings: SendWarning[];
  /** The sender domain, for the warnings log line. */
  senderDomain: string | undefined;
  /** The attachments that passed every rule (#181), in order; empty when none. */
  attachments: PreparedAttachment[];
}

/**
 * Every check `createEmail` runs before it inserts (custom headers,
 * display name, tags, marketing one-click, attachments, suppression, API
 * key and allowed senders, template, subject, body, sender domain),
 * returning the row and the attachments to insert. The text alternative
 * and the HTML document wrapper (#250) are not made here: the mailer adds
 * them per send, so the row keeps what the caller sent. Throws the same
 * errors `createEmail` documents. Reads through the shared pool and
 * writes nothing.
 */
export async function prepareEmail(
  input: SendEmailInput,
  apiKeyId: string,
  source: EmailSource,
): Promise<PreparedEmail> {
  const id = generateId("msg");
  const senderDomain = input.from.split("@")[1];
  /** The `to` list (#178), normalized once: everything below reads it. */
  const toList = normalizeToList(input.to);
  const toAddress = joinToList(toList);

  /** The first recipient and the counts only: never the whole list (#178). */
  logger.info("Creating email", {
    id,
    from: redactEmail(input.from),
    to: redactEmail(toList[0]),
    toCount: toList.length,
    apiKeyId,
    attachmentCount: input.attachments?.length ?? 0,
  });

  /**
   * Recipient caps (#178), the first input rule: at most 50 addresses in
   * `to` and 100 unique recipients with `cc` and `bcc`. Every ingress
   * shares them; SMTP submission also caps `RCPT TO` at 50.
   */
  const capProblem = recipientCapProblem(toList, input.cc, input.bcc);
  if (capProblem !== null) {
    logger.warn("Send blocked: too many recipients", {
      id,
      apiKeyId,
      source,
      cap: capProblem,
      toCount: toList.length,
    });
    throw capProblem === "to"
      ? new TooManyRecipientsError("to", MAX_TO_RECIPIENTS)
      : new TooManyRecipientsError("recipients", MAX_TOTAL_RECIPIENTS);
  }

  /**
   * Custom headers (#177), checked first: it is pure input validation,
   * so a refused header costs no database work. Shared by every ingress
   * (REST, dashboard, SMTP submission) because they all call this
   * function. The log line names the header and the rule, never the value.
   */
  let headers: Record<string, string> | null = null;
  if (input.headers && Object.keys(input.headers).length > 0) {
    try {
      headers = validateCustomHeaders(input.headers);
    } catch (error) {
      if (error instanceof InvalidCustomHeaderError) {
        logger.warn("Send blocked: invalid custom header", {
          id,
          apiKeyId,
          source,
          header: error.header,
          problem: error.problem,
        });
      }
      throw error;
    }
  }

  /**
   * Display name (#250), checked with the other pure input rules. The log
   * line names the rule, never the value.
   */
  let fromName: string | null = null;
  if (input.fromName !== undefined) {
    const checked = checkFromName(input.fromName);
    if (!checked.ok) {
      logger.warn("Send blocked: invalid fromName", {
        id,
        apiKeyId,
        source,
        field: "fromName",
        problem: checked.problem,
      });
      throw new InvalidFromNameError(
        checked.problem,
        describeFromNameProblem(checked.problem),
      );
    }
    fromName = checked.name;
  }

  /**
   * Tags (#189), pure input rules too. They apply to template sends as
   * well: a template renders the content, the tags label the send. The
   * log line names the key and the rule, never the value.
   */
  let tags: Record<string, string> | null = null;
  if (input.tags && Object.keys(input.tags).length > 0) {
    const checked = checkTags(Object.entries(input.tags));
    if (!checked.ok) {
      logger.warn("Send blocked: invalid tag", {
        id,
        apiKeyId,
        source,
        field: "tags",
        tag: checked.key,
        problem: checked.problem,
      });
      throw new InvalidTagError(
        checked.problem,
        checked.key === null ? "/tags" : `/tags/${checked.key}`,
        describeTagProblem(checked, "tags"),
      );
    }
    tags = checked.tags;
  }

  /**
   * Marketing mail must carry the per-recipient one-click link (#250,
   * #249): one recipient and an https `APP_BASE_URL`. Refused before any
   * database work, so nothing is queued without it.
   */
  if (input.category === "marketing") {
    const blocker = oneClickBlocker({
      toAddress,
      cc: input.cc ?? null,
      bcc: input.bcc ?? null,
    });
    if (blocker !== null) {
      logger.warn("Send blocked: marketing email cannot carry one-click unsubscribe", {
        id,
        apiKeyId,
        source,
        reason: blocker,
      });
      throw new MarketingRequiresOneClickError(blocker);
    }
  }

  /**
   * Attachments (#181), the last input rules before any database work:
   * count, total size, filename, `contentId`, strict base64, and blocked
   * executable types by extension and by sniffed content. They apply to
   * template sends too. The log line holds the rule and the index, never
   * a filename (it may carry personal data) or any content.
   */
  let attachments: PreparedAttachment[] = [];
  if (input.attachments && input.attachments.length > 0) {
    try {
      attachments = await prepareAttachments(
        input.attachments,
        config.attachments.maxTotalBytes,
      );
    } catch (error) {
      if (error instanceof EmailSendRejectedError) {
        logger.warn("Send blocked: attachment refused", {
          id,
          apiKeyId,
          source,
          code: error.code,
          count: input.attachments.length,
          ...(error instanceof InvalidAttachmentError
            ? { path: error.path, problem: error.problem }
            : {}),
          ...(error instanceof AttachmentTypeNotAllowedError
            ? { index: error.index, reason: error.reason }
            : {}),
        });
      }
      throw error;
    }
  }

  /**
   * Suppression gate (#25). Reject sends to addresses on the per-API-key
   * suppression list (and, with `SUPPRESSIONS_SHARED_HARD=true`, the
   * shared hard suppressions, #250) before any other work: no template
   * lookup, no domain check, no INSERT into `emails`. The error class is
   * mapped to HTTP 422 by the global `onError` handler in `src/app.ts`,
   * with the `suppressionId` surfaced in the body so callers can pivot
   * directly to `DELETE /api/v1/suppressions/:id` when they want to undo
   * (`null` for a shared suppression, which is not theirs to lift).
   *
   * **Covers `to`, `cc`, and `bcc`** (#87). Pre-multi-MX, suppressed
   * CC/BCC addresses were silently dropped by the single-MX send anyway:
   * the suppression list was effective by accident. Now that
   * multi-MX delivery actually reaches CC/BCC, unchecked CC/BCC would
   * let suppressed addresses receive mail. We iterate the parsed
   * recipient list (every `to` address included, #178) and reject on the
   * first match.
   */
  const recipients = parseRecipients(toAddress, input.cc, input.bcc);
  for (const rcpt of recipients) {
    const match = await isSuppressed(apiKeyId, rcpt.address);
    if (!match) continue;
    /**
     * A shared suppression (#250) is another key's row: its id and reason
     * are neither logged nor returned, only that the address is suppressed.
     */
    const own = match.shared ? null : match.suppression;
    logger.warn("Send blocked by suppression list", {
      id,
      apiKeyId,
      recipient: redactEmail(rcpt.address),
      kind: rcpt.kind,
      suppressionId: own?.id ?? null,
      reason: own?.reason,
      shared: match.shared,
    });
    throw new SuppressedRecipientError({
      suppressionId: own?.id ?? null,
      recipient: rcpt.address,
    });
  }

  /**
   * Sender-authorization gate (#126). If the calling key carries a
   * non-empty `allowedSenders` allowlist, the message's `From` must be on
   * it, otherwise a key could spoof any identity on any registered domain
   * (DKIM-signed, so it passes auth). Empty list = unrestricted (the
   * default), so this is a no-op for keys that haven't opted in. Runs for
   * both the REST send API and the SMTP submission server, since both call
   * `createEmail`.
   */
  const key = await findApiKeyById(apiKeyId);
  /**
   * The key must still be active. REST auth already rejects revoked keys,
   * but an SMTP submission session authenticates once and then sends many
   * messages, so a key revoked mid-session would otherwise keep sending.
   */
  if (!key || !key.isActive) {
    logger.warn("Send blocked: API key revoked or missing", { id, apiKeyId });
    throw new InactiveApiKeyError();
  }
  if (key.allowedSenders.length > 0) {
    const fromLower = input.from.trim().toLowerCase();
    if (!key.allowedSenders.includes(fromLower)) {
      logger.warn("Send blocked by allowed-senders list", {
        id,
        apiKeyId,
        from: redactEmail(input.from),
      });
      throw new UnauthorizedSenderError(input.from);
    }
  }

  let subject = input.subject ?? "";
  let htmlContent = input.html ?? null;
  let textContent = input.text ?? null;

  if (input.templateId) {
    const [tpl] = await db
      .select()
      .from(templates)
      .where(and(eq(templates.id, input.templateId), eq(templates.apiKeyId, apiKeyId)));

    if (!tpl) {
      logger.warn("Send blocked: template not found", { id, apiKeyId });
      throw new TemplateNotFoundError();
    }

    const vars = input.variables ?? {};
    subject = renderTemplate(tpl.subject, vars, MAX_RENDERED_SUBJECT_LENGTH);
    /** HTML body: `{{var}}` escaped, `{{{var}}}` raw (#250). */
    htmlContent = tpl.html
      ? renderTemplate(tpl.html, vars, undefined, { html: true })
      : null;
    /** A template without a text body keeps the caller's inline text (#250). */
    textContent = tpl.textContent
      ? renderTemplate(tpl.textContent, vars)
      : (input.text ?? null);
  }

  if (!subject) {
    logger.warn("Send blocked: subject missing", { id, apiKeyId });
    throw new SubjectRequiredError();
  }

  /** Neither part has content: an empty email is refused (#250). */
  if (!htmlContent?.trim() && !textContent?.trim()) {
    logger.warn("Send blocked: body missing", { id, apiKeyId });
    throw new BodyRequiredError();
  }

  let domainId: string | null = null;
  let warnings: SendWarning[] = [];

  /**
   * Sender-domain gate (#245): registration, the opt-in
   * `REQUIRE_VERIFIED_DOMAIN` check, and the warnings for records that
   * are not verified. See `sender-domain.service.ts`.
   */
  if (senderDomain) {
    ({ domainId, warnings } = await checkSenderDomain(senderDomain, { id, apiKeyId }));
  }

  return {
    values: {
      id,
      apiKeyId,
      domainId,
      fromAddress: input.from,
      fromName,
      toAddress,
      cc: input.cc ?? null,
      bcc: input.bcc ?? null,
      replyTo: input.replyTo ?? null,
      headers,
      subject,
      html: htmlContent,
      textContent,
      source,
      category: input.category ?? null,
      tags,
    },
    warnings,
    senderDomain,
    attachments,
  };
}
