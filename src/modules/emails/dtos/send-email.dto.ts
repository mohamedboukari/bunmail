import { t } from "elysia";

/**
 * Maximum allowed length for the HTML and text bodies of an outbound email,
 * in characters. Matches typical SaaS provider limits (SendGrid: 30MB total,
 * Resend: 5MB), we cap each body at 5 MB so a misbehaving caller can't OOM
 * the queue or the SMTP transport.
 */
export const MAX_BODY_LENGTH = 5 * 1024 * 1024;

/**
 * Validation schema for POST /api/v1/emails/send request body.
 *
 * Supports two modes:
 * 1. Direct: provide subject, html, and/or text inline.
 * 2. Template: provide templateId + variables and the subject/body
 *    are rendered from the template.
 */
export const sendEmailDto = t.Object({
  from: t.String({ format: "email" }),
  to: t.String({ format: "email" }),
  /**
   * `cc`/`bcc` accept a comma-separated address list, so `format: "email"`
   * (single-address) can't be used. As header-injection defense-in-depth
   * (#133) we cap the length and reject any CR/LF: a newline in an address
   * field is the classic SMTP header-injection vector. `\r`/`\n` are matched
   * via unicode escapes so the intent is explicit. Semantic address parsing
   * still happens downstream in nodemailer.
   */
  cc: t.Optional(t.String({ maxLength: 1000, pattern: "^[^\\u000d\\u000a]*$" })),
  bcc: t.Optional(t.String({ maxLength: 1000, pattern: "^[^\\u000d\\u000a]*$" })),

  /**
   * Where replies go instead of `from` (e.g. send as no-reply@, receive at
   * support@). Comma-separated list like `cc`: RFC 5322 allows several
   * Reply-To addresses. Same length cap and CR/LF rejection (#169).
   */
  replyTo: t.Optional(t.String({ maxLength: 1000, pattern: "^[^\\u000d\\u000a]*$" })),

  /** Required when not using a template. CR/LF rejected (header injection). */
  subject: t.Optional(t.String({ maxLength: 500, pattern: "^[^\\u000d\\u000a]*$" })),
  html: t.Optional(t.String({ maxLength: MAX_BODY_LENGTH })),
  text: t.Optional(t.String({ maxLength: MAX_BODY_LENGTH })),

  /** Template-based sending: takes precedence over inline content when set */
  templateId: t.Optional(t.String()),
  /** At most 100 variables, names up to 100 and values up to 100 KB long:
   *  the rendered output is also capped (see renderTemplate). */
  variables: t.Optional(
    t.Record(t.String({ maxLength: 100 }), t.String({ maxLength: 100_000 }), {
      maxProperties: 100,
    }),
  ),

  /**
   * Custom headers (#177), name to value. Syntax is checked here: a name is
   * 1 to 64 printable ASCII characters without a colon (RFC 5322 field
   * name; `additionalProperties: false` makes any other key a validation
   * error instead of a silently ignored one), a value has no CR, LF, NUL
   * or other control character except HTAB and is at most 998 characters,
   * at most 20 headers. Reserved names, case-insensitive duplicates and
   * the 8 KB total cap are enforced by `createEmail`
   * (`services/custom-headers.ts`), which every send path shares.
   */
  headers: t.Optional(
    t.Record(
      t.String({ pattern: "^[\\x21-\\x39\\x3b-\\x7e]{1,64}$" }),
      t.String({
        maxLength: 998,
        pattern: "^[^\\u0000-\\u0008\\u000a-\\u001f\\u007f-\\u009f\\u2028\\u2029]*$",
      }),
      { maxProperties: 20, additionalProperties: false },
    ),
  ),
});

/**
 * Valid `Idempotency-Key` header values (#188): 1 to 255 printable ASCII
 * characters (0x21 to 0x7E), so no spaces and no control characters. A
 * repeated header arrives joined with ", " and fails the pattern.
 */
const IDEMPOTENCY_KEY_PATTERN = "^[\\x21-\\x7e]{1,255}$";

/**
 * Request headers of POST /api/v1/emails/send that are validated: the
 * optional `Idempotency-Key` (#188, draft-ietf-httpapi-idempotency-key-header).
 * Elysia lower-cases header names; other headers pass through unchecked.
 */
export const sendEmailHeadersDto = t.Object(
  {
    "idempotency-key": t.Optional(
      t.String({
        pattern: IDEMPOTENCY_KEY_PATTERN,
        description:
          "Makes the send safe to retry: a repeat with the same key and body within IDEMPOTENCY_KEY_TTL_HOURS (default 24) creates nothing and returns the first response with `Idempotent-Replayed: true`; the same key with another body is refused with 422 IDEMPOTENCY_KEY_REUSED. 1 to 255 printable ASCII characters, no spaces. Scoped to the API key.",
      }),
    ),
  },
  { additionalProperties: true },
);
