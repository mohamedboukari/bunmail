import type { CustomHeaderProblem } from "./services/custom-headers.ts";

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
