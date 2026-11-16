import {
  AttachmentTypeNotAllowedError,
  AttachmentsTooLargeError,
  BodyRequiredError,
  EmailSendRejectedError,
  InvalidAttachmentError,
  InvalidCustomHeaderError,
  InvalidFromAddressError,
  InvalidFromNameError,
  SenderDomainNotRegisteredError,
  SenderDomainUnverifiedError,
  SubjectRequiredError,
  TooManyAttachmentsError,
  TooManyRecipientsError,
} from "../modules/emails/errors.ts";
import {
  InactiveApiKeyError,
  UnauthorizedSenderError,
} from "../modules/api-keys/errors.ts";
import { SuppressedRecipientError } from "../modules/suppressions/errors.ts";
import {
  DkimRotationError,
  DomainAlreadyRegisteredError,
  InvalidDkimSelectorError,
  InvalidDomainNameError,
} from "../modules/domains/errors.ts";
import {
  InboundEventsRequireAdminError,
  WebhookLimitReachedError,
} from "../modules/webhooks/errors.ts";
import { BlockedUrlError } from "../utils/ssrf-guard.ts";
import { BYTES_PER_MB } from "../config/smtp.ts";
import type { FlashCode } from "./lib/flash-codes.ts";
import type { Flash } from "./lib/flash.ts";

/**
 * The error flash for a failed dashboard action (#421). A redirect carries
 * a flash code, never an error's message: each refusal the app writes for
 * the user (a typed error) has its own code, and anything else (a database
 * error, whose message carries the query and its bound values, or a
 * programming error) is the action's fallback code. The full error is
 * logged by the caller, through the logger's redaction.
 *
 * What a typed error's message named (the sender domain, the header) is
 * left out: the user knows what they typed, and the URL then carries no
 * text at all. A limit travels as the numeric code's number.
 */

/** The error flash of a refused or failed send from the Send page. */
export function sendErrorFlash(error: unknown): Flash {
  if (error instanceof SenderDomainNotRegisteredError) return "send_domain_unregistered";
  if (error instanceof SenderDomainUnverifiedError) return "send_domain_unverified";
  if (error instanceof SubjectRequiredError) return "send_subject_required";
  if (error instanceof BodyRequiredError) return "send_body_required";
  if (error instanceof InvalidFromAddressError) return "send_invalid_from";
  if (error instanceof InvalidFromNameError) return "send_invalid_from_name";
  if (error instanceof InvalidCustomHeaderError) return "send_invalid_header";
  if (error instanceof TooManyRecipientsError) {
    return {
      code: error.field === "to" ? "send_too_many_to" : "send_too_many_recipients",
      n: error.max,
    };
  }
  /** Attachment refusals (#488): the form can now reach them. */
  if (error instanceof TooManyAttachmentsError) {
    return { code: "send_too_many_attachments", n: error.max };
  }
  if (error instanceof AttachmentsTooLargeError) {
    return {
      code: "send_attachments_too_large",
      n: Math.floor(error.maxBytes / BYTES_PER_MB),
    };
  }
  if (error instanceof AttachmentTypeNotAllowedError)
    return "send_attachment_type_blocked";
  if (error instanceof InvalidAttachmentError) return "send_invalid_attachment";
  if (error instanceof SuppressedRecipientError) return "send_recipient_suppressed";
  if (error instanceof UnauthorizedSenderError) return "send_sender_not_allowed";
  if (error instanceof InactiveApiKeyError) return "send_key_revoked";
  /** Any other refusal on its input: none of them is reachable from the form. */
  if (error instanceof EmailSendRejectedError) return "send_rejected";
  return "send_failed";
}

/**
 * The error flash of a refused or failed webhook create. A URL the SSRF
 * guard refuses (scheme, private or reserved address, unresolvable host)
 * gets one sentence: its message names the host, which never goes in a URL.
 */
export function webhookCreateErrorFlash(error: unknown): Flash {
  if (error instanceof BlockedUrlError) return "webhook_url_blocked";
  if (error instanceof InboundEventsRequireAdminError) return "webhook_admin_events";
  if (error instanceof WebhookLimitReachedError) {
    return { code: "webhook_limit_reached", n: error.limit };
  }
  return "webhook_create_failed";
}

/** The error flash of a refused or failed domain add. */
export function domainAddErrorFlash(error: unknown): Flash {
  if (error instanceof DomainAlreadyRegisteredError) return "domain_already_registered";
  if (error instanceof InvalidDomainNameError) return "domain_invalid_name";
  if (error instanceof InvalidDkimSelectorError) return "domain_invalid_selector";
  return "domain_add_failed";
}

/** The error flash of a refused or failed DKIM rotation step (#250). */
export function dkimRotationErrorFlash(error: unknown, fallback: FlashCode): Flash {
  if (!(error instanceof DkimRotationError)) return fallback;
  switch (error.code) {
    case "DKIM_ROTATION_PENDING":
      return "dkim_rotation_pending";
    case "DKIM_NO_PENDING_ROTATION":
      return "dkim_no_pending_rotation";
    case "DKIM_PENDING_NOT_PUBLISHED":
      return "dkim_pending_not_published";
    case "DKIM_PENDING_KEY_UNREADABLE":
      return "dkim_pending_key_unreadable";
  }
}
