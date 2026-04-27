import { t } from "elysia";

/**
 * Maximum allowed length for the HTML and text bodies of an outbound email,
 * in characters. Matches typical SaaS provider limits (SendGrid: 30MB total,
 * Resend: 5MB) — we cap each body at 5 MB so a misbehaving caller can't OOM
 * the queue or the SMTP transport.
 */
export const MAX_BODY_LENGTH = 5 * 1024 * 1024;

/**
 * Validation schema for POST /api/v1/emails/send request body.
 *
 * Supports two modes:
 * 1. Direct — provide subject, html, and/or text inline.
 * 2. Template — provide templateId + variables and the subject/body
 *    are rendered from the template.
 */
export const sendEmailDto = t.Object({
  from: t.String({ format: "email" }),
  to: t.String({ format: "email" }),
  cc: t.Optional(t.String()),
  bcc: t.Optional(t.String()),

  /** Required when not using a template */
  subject: t.Optional(t.String({ maxLength: 500 })),
  html: t.Optional(t.String({ maxLength: MAX_BODY_LENGTH })),
  text: t.Optional(t.String({ maxLength: MAX_BODY_LENGTH })),

  /** Template-based sending — takes precedence over inline content when set */
  templateId: t.Optional(t.String()),
  variables: t.Optional(t.Record(t.String(), t.String())),
});
