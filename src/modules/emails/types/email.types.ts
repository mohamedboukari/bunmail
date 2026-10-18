import type { emails } from "../models/email.schema.ts";
import type { InferSelectModel } from "drizzle-orm";

/** All possible statuses an email can be in during its lifecycle */
export const EMAIL_STATUSES = ["queued", "sending", "sent", "failed", "bounced"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/** Narrows a query-string value to a known status (dashboard filters). */
export function isEmailStatus(v: string | undefined): v is EmailStatus {
  return v !== undefined && (EMAIL_STATUSES as readonly string[]).includes(v);
}

/**
 * Ingress channel an email arrived through (#137):
 *   - `api`: REST `POST /api/v1/emails/send`
 *   - `smtp`: the SMTP submission server (#120)
 */
export type EmailSource = "api" | "smtp";

/**
 * The shape of an email row returned from the database.
 * Inferred directly from the Drizzle schema to stay in sync automatically.
 */
export type Email = InferSelectModel<typeof emails>;

/**
 * Input required to queue a new email for sending.
 * This is what the service layer expects: the route handler maps
 * the validated DTO body into this shape before calling the service.
 */
export interface SendEmailInput {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  /** Reply-To address(es), comma-separated (#169) */
  replyTo?: string;
  subject?: string;
  html?: string;
  text?: string;
  templateId?: string;
  variables?: Record<string, string>;
}

/**
 * Why a queued send may not authenticate at the receiver (#245), computed
 * from the sender domain's stored DNS verification flags:
 *   - `dkim_unverified` / `spf_unverified` / `dmarc_unverified`: that
 *     record of a registered domain is not verified
 *   - `domain_unregistered`: development only, the domain is not
 *     registered, so the email goes out unsigned
 */
export type SendWarning =
  "dkim_unverified" | "spf_unverified" | "dmarc_unverified" | "domain_unregistered";

/** What `createEmail` returns: the queued row and its sender-domain warnings. */
export interface CreatedEmail {
  email: Email;
  /** Empty when the sender domain is registered and fully verified. */
  warnings: SendWarning[];
}

/**
 * Filters for listing emails: used by the list endpoint.
 */
export interface ListEmailsFilters {
  /** Filter by email status (e.g. only show "sent" or "failed") */
  status?: EmailStatus;

  /** Filter by ingress channel: API vs SMTP submission (#137) */
  source?: EmailSource;

  /**
   * Filter by the sending API key (#137). Dashboard-only: the public
   * `listEmails` is already scoped to the calling key, so this is applied
   * by the unscoped `listAllEmails` path the dashboard uses.
   */
  apiKeyId?: string;

  /** Page number for pagination (1-based) */
  page: number;

  /** Number of emails per page */
  limit: number;
}
