import { t } from "elysia";

/**
 * Validation schema for POST /api/v1/emails/send request body.
 *
 * Elysia validates the incoming JSON against this schema before the
 * route handler runs. Invalid requests get a 422 response automatically.
 */
export const sendEmailDto = t.Object({
  /** Sender email address — must be a valid email format */
  from: t.String({ format: "email" }),

  /** Recipient email address — must be a valid email format */
  to: t.String({ format: "email" }),

  /** Optional CC recipients (comma-separated email addresses) */
  cc: t.Optional(t.String()),

  /** Optional BCC recipients (comma-separated email addresses) */
  bcc: t.Optional(t.String()),

  /** Email subject line — max 500 characters */
  subject: t.String({ maxLength: 500 }),

  /** Optional HTML body of the email */
  html: t.Optional(t.String()),

  /** Optional plain text body of the email */
  text: t.Optional(t.String()),
});
