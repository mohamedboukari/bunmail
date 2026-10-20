import { SuppressedRecipientError } from "../../suppressions/errors.ts";
import { InactiveApiKeyError, UnauthorizedSenderError } from "../../api-keys/errors.ts";
import { TemplateTooLargeError } from "../../templates/errors.ts";
import {
  AttachmentTypeNotAllowedError,
  EmailSendRejectedError,
  InvalidAttachmentError,
  InvalidFromNameError,
  InvalidTagError,
} from "../errors.ts";

/** One validation problem in a refusal's `details`: where, and which rule. */
export interface SendErrorDetail {
  path: string;
  message: string;
}

/**
 * The body of a refused send, as `POST /api/v1/emails/send` answers it and
 * as one failed item of `POST /api/v1/emails/batch` carries it (#178).
 */
export interface SendErrorBody {
  success: false;
  error: string;
  code: string;
  /** Validation failures: the refused input's JSON pointer and the rule. */
  details?: SendErrorDetail[];
  /** `RECIPIENT_SUPPRESSED`: the caller's suppression, `null` for a shared one. */
  suppressionId?: string | null;
  /** `ATTACHMENT_TYPE_NOT_ALLOWED`: 0-based index of the refused attachment. */
  index?: number;
  /** `UNAUTHORIZED_SENDER`: the refused `From` address. */
  sender?: string;
}

/** A refusal's HTTP status and body. */
export interface SerializedSendError {
  status: number;
  body: SendErrorBody;
}

/**
 * The response for an error a send raises on its input (the suppression
 * gate, the allowed senders, a revoked key, an `EmailSendRejectedError`
 * of any kind, a template too large), or `null` for any other error,
 * which the caller treats as unexpected. Shared by the global `onError`
 * handler (`src/index.ts`) and the batch endpoint (#178), so one item of
 * a batch fails exactly as the same send would on `/send`. Messages
 * never echo submitted content beyond what each error class documents.
 */
export function serializeSendError(error: unknown): SerializedSendError | null {
  /**
   * Suppression-list rejection (#25): `suppressionId` lets the caller
   * pivot to `DELETE /api/v1/suppressions/:id`; `null` when a shared
   * suppression applied (#250), whose row belongs to another key.
   */
  if (error instanceof SuppressedRecipientError) {
    return {
      status: 422,
      body: {
        success: false,
        error: error.message,
        code: "RECIPIENT_SUPPRESSED",
        suppressionId: error.suppressionId,
      },
    };
  }

  /**
   * An invalid `fromName` (#250) is a validation failure: same code and
   * `details` shape as one TypeBox reports, naming the field only.
   */
  if (error instanceof InvalidFromNameError) {
    return {
      status: error.status,
      body: {
        success: false,
        error: "Request validation failed",
        code: error.code,
        details: [{ path: `/${error.field}`, message: error.message }],
      },
    };
  }

  /**
   * An invalid tag or tag filter (#189), or an attachment refused on its
   * input (#181): the same shape, naming the key or the index only.
   */
  if (error instanceof InvalidTagError || error instanceof InvalidAttachmentError) {
    return {
      status: error.status,
      body: {
        success: false,
        error: "Request validation failed",
        code: error.code,
        details: [{ path: error.path, message: error.message }],
      },
    };
  }

  /** An executable, script or installer attachment (#181): its index, never its name. */
  if (error instanceof AttachmentTypeNotAllowedError) {
    return {
      status: error.status,
      body: {
        success: false,
        error: error.message,
        code: error.code,
        index: error.index,
      },
    };
  }

  /**
   * Any other send refused on its input (#245): sender domain, template,
   * subject, body, custom header, recipients (#178), idempotency key reuse.
   * Each class carries its own status (404 or 422) and code.
   */
  if (error instanceof EmailSendRejectedError) {
    return {
      status: error.status,
      body: { success: false, error: error.message, code: error.code },
    };
  }

  /** Variables would make the rendered template larger than allowed. */
  if (error instanceof TemplateTooLargeError) {
    return {
      status: 422,
      body: { success: false, error: error.message, code: "TEMPLATE_OUTPUT_TOO_LARGE" },
    };
  }

  /**
   * The sending key was revoked after it was resolved (dashboard, or a
   * race with revocation): 401, as auth answers a revoked key.
   */
  if (error instanceof InactiveApiKeyError) {
    return {
      status: 401,
      body: { success: false, error: error.message, code: "API_KEY_REVOKED" },
    };
  }

  /**
   * Sender authorization (#126): the key is valid (so not 401) but may not
   * send from this `From` address.
   */
  if (error instanceof UnauthorizedSenderError) {
    return {
      status: 403,
      body: {
        success: false,
        error: error.message,
        code: "UNAUTHORIZED_SENDER",
        sender: error.sender,
      },
    };
  }

  return null;
}
