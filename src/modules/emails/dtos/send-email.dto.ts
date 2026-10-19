import { t } from "elysia";

/**
 * Maximum allowed length for the HTML and text bodies of an outbound email,
 * in characters. Matches typical SaaS provider limits (SendGrid: 30MB total,
 * Resend: 5MB), we cap each body at 5 MB so a misbehaving caller can't OOM
 * the queue or the SMTP transport.
 */
export const MAX_BODY_LENGTH = 5 * 1024 * 1024;

/**
 * Longest `content` of one attachment, in base64 characters (#181): the
 * base64 of the largest budget `ATTACHMENTS_MAX_TOTAL_MB` allows, 18 MB of
 * 1,000,000 bytes (a unit test keeps the two in step). A literal, not
 * read from `config.ts`: the DTO must load under the partial config stubs
 * of the e2e tests. The configured budget is enforced on the decoded size
 * by `createEmail`.
 */
export const MAX_ATTACHMENT_BASE64_LENGTH = 24_000_000;

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
  /**
   * Sender display name (#250): `From: "<fromName>" <from>`. Only the
   * type and a raw length cap are checked here; the rules (1 to 100
   * characters after trimming, no control, bidi-control or `@ < > "`
   * character) are applied by `createEmail` (`services/from-name.ts`),
   * which answers `422 VALIDATION_ERROR` naming the field.
   */
  fromName: t.Optional(
    t.String({
      maxLength: 1000,
      description:
        'Sender display name, shown instead of the address by most clients. 1 to 100 characters after trimming; control and bidi-control characters and any of @ < > " are refused (422 VALIDATION_ERROR).',
    }),
  ),
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
  /**
   * What kind of mail this is (#250). `transactional`: sent without
   * `List-Unsubscribe`. `marketing`: must carry the per-recipient
   * one-click unsubscribe link (#249), so it is refused with
   * `422 MARKETING_REQUIRES_ONE_CLICK` unless it has exactly one recipient
   * (no cc or bcc) and `APP_BASE_URL` is an https URL. Unset: as before.
   */
  category: t.Optional(
    t.Union([t.Literal("transactional"), t.Literal("marketing")], {
      description:
        "transactional: no List-Unsubscribe header. marketing: requires one recipient and an https APP_BASE_URL so the per-recipient one-click unsubscribe link can be added (else 422 MARKETING_REQUIRES_ONE_CLICK).",
    }),
  ),

  /**
   * Labels (#189), key to value. Only the type and raw caps are checked
   * here; the rules (at most 10, keys `^[A-Za-z0-9_-]{1,40}$` unique
   * ignoring case, values of 1 to 256 characters after trimming with no
   * control or bidi-control character) are applied by `createEmail`
   * (`services/tags.ts`), which answers `422 VALIDATION_ERROR` naming
   * the key, never the value.
   */
  tags: t.Optional(
    t.Record(t.String({ maxLength: 100 }), t.String({ maxLength: 1024 }), {
      maxProperties: 100,
      description:
        "Labels for filtering (GET /api/v1/emails?tag=key:value) and webhook routing, never sent to the recipient. At most 10; keys are 1 to 40 characters of A-Z a-z 0-9 _ - (unique ignoring case); values are 1 to 256 characters after trimming, without control or bidi-control characters (else 422 VALIDATION_ERROR).",
    }),
  ),

  /**
   * Attachments (#181), Resend-compatible. Only the shape and raw caps are
   * checked here, so a send over a rule gets that rule's code rather than
   * a generic validation error: `createEmail` (`services/attachments.ts`)
   * refuses more than 10 (`422 TOO_MANY_ATTACHMENTS`), more than
   * `ATTACHMENTS_MAX_TOTAL_MB` decoded (`422 ATTACHMENTS_TOO_LARGE`), a bad
   * filename, `contentId` or base64 (`422 VALIDATION_ERROR` at
   * `/attachments/<i>/<field>`), and executables, scripts and installers
   * by extension or sniffed content (`422 ATTACHMENT_TYPE_NOT_ALLOWED`).
   * `content` is capped at the base64 of the largest allowed budget (18
   * MB); the HTTP body limit refuses a larger body before it is parsed.
   */
  attachments: t.Optional(
    t.Array(
      t.Object({
        filename: t.String({
          maxLength: 1024,
          description:
            "1 to 255 characters after trimming; no control or bidi-control characters, no / or \\, not only dots.",
        }),
        content: t.String({
          maxLength: MAX_ATTACHMENT_BASE64_LENGTH,
          description:
            "The file, as standard padded base64 (no whitespace, no line breaks).",
        }),
        contentType: t.Optional(
          t.String({
            maxLength: 255,
            description:
              "Accepted for compatibility and ignored: the type sent is derived from the file's bytes, else a few text extensions, else application/octet-stream.",
          }),
        ),
        contentId: t.Optional(
          t.String({
            maxLength: 1024,
            description:
              "Content-ID for an inline image referenced as cid:<contentId> in the HTML: 1 to 128 characters of A-Z a-z 0-9 . _ % + -, optionally followed by @ and a domain.",
          }),
        ),
      }),
      {
        maxItems: 100,
        description:
          "Files to attach: at most 10, at most ATTACHMENTS_MAX_TOTAL_MB (default 5) decoded in total. Executables, scripts and installers are refused (422 ATTACHMENT_TYPE_NOT_ALLOWED). For larger files, upload them to your own storage and send a link.",
      },
    ),
  ),

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
