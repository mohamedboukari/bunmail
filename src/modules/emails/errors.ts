/**
 * Rejections `email.service.createEmail` raises for a send it refuses on
 * its input (#245): the sender domain, the template or the subject. Each
 * class carries its own HTTP status and stable `code`, so the global
 * `.onError` handler in `src/index.ts` maps them all with one branch
 * instead of letting them fall through to a masked 500. The SMTP
 * submission server answers every one of them with SMTP `550`.
 *
 * Messages never echo submitted content beyond the sender domain name:
 * they reach API callers, dashboard flash messages and SMTP replies.
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
export class SubjectRequiredError extends EmailSendRejectedError {
  override readonly name = "SubjectRequiredError";
  readonly status = 422;
  readonly code = "SUBJECT_REQUIRED";

  constructor() {
    super("Subject is required: provide it inline or via a template.");
  }
}
