import type { CustomHeaderProblem } from "./services/custom-headers.ts";
import type { FromNameProblem } from "./services/from-name.ts";
import type { TagProblem } from "./services/tags.ts";
import type { AttachmentProblem } from "./services/attachments.ts";

/**
 * Rejections `email.service.createEmail` raises for a send it refuses on
 * its input (#245): the sender domain, the template, the subject or a
 * custom header (#177). Each
 * class carries its own HTTP status and stable `code`, so the global
 * `.onError` handler in `src/index.ts` maps them all with one branch
 * instead of letting them fall through to a masked 500. The SMTP
 * submission server answers every one of them with SMTP `550`.
 *
 * Messages never echo submitted content beyond the sender domain name or
 * a syntactically valid custom header name: they reach API callers,
 * dashboard flash messages and SMTP replies.
 */
export abstract class EmailSendRejectedError extends Error {
  /** HTTP status the REST API answers with. */
  abstract readonly status: 404 | 422;
  /** Stable machine-readable code, returned as `code` in the body. */
  abstract readonly code: string;
}

/**
 * The `From` domain is not registered in BunMail. Thrown in production,
 * and in any environment when `REQUIRE_VERIFIED_DOMAIN=true`; development
 * otherwise queues the send unsigned with a `domain_unregistered` warning.
 */
export class SenderDomainNotRegisteredError extends EmailSendRejectedError {
  override readonly name = "SenderDomainNotRegisteredError";
  readonly status = 422;
  readonly code = "SENDER_DOMAIN_NOT_REGISTERED";
  /** The sender domain that was refused. */
  readonly domain: string;

  constructor(domain: string) {
    super(
      `Sender domain "${domain}" is not registered. Add it via the API or dashboard before sending.`,
    );
    this.domain = domain;
  }
}

/**
 * `REQUIRE_VERIFIED_DOMAIN=true` and the `From` domain's DKIM record is
 * still not verified after one inline re-check. Mail signed with a key
 * that has no published DNS record fails DKIM at the receiver.
 */
export class SenderDomainUnverifiedError extends EmailSendRejectedError {
  override readonly name = "SenderDomainUnverifiedError";
  readonly status = 422;
  readonly code = "SENDER_DOMAIN_UNVERIFIED";
  /** The sender domain that was refused. */
  readonly domain: string;

  constructor(domain: string) {
    super(
      `Sender domain "${domain}" has no verified DKIM record. Publish the DKIM TXT record shown for the domain in the dashboard or GET /api/v1/domains/:id, then send again.`,
    );
    this.domain = domain;
  }
}

/**
 * `templateId` names no template owned by the calling API key. Another
 * key's template answers the same way, so ids can't be probed across
 * tenants.
 */
export class TemplateNotFoundError extends EmailSendRejectedError {
  override readonly name = "TemplateNotFoundError";
  readonly status = 404;
  readonly code = "TEMPLATE_NOT_FOUND";

  constructor() {
    super("Template not found.");
  }
}

/** Neither the request nor the rendered template produced a subject. */
/**
 * A message with neither an HTML nor a text body (after the template, if
 * any, is rendered): refused instead of sending an empty email (#250).
 */
export class BodyRequiredError extends EmailSendRejectedError {
  override readonly name = "BodyRequiredError";
  readonly status = 422;
  readonly code = "BODY_REQUIRED";

  constructor() {
    super("A body is required: provide html or text, inline or via a template.");
  }
}

export class SubjectRequiredError extends EmailSendRejectedError {
  override readonly name = "SubjectRequiredError";
  readonly status = 422;
  readonly code = "SUBJECT_REQUIRED";

  constructor() {
    super("Subject is required: provide it inline or via a template.");
  }
}

/**
 * A custom header (#177) breaks a rule of `services/custom-headers.ts`:
 * invalid name, a line break or control character in the value, too
 * long, reserved, duplicated, or over the count or total size cap. The
 * message names the header only when its name is valid, and never
 * includes the value.
 */
export class InvalidCustomHeaderError extends EmailSendRejectedError {
  override readonly name = "InvalidCustomHeaderError";
  readonly status = 422;
  readonly code = "INVALID_CUSTOM_HEADER";
  /** Which rule the header broke. */
  readonly problem: CustomHeaderProblem;
  /** The refused header's name, or `null` when the name itself is invalid. */
  readonly header: string | null;

  constructor(problem: CustomHeaderProblem, header: string | null, message: string) {
    super(message);
    this.problem = problem;
    this.header = header;
  }
}

/**
 * An `Idempotency-Key` (#188) the calling API key already used, within
 * `IDEMPOTENCY_KEY_TTL_HOURS`, on a request with a different body. A
 * retry must repeat the original request exactly; nothing is sent. The
 * message never echoes the key or the body. REST only: SMTP submission
 * has no idempotency keys.
 */
export class IdempotencyKeyReusedError extends EmailSendRejectedError {
  override readonly name = "IdempotencyKeyReusedError";
  readonly status = 422;
  readonly code = "IDEMPOTENCY_KEY_REUSED";

  constructor() {
    super(
      "This Idempotency-Key was already used with a different request body. Use a new key for a new request.",
    );
  }
}

/**
 * `fromName` (#250) breaks a rule of `services/from-name.ts`: empty, too
 * long, or holding a control, bidi-control or address character. Answered
 * like a request validation failure (`422 VALIDATION_ERROR`, with the
 * field in `details`), because that is what it is; the check sits in
 * `createEmail` so every ingress shares it. The message names the field,
 * never the value. SMTP submission does not raise it: it drops the name.
 */
export class InvalidFromNameError extends EmailSendRejectedError {
  override readonly name = "InvalidFromNameError";
  readonly status = 422;
  readonly code = "VALIDATION_ERROR";
  /** The refused field. */
  readonly field = "fromName";
  /** Which rule the name broke. */
  readonly problem: FromNameProblem;

  constructor(problem: FromNameProblem, message: string) {
    super(message);
    this.problem = problem;
  }
}

/**
 * A tag (#189) breaks a rule of `services/tags.ts`, in a send's `tags`
 * or in a `tag` list filter. Answered like a request validation failure
 * (`422 VALIDATION_ERROR`, `path` in `details`), as `InvalidFromNameError`
 * is. The message and the path name the tag key only when the key is
 * valid, and never include the value: tags may hold customer ids. SMTP
 * submission answers it with `550`.
 */
export class InvalidTagError extends EmailSendRejectedError {
  override readonly name = "InvalidTagError";
  readonly status = 422;
  readonly code = "VALIDATION_ERROR";
  /** Which rule the tag broke. */
  readonly problem: TagProblem;
  /** JSON pointer of the refused input: `/tags/<key>`, `/tags` or `/tag`. */
  readonly path: string;

  constructor(problem: TagProblem, path: string, message: string) {
    super(message);
    this.problem = problem;
    this.path = path;
  }
}

/**
 * `category: "marketing"` (#250) on a send that cannot carry the
 * per-recipient one-click unsubscribe link (#249): it has more than one
 * recipient (cc or bcc included), or `APP_BASE_URL` is not an https URL
 * without a query. Bulk senders must offer working one-click unsubscribe
 * (Gmail, Yahoo), so such mail is refused instead of sent without it.
 * Nothing is queued.
 */
export class MarketingRequiresOneClickError extends EmailSendRejectedError {
  override readonly name = "MarketingRequiresOneClickError";
  readonly status = 422;
  readonly code = "MARKETING_REQUIRES_ONE_CLICK";
  /** Why the link cannot be carried. */
  readonly reason: "recipients" | "app_base_url";

  constructor(reason: "recipients" | "app_base_url") {
    super(
      reason === "recipients"
        ? "Marketing email must have exactly one recipient (no cc or bcc) so it can carry a per-recipient one-click unsubscribe link."
        : "Marketing email needs APP_BASE_URL to be an https URL without a query, so it can carry a one-click unsubscribe link.",
    );
    this.reason = reason;
  }
}

/**
 * An attachment (#181) breaks an input rule of `services/attachments.ts`:
 * its filename, its `contentId`, or content that is not strict base64.
 * Answered like a request validation failure (`422 VALIDATION_ERROR`,
 * `path` in `details`), as `InvalidTagError` is. The message and the path
 * name the attachment by its index, never by its name or content. SMTP
 * submission answers it with `550`.
 */
export class InvalidAttachmentError extends EmailSendRejectedError {
  override readonly name = "InvalidAttachmentError";
  readonly status = 422;
  readonly code = "VALIDATION_ERROR";
  /** Which rule the attachment broke. */
  readonly problem: AttachmentProblem;
  /** JSON pointer of the refused input, e.g. `/attachments/2/filename`. */
  readonly path: string;

  constructor(problem: AttachmentProblem, path: string, message: string) {
    super(message);
    this.problem = problem;
    this.path = path;
  }
}

/**
 * More than `MAX_ATTACHMENTS` (10) attachments (#181). Nothing is queued.
 * SMTP submission answers it with `550`.
 */
export class TooManyAttachmentsError extends EmailSendRejectedError {
  override readonly name = "TooManyAttachmentsError";
  readonly status = 422;
  readonly code = "TOO_MANY_ATTACHMENTS";
  /** The limit. */
  readonly max: number;

  constructor(max: number) {
    super(`At most ${max} attachments per email.`);
    this.max = max;
  }
}

/**
 * The attachments, decoded, are larger together than
 * `ATTACHMENTS_MAX_TOTAL_MB` (#181), which is also the most one file may
 * have. Nothing is queued. SMTP submission answers it with `552`.
 */
export class AttachmentsTooLargeError extends EmailSendRejectedError {
  override readonly name = "AttachmentsTooLargeError";
  readonly status = 422;
  readonly code = "ATTACHMENTS_TOO_LARGE";
  /** The limit, in bytes. */
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(
      `Attachments must total at most ${maxBytes / 1_000_000} MB once decoded. For larger files, upload them to your own storage and send a link.`,
    );
    this.maxBytes = maxBytes;
  }
}

/**
 * An attachment (#181) that is an executable, a script or an installer,
 * by its extension or by its sniffed content. The message names the
 * attachment by its index, never by its name or content. Nothing is
 * queued. SMTP submission answers it with `550`.
 */
export class AttachmentTypeNotAllowedError extends EmailSendRejectedError {
  override readonly name = "AttachmentTypeNotAllowedError";
  readonly status = 422;
  readonly code = "ATTACHMENT_TYPE_NOT_ALLOWED";
  /** 0-based index of the refused attachment. */
  readonly index: number;
  /** What refused it: the filename's extension or the file's content. */
  readonly reason: "extension" | "content";

  constructor(index: number, reason: "extension" | "content") {
    super(
      `Attachment ${index} is not allowed: executable, script and installer files are refused (${reason === "extension" ? "by its extension" : "by its content"}).`,
    );
    this.index = index;
    this.reason = reason;
  }
}

/**
 * More recipients than a send may have (#178): over `MAX_TO_RECIPIENTS`
 * (50) addresses in `to` after deduplication (`field: "to"`), or over
 * `MAX_TOTAL_RECIPIENTS` (100) unique recipients across `to`, `cc` and
 * `bcc` (`field: "recipients"`). Nothing is queued. SMTP submission
 * answers it with `550`.
 */
export class TooManyRecipientsError extends EmailSendRejectedError {
  override readonly name = "TooManyRecipientsError";
  readonly status = 422;
  readonly code = "TOO_MANY_RECIPIENTS";
  /** Which cap: the `to` list, or all recipients together. */
  readonly field: "to" | "recipients";
  /** The cap. */
  readonly max: number;

  constructor(field: "to" | "recipients", max: number) {
    super(
      field === "to"
        ? `At most ${max} addresses in to.`
        : `At most ${max} unique recipients across to, cc and bcc.`,
    );
    this.field = field;
    this.max = max;
  }
}
