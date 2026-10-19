import type { emails } from "../models/email.schema.ts";
import type { InferSelectModel } from "drizzle-orm";
import type { db } from "../../../db/index.ts";

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
 * What kind of mail an email is (#250), set by the caller:
 *   - `transactional`: a receipt, a password reset, an alert. Sent
 *     without `List-Unsubscribe`.
 *   - `marketing`: newsletters, promotions. Must be able to carry the
 *     per-recipient one-click unsubscribe link (#249), so the send is
 *     refused unless it has exactly one recipient and an https
 *     `APP_BASE_URL`.
 * Unset (`null` on the row): today's behaviour, `List-Unsubscribe` as
 * the domain and the recipient count allow.
 */
export const EMAIL_CATEGORIES = ["transactional", "marketing"] as const;
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

/** Narrows a stored or submitted value to a known category. */
export function isEmailCategory(v: string | null | undefined): v is EmailCategory {
  return (
    v !== null && v !== undefined && (EMAIL_CATEGORIES as readonly string[]).includes(v)
  );
}

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
  /**
   * Display name of the sender (#250), sent as `From: "<name>" <from>`.
   * Checked by `createEmail` (`services/from-name.ts`); `from` stays the
   * bare address everywhere else.
   */
  fromName?: string;
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
  /**
   * Custom headers (#177), name to value. Validated by `createEmail`
   * (`services/custom-headers.ts`); a violation throws
   * `InvalidCustomHeaderError`.
   */
  headers?: Record<string, string>;
  /** Transactional or marketing (#250); see {@link EmailCategory}. */
  category?: EmailCategory;
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

/** The transaction handle `db.transaction` passes to its callback. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Where an emails-module write runs: the shared pool or an open transaction. */
export type DbExecutor = typeof db | Tx;

/** A JSON value, as stored in a `jsonb` column and sent in a response. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** A JSON object. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * A send response before it is stored and returned (#188): the HTTP
 * status and the body the route would answer with.
 */
export interface SendResponse {
  status: number;
  body: object;
}

/**
 * What `createEmailIdempotent` returns (#188): the response to send, as
 * stored for the key, and whether it is a replay of an earlier request.
 */
export interface IdempotentSendResult {
  /** HTTP status of the (first) response. */
  status: number;
  /** Body of the (first) response, as JSON. */
  body: JsonObject;
  /** `true` when an earlier request with the same key created the email. */
  replayed: boolean;
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
