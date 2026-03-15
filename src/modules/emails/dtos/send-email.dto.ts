import { t } from "elysia";

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
  html: t.Optional(t.String()),
  text: t.Optional(t.String()),

  /** Template-based sending — takes precedence over inline content when set */
  templateId: t.Optional(t.String()),
  variables: t.Optional(t.Record(t.String(), t.String())),
});
