import { eq, desc, and, sql, inArray, isNull, isNotNull } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../models/email.schema.ts";
import { templates } from "../../templates/models/template.schema.ts";
import {
  MAX_RENDERED_SUBJECT_LENGTH,
  renderTemplate,
} from "../../templates/services/template.service.ts";
import { isSuppressed } from "../../suppressions/services/suppression.service.ts";
import { SuppressedRecipientError } from "../../suppressions/errors.ts";
import { findById as findApiKeyById } from "../../api-keys/services/api-key.service.ts";
import { InactiveApiKeyError, UnauthorizedSenderError } from "../../api-keys/errors.ts";
import { deleteEmailsWithTombstones } from "./tombstone.service.ts";
import { checkSenderDomain } from "./sender-domain.service.ts";
import { validateCustomHeaders } from "./custom-headers.ts";
import { checkFromName, describeFromNameProblem } from "./from-name.ts";
import {
  checkTags,
  describeTagProblem,
  parseTagFilters,
  type TagFilter,
} from "./tags.ts";
import { oneClickBlocker } from "./list-unsubscribe.ts";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  findIdempotencyRecord,
  findReplayContent,
  hashSendRequest,
  toJsonObject,
  withContent,
  withoutContent,
  type IdempotencyRecord,
} from "./idempotency.service.ts";
import {
  InvalidCustomHeaderError,
  SubjectRequiredError,
  TemplateNotFoundError,
  BodyRequiredError,
  IdempotencyKeyReusedError,
  InvalidFromNameError,
  InvalidTagError,
  MarketingRequiresOneClickError,
  AttachmentsNotSupportedError,
} from "../errors.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { parseRecipients } from "../../../utils/recipients.ts";
import type {
  SendEmailInput,
  ListEmailsFilters,
  Email,
  EmailSource,
  CreatedEmail,
  SendWarning,
  DbExecutor,
  SendResponse,
  IdempotentSendResult,
} from "../types/email.types.ts";

/**
 * Creates a new email record in the database with status `queued`.
 *
 * Supports two modes:
 * 1. Direct content: subject, html, text provided inline.
 * 2. Template: templateId + variables resolved from the templates table.
 *
 * Also links the sender's domain for DKIM signing and returns, next to
 * the row, a warning per sender-domain DNS record that is not verified
 * (#245): the REST response and the dashboard show them to the sender.
 * Input it refuses throws an `EmailSendRejectedError` subclass
 * (`../errors.ts`), never a plain `Error`, so callers get a 4xx with a
 * stable code instead of a masked 500.
 */
export async function createEmail(
  input: SendEmailInput,
  apiKeyId: string,
  /** Ingress channel (#137). REST callers use the default; the SMTP
   *  submission server passes `"smtp"`. */
  source: EmailSource = "api",
): Promise<CreatedEmail> {
  const prepared = await prepareEmail(input, apiKeyId, source);
  return insertPreparedEmail(db, prepared);
}

/**
 * Creates an email like `createEmail` (REST, `source = "api"`), under an
 * `Idempotency-Key` (#188). The first request with a key creates the
 * email and stores `buildResponse`'s result for the key; a retry with the
 * same key and the same body (compared as canonical JSON, so key order
 * does not matter) creates nothing and gets that stored response back,
 * `replayed: true`. The same key with another body throws
 * `IdempotencyKeyReusedError`. Keys are scoped to the API key and live
 * `IDEMPOTENCY_KEY_TTL_HOURS`; an expired key is reusable.
 *
 * Flow:
 * 1. A live row for the key answers at once (replay or refusal), before
 *    the send is checked: a replay returns the original result even if,
 *    say, the recipient was suppressed since.
 * 2. Otherwise the send is checked (`prepareEmail`) outside any
 *    transaction, so a refused send stores nothing and holds no
 *    connection or lock while it reads.
 * 3. One transaction claims the key first (`claimIdempotencyKey`), then
 *    inserts the email and completes the key row with the response. A
 *    concurrent request with the same key waits on the unique index
 *    until this one commits, then replays the committed row. Inside the
 *    transaction every query runs on the transaction's own connection,
 *    so the waiting requests can never starve the one they wait for.
 *
 * The response body is stored without message content (subject, html,
 * text, custom headers): a replay fills those from the live email, or
 * answers them `null` once it is trashed or purged, so deleting an email
 * removes its content everywhere.
 */
export async function createEmailIdempotent(
  input: SendEmailInput,
  apiKeyId: string,
  idempotencyKey: string,
  buildResponse: (created: CreatedEmail) => SendResponse,
): Promise<IdempotentSendResult> {
  const requestHash = hashSendRequest(input);
  /** Never the key itself: its length is enough to correlate while debugging. */
  logger.debug("Send with idempotency key", {
    apiKeyId,
    idempotencyKeyLength: idempotencyKey.length,
  });

  const live = await findIdempotencyRecord(db, apiKeyId, idempotencyKey, {
    liveOnly: true,
  });
  if (live) return replayIdempotentSend(db, live, requestHash, apiKeyId);

  const prepared = await prepareEmail(input, apiKeyId, "api");

  return db.transaction(async (tx): Promise<IdempotentSendResult> => {
    /**
     * Two rounds at most: a claim can only lose to a committed live row,
     * which the read below then finds. The second round covers that row
     * vanishing in between (deleted with its API key, or purged at the
     * instant it expired).
     */
    for (let round = 0; round < 2; round += 1) {
      const claimedId = await claimIdempotencyKey(tx, {
        apiKeyId,
        key: idempotencyKey,
        requestHash,
      });
      if (claimedId !== null) {
        const created = await insertPreparedEmail(tx, prepared);
        const response = buildResponse(created);
        const body = toJsonObject(response.body);
        /** Stored without message content (see `withoutContent`). */
        await completeIdempotencyKey(tx, claimedId, {
          emailId: created.email.id,
          status: response.status,
          body: withoutContent(body),
        });
        logger.debug("Idempotency key stored", { apiKeyId, emailId: created.email.id });
        return { status: response.status, body, replayed: false };
      }

      const winner = await findIdempotencyRecord(tx, apiKeyId, idempotencyKey, {
        liveOnly: false,
      });
      if (winner) return replayIdempotentSend(tx, winner, requestHash, apiKeyId);
    }

    logger.error("Idempotency key could not be claimed or read", { apiKeyId });
    throw new Error("Idempotency key could not be claimed");
  });
}

/**
 * The answer for a key that already has a committed row: the stored
 * response when the body matches, `IdempotencyKeyReusedError` when not.
 * The stored body holds no message content; it is filled from the live
 * email (one read by its primary key, scoped to `apiKeyId`, excluding
 * trash), or set to `null` once the email is trashed or purged.
 */
async function replayIdempotentSend(
  executor: DbExecutor,
  record: IdempotencyRecord,
  requestHash: string,
  apiKeyId: string,
): Promise<IdempotentSendResult> {
  if (record.requestHash !== requestHash) {
    logger.warn("Send refused: idempotency key reused with a different body", {
      apiKeyId,
      emailId: record.emailId,
    });
    throw new IdempotencyKeyReusedError();
  }
  /** A committed row is completed in the transaction that created it. */
  if (record.responseStatus === null || record.responseBody === null) {
    logger.error("Idempotency key row has no stored response", {
      apiKeyId,
      emailId: record.emailId,
    });
    throw new Error("Idempotency key row has no stored response");
  }
  const content = await findReplayContent(executor, record.emailId, apiKeyId);
  logger.info("Send replayed from idempotency key", {
    apiKeyId,
    emailId: record.emailId,
    contentAvailable: content !== null,
  });
  return {
    status: record.responseStatus,
    body: withContent(record.responseBody, content),
    replayed: true,
  };
}

/** A send that passed every check, ready to insert. */
interface PreparedEmail {
  /** The `emails` row to insert. */
  values: typeof emails.$inferInsert & { id: string };
  /** The sender-domain warnings (#245). */
  warnings: SendWarning[];
  /** The sender domain, for the warnings log line. */
  senderDomain: string | undefined;
}

/**
 * Every check `createEmail` runs before it inserts (custom headers,
 * display name, marketing one-click, suppression, API key and allowed
 * senders, template, subject, body, sender domain), returning the row to
 * insert. The text alternative and the HTML document wrapper (#250) are
 * not made here: the mailer adds them per send, so the row keeps what the
 * caller sent. Throws the same errors
 * `createEmail` documents. Reads through the shared pool and writes
 * nothing.
 */
async function prepareEmail(
  input: SendEmailInput,
  apiKeyId: string,
  source: EmailSource,
): Promise<PreparedEmail> {
  const id = generateId("msg");
  const senderDomain = input.from.split("@")[1];

  logger.info("Creating email", {
    id,
    from: redactEmail(input.from),
    to: redactEmail(input.to),
    apiKeyId,
  });

  /**
   * Attachments are not supported (#250): a body that carries the
   * property at all, whatever its value, is refused before anything else
   * rather than queued without them. Pure input validation, no database
   * work. The log line names no file and holds no content.
   */
  if (input.attachments !== undefined) {
    logger.warn("Send blocked: attachments not supported", { id, apiKeyId, source });
    throw new AttachmentsNotSupportedError();
  }

  /**
   * Custom headers (#177), checked next: it is pure input validation,
   * so a refused header costs no database work. Shared by every ingress
   * (REST, dashboard, SMTP submission) because they all call this
   * function. The log line names the header and the rule, never the value.
   */
  let headers: Record<string, string> | null = null;
  if (input.headers && Object.keys(input.headers).length > 0) {
    try {
      headers = validateCustomHeaders(input.headers);
    } catch (error) {
      if (error instanceof InvalidCustomHeaderError) {
        logger.warn("Send blocked: invalid custom header", {
          id,
          apiKeyId,
          source,
          header: error.header,
          problem: error.problem,
        });
      }
      throw error;
    }
  }

  /**
   * Display name (#250), checked with the other pure input rules. The log
   * line names the rule, never the value.
   */
  let fromName: string | null = null;
  if (input.fromName !== undefined) {
    const checked = checkFromName(input.fromName);
    if (!checked.ok) {
      logger.warn("Send blocked: invalid fromName", {
        id,
        apiKeyId,
        source,
        field: "fromName",
        problem: checked.problem,
      });
      throw new InvalidFromNameError(
        checked.problem,
        describeFromNameProblem(checked.problem),
      );
    }
    fromName = checked.name;
  }

  /**
   * Tags (#189), pure input rules too. They apply to template sends as
   * well: a template renders the content, the tags label the send. The
   * log line names the key and the rule, never the value.
   */
  let tags: Record<string, string> | null = null;
  if (input.tags && Object.keys(input.tags).length > 0) {
    const checked = checkTags(Object.entries(input.tags));
    if (!checked.ok) {
      logger.warn("Send blocked: invalid tag", {
        id,
        apiKeyId,
        source,
        field: "tags",
        tag: checked.key,
        problem: checked.problem,
      });
      throw new InvalidTagError(
        checked.problem,
        checked.key === null ? "/tags" : `/tags/${checked.key}`,
        describeTagProblem(checked, "tags"),
      );
    }
    tags = checked.tags;
  }

  /**
   * Marketing mail must carry the per-recipient one-click link (#250,
   * #249): one recipient and an https `APP_BASE_URL`. Refused before any
   * database work, so nothing is queued without it.
   */
  if (input.category === "marketing") {
    const blocker = oneClickBlocker({
      toAddress: input.to,
      cc: input.cc ?? null,
      bcc: input.bcc ?? null,
    });
    if (blocker !== null) {
      logger.warn("Send blocked: marketing email cannot carry one-click unsubscribe", {
        id,
        apiKeyId,
        source,
        reason: blocker,
      });
      throw new MarketingRequiresOneClickError(blocker);
    }
  }

  /**
   * Suppression gate (#25). Reject sends to addresses on the per-API-key
   * suppression list (and, with `SUPPRESSIONS_SHARED_HARD=true`, the
   * shared hard suppressions, #250) before any other work: no template
   * lookup, no domain check, no INSERT into `emails`. The error class is
   * mapped to HTTP 422 by the global `onError` handler in `src/index.ts`,
   * with the `suppressionId` surfaced in the body so callers can pivot
   * directly to `DELETE /api/v1/suppressions/:id` when they want to undo
   * (`null` for a shared suppression, which is not theirs to lift).
   *
   * **Covers `to`, `cc`, and `bcc`** (#87). Pre-multi-MX, suppressed
   * CC/BCC addresses were silently dropped by the single-MX send anyway:
   * the suppression list was effective by accident. Now that
   * multi-MX delivery actually reaches CC/BCC, unchecked CC/BCC would
   * let suppressed addresses receive mail. We iterate the parsed
   * recipient list and reject on the first match.
   */
  const recipients = parseRecipients(input.to, input.cc, input.bcc);
  for (const rcpt of recipients) {
    const match = await isSuppressed(apiKeyId, rcpt.address);
    if (!match) continue;
    /**
     * A shared suppression (#250) is another key's row: its id and reason
     * are neither logged nor returned, only that the address is suppressed.
     */
    const own = match.shared ? null : match.suppression;
    logger.warn("Send blocked by suppression list", {
      id,
      apiKeyId,
      recipient: redactEmail(rcpt.address),
      kind: rcpt.kind,
      suppressionId: own?.id ?? null,
      reason: own?.reason,
      shared: match.shared,
    });
    throw new SuppressedRecipientError({
      suppressionId: own?.id ?? null,
      recipient: rcpt.address,
    });
  }

  /**
   * Sender-authorization gate (#126). If the calling key carries a
   * non-empty `allowedSenders` allowlist, the message's `From` must be on
   * it, otherwise a key could spoof any identity on any registered domain
   * (DKIM-signed, so it passes auth). Empty list = unrestricted (the
   * default), so this is a no-op for keys that haven't opted in. Runs for
   * both the REST send API and the SMTP submission server, since both call
   * `createEmail`.
   */
  const key = await findApiKeyById(apiKeyId);
  /**
   * The key must still be active. REST auth already rejects revoked keys,
   * but an SMTP submission session authenticates once and then sends many
   * messages, so a key revoked mid-session would otherwise keep sending.
   */
  if (!key || !key.isActive) {
    logger.warn("Send blocked: API key revoked or missing", { id, apiKeyId });
    throw new InactiveApiKeyError();
  }
  if (key.allowedSenders.length > 0) {
    const fromLower = input.from.trim().toLowerCase();
    if (!key.allowedSenders.includes(fromLower)) {
      logger.warn("Send blocked by allowed-senders list", {
        id,
        apiKeyId,
        from: redactEmail(input.from),
      });
      throw new UnauthorizedSenderError(input.from);
    }
  }

  let subject = input.subject ?? "";
  let htmlContent = input.html ?? null;
  let textContent = input.text ?? null;

  if (input.templateId) {
    const [tpl] = await db
      .select()
      .from(templates)
      .where(and(eq(templates.id, input.templateId), eq(templates.apiKeyId, apiKeyId)));

    if (!tpl) {
      logger.warn("Send blocked: template not found", { id, apiKeyId });
      throw new TemplateNotFoundError();
    }

    const vars = input.variables ?? {};
    subject = renderTemplate(tpl.subject, vars, MAX_RENDERED_SUBJECT_LENGTH);
    /** HTML body: `{{var}}` escaped, `{{{var}}}` raw (#250). */
    htmlContent = tpl.html
      ? renderTemplate(tpl.html, vars, undefined, { html: true })
      : null;
    /** A template without a text body keeps the caller's inline text (#250). */
    textContent = tpl.textContent
      ? renderTemplate(tpl.textContent, vars)
      : (input.text ?? null);
  }

  if (!subject) {
    logger.warn("Send blocked: subject missing", { id, apiKeyId });
    throw new SubjectRequiredError();
  }

  /** Neither part has content: an empty email is refused (#250). */
  if (!htmlContent?.trim() && !textContent?.trim()) {
    logger.warn("Send blocked: body missing", { id, apiKeyId });
    throw new BodyRequiredError();
  }

  let domainId: string | null = null;
  let warnings: SendWarning[] = [];

  /**
   * Sender-domain gate (#245): registration, the opt-in
   * `REQUIRE_VERIFIED_DOMAIN` check, and the warnings for records that
   * are not verified. See `sender-domain.service.ts`.
   */
  if (senderDomain) {
    ({ domainId, warnings } = await checkSenderDomain(senderDomain, { id, apiKeyId }));
  }

  return {
    values: {
      id,
      apiKeyId,
      domainId,
      fromAddress: input.from,
      fromName,
      toAddress: input.to,
      cc: input.cc ?? null,
      bcc: input.bcc ?? null,
      replyTo: input.replyTo ?? null,
      headers,
      subject,
      html: htmlContent,
      textContent,
      source,
      category: input.category ?? null,
      tags,
    },
    warnings,
    senderDomain,
  };
}

/**
 * Inserts a prepared send with status `queued`, through `executor` (the
 * pool, or the idempotent send's transaction), and logs it.
 */
async function insertPreparedEmail(
  executor: DbExecutor,
  prepared: PreparedEmail,
): Promise<CreatedEmail> {
  const { values, warnings, senderDomain } = prepared;
  const { id, apiKeyId, source, domainId, headers, tags } = values;
  const [email] = await executor.insert(emails).values(values).returning();

  logger.debug("Email created and queued", {
    id,
    status: email!.status,
    domainId,
    customHeaders: headers ? Object.keys(headers) : [],
    /** Keys only: tag values may hold customer ids (#189). */
    tagKeys: tags ? Object.keys(tags) : [],
  });

  /**
   * One line per send that may fail authentication at the receiver. The
   * REST and dashboard callers also show the warnings; SMTP submission
   * has no channel for them, so this line is its only trace.
   */
  if (warnings.length > 0) {
    logger.warn("Email queued from a sender domain with unverified DNS records", {
      id,
      apiKeyId,
      source,
      domain: senderDomain,
      warnings,
    });
  }

  return { email: email!, warnings };
}

/**
 * Retrieves a single email by its ID, scoped to the requesting API key.
 *
 * The apiKeyId filter ensures users can only access emails they created:
 * prevents cross-tenant data leakage.
 *
 * @param id - The email ID (e.g. "msg_a1b2c3...")
 * @param apiKeyId - The authenticated API key ID (scope filter)
 * @returns The email row, or undefined if not found or not owned by this key
 */
export async function getEmailById(
  id: string,
  apiKeyId: string,
): Promise<Email | undefined> {
  logger.debug("Fetching email by ID", { id, apiKeyId });

  /** Excludes trashed rows: they're only accessible via the trash endpoints */
  const [email] = await db
    .select()
    .from(emails)
    .where(
      and(eq(emails.id, id), eq(emails.apiKeyId, apiKeyId), isNull(emails.deletedAt)),
    );

  if (!email) {
    logger.debug("Email not found", { id, apiKeyId });
  }

  return email;
}

/**
 * One containment condition per tag filter (#189), so an email must carry
 * them all (AND). The jsonb value is built in SQL from two text
 * parameters: a stringified `::jsonb` parameter would be bound as a jsonb
 * string by bun-sql and match nothing (#261). `@>` is what the GIN index
 * `idx_emails_tags` (`jsonb_path_ops`) serves.
 */
function tagClauses(filters: TagFilter[] | undefined) {
  return (filters ?? []).map(
    ({ key, value }) =>
      sql`${emails.tags} @> jsonb_build_object(${key}::text, ${value}::text)`,
  );
}

/** List filters as logged: tag keys only, never values (#189). */
function loggableFilters(filters: ListEmailsFilters) {
  const { tags, ...rest } = filters;
  return { ...rest, tagKeys: tags?.map((t) => t.key) };
}

/**
 * Checks the raw `tag` filters of a list request (#189) and returns them,
 * or logs the refusal (key and rule only) and throws `InvalidTagError`
 * (`422 VALIDATION_ERROR`, path `/tag`).
 */
export function checkTagFilters(raws: readonly string[], apiKeyId: string): TagFilter[] {
  const parsed = parseTagFilters(raws);
  if (parsed.ok) return parsed.filters;
  logger.warn("Email list refused: invalid tag filter", {
    apiKeyId,
    tag: parsed.key,
    problem: parsed.problem,
  });
  throw new InvalidTagError(
    parsed.problem,
    "/tag",
    describeTagProblem(parsed, "tag filter"),
  );
}

/**
 * Lists emails for a given API key with pagination and optional status filter.
 *
 * Returns the matching emails (newest first) plus a total count for
 * building pagination UI.
 *
 * @param apiKeyId - Only show emails created with this API key
 * @param filters - Pagination (page, limit) and optional status filter
 * @returns Object with `data` (email rows) and `total` (count for pagination)
 */
export async function listEmails(
  apiKeyId: string,
  filters: ListEmailsFilters,
): Promise<{ data: Email[]; total: number }> {
  /** Calculate how many rows to skip based on page number */
  const offset = (filters.page - 1) * filters.limit;

  logger.debug("Listing emails", { apiKeyId, ...loggableFilters(filters), offset });

  /**
   * Build the WHERE clause: always filter by API key + exclude trashed,
   * optionally by status and/or source (#137). The `apiKeyId` *filter*
   * doesn't apply here: this list is already scoped to the calling key.
   */
  const clauses = [eq(emails.apiKeyId, apiKeyId), isNull(emails.deletedAt)];
  if (filters.status) clauses.push(eq(emails.status, filters.status));
  if (filters.source) clauses.push(eq(emails.source, filters.source));
  clauses.push(...tagClauses(filters.tags));
  const conditions = and(...clauses);

  /** Run data query and count query in parallel for better performance */
  const [data, [countRow]] = await Promise.all([
    db
      .select()
      .from(emails)
      .where(conditions)
      .orderBy(desc(emails.createdAt))
      .limit(filters.limit)
      .offset(offset),

    db
      .select({ count: sql<number>`count(*)::int` })
      .from(emails)
      .where(conditions),
  ]);

  const total = countRow?.count ?? 0;

  logger.debug("Emails listed", { apiKeyId, returned: data.length, total });

  return { data, total };
}

/**
 * Lists all emails without API key scoping: used by the dashboard.
 *
 * Same as `listEmails` but doesn't filter by apiKeyId, giving a global
 * view of all emails across all API keys.
 *
 * @param filters - Pagination (page, limit) and optional status filter
 * @returns Object with `data` (email rows) and `total` (count for pagination)
 */
export async function listAllEmails(
  filters: ListEmailsFilters,
): Promise<{ data: Email[]; total: number }> {
  const offset = (filters.page - 1) * filters.limit;

  logger.debug("Listing all emails (unscoped)", { ...loggableFilters(filters), offset });

  /**
   * Build WHERE clause: exclude trashed; optionally filter by status,
   * source, and (dashboard-only) the sending API key (#137).
   */
  const clauses = [isNull(emails.deletedAt)];
  if (filters.status) clauses.push(eq(emails.status, filters.status));
  if (filters.source) clauses.push(eq(emails.source, filters.source));
  if (filters.apiKeyId) clauses.push(eq(emails.apiKeyId, filters.apiKeyId));
  clauses.push(...tagClauses(filters.tags));
  const conditions = and(...clauses);

  const [data, [countRow]] = await Promise.all([
    db
      .select()
      .from(emails)
      .where(conditions)
      .orderBy(desc(emails.createdAt))
      .limit(filters.limit)
      .offset(offset),

    db
      .select({ count: sql<number>`count(*)::int` })
      .from(emails)
      .where(conditions),
  ]);

  const total = countRow?.count ?? 0;

  logger.debug("All emails listed", { returned: data.length, total });

  return { data, total };
}

/**
 * Retrieves a single email by its ID without API key scoping: used by the dashboard.
 *
 * Unlike `getEmailById`, this doesn't check ownership, giving dashboard
 * admins access to any email regardless of which API key sent it.
 *
 * @param id - The email ID (e.g. "msg_a1b2c3...")
 * @returns The email row, or undefined if not found
 */
export async function getEmailByIdUnscoped(id: string): Promise<Email | undefined> {
  logger.debug("Fetching email by ID (unscoped)", { id });

  /** Excludes trashed rows: dashboard hits separate trash endpoints */
  const [email] = await db
    .select()
    .from(emails)
    .where(and(eq(emails.id, id), isNull(emails.deletedAt)));

  if (!email) {
    logger.debug("Email not found (unscoped)", { id });
  }

  return email;
}

/* ─── Trash / Soft-Delete ─── */

/**
 * Moves an email to trash by setting `deletedAt = NOW()`. Scoped to apiKeyId
 * so users can only trash their own emails. Idempotent: calling twice is
 * harmless (deleted_at is just overwritten with NOW()).
 *
 * @returns The updated email row, or undefined if not found / wrong owner.
 */
export async function trashEmail(
  id: string,
  apiKeyId: string,
): Promise<Email | undefined> {
  logger.info("Trashing email", { id, apiKeyId });

  const [email] = await db
    .update(emails)
    .set({ deletedAt: new Date() })
    .where(
      and(eq(emails.id, id), eq(emails.apiKeyId, apiKeyId), isNull(emails.deletedAt)),
    )
    .returning();

  return email;
}

/**
 * Bulk-trash variant: moves many emails to trash in one query.
 * Returns the count of rows actually trashed (already-trashed and
 * not-owned rows are silently ignored).
 */
export async function trashEmails(ids: string[], apiKeyId: string): Promise<number> {
  if (ids.length === 0) return 0;
  logger.info("Bulk-trashing emails", { count: ids.length, apiKeyId });

  const rows = await db
    .update(emails)
    .set({ deletedAt: new Date() })
    .where(
      and(
        inArray(emails.id, ids),
        eq(emails.apiKeyId, apiKeyId),
        isNull(emails.deletedAt),
      ),
    )
    .returning({ id: emails.id });

  return rows.length;
}

/**
 * Lists trashed emails (deleted_at IS NOT NULL), scoped to apiKeyId.
 * Newest-trashed first.
 */
export async function listTrashedEmails(
  apiKeyId: string,
  filters: ListEmailsFilters,
): Promise<{ data: Email[]; total: number }> {
  const offset = (filters.page - 1) * filters.limit;

  const conditions = and(eq(emails.apiKeyId, apiKeyId), isNotNull(emails.deletedAt));

  const [data, [countRow]] = await Promise.all([
    db
      .select()
      .from(emails)
      .where(conditions)
      .orderBy(desc(emails.deletedAt))
      .limit(filters.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(emails)
      .where(conditions),
  ]);

  return { data, total: countRow?.count ?? 0 };
}

/**
 * Restores a trashed email: clears `deletedAt`. Scoped to apiKeyId.
 */
export async function restoreEmail(
  id: string,
  apiKeyId: string,
): Promise<Email | undefined> {
  logger.info("Restoring email", { id, apiKeyId });

  const [email] = await db
    .update(emails)
    .set({ deletedAt: null })
    .where(
      and(eq(emails.id, id), eq(emails.apiKeyId, apiKeyId), isNotNull(emails.deletedAt)),
    )
    .returning();

  return email;
}

/**
 * Permanently deletes a trashed email. Only works on rows that are already
 * in trash: protects against accidentally bypassing the trash workflow.
 *
 * Routes through {@link deleteEmailsWithTombstones} (#34) so a snapshot
 * of identifiers + status is preserved past the hard-delete for late
 * complaint / bounce trace-back. Returns the deleted email's `id` only;
 * the rest of the row is gone, exactly as before, but `id` matches the
 * tombstone's id so callers can immediately fetch the snapshot if they
 * want to.
 */
export async function permanentDeleteEmail(
  id: string,
  apiKeyId: string,
): Promise<{ id: string } | undefined> {
  logger.info("Permanently deleting email", { id, apiKeyId });

  const rows = await deleteEmailsWithTombstones(
    and(eq(emails.id, id), eq(emails.apiKeyId, apiKeyId), isNotNull(emails.deletedAt)),
  );

  return rows[0];
}

/**
 * Empties the trash for a given API key: permanently deletes all
 * trashed emails for that key. Returns the count purged. Tombstones
 * are written for every deleted row (#34).
 */
export async function emptyEmailsTrash(apiKeyId: string): Promise<number> {
  logger.info("Emptying emails trash", { apiKeyId });

  const rows = await deleteEmailsWithTombstones(
    and(eq(emails.apiKeyId, apiKeyId), isNotNull(emails.deletedAt)),
  );

  return rows.length;
}

/* ─── Unscoped variants for the dashboard ─── */

/**
 * Lists trashed emails across all API keys: used by the dashboard trash view.
 */
export async function listTrashedEmailsUnscoped(
  filters: ListEmailsFilters,
): Promise<{ data: Email[]; total: number }> {
  const offset = (filters.page - 1) * filters.limit;
  const conditions = isNotNull(emails.deletedAt);

  const [data, [countRow]] = await Promise.all([
    db
      .select()
      .from(emails)
      .where(conditions)
      .orderBy(desc(emails.deletedAt))
      .limit(filters.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(emails)
      .where(conditions),
  ]);

  return { data, total: countRow?.count ?? 0 };
}

/**
 * Dashboard variant of getEmailByIdUnscoped that explicitly returns
 * trashed rows: used to render the trashed email's detail view.
 */
export async function getTrashedEmailByIdUnscoped(
  id: string,
): Promise<Email | undefined> {
  const [email] = await db
    .select()
    .from(emails)
    .where(and(eq(emails.id, id), isNotNull(emails.deletedAt)));
  return email;
}

/** Dashboard: trash an email by id (no apiKey scoping). */
export async function trashEmailUnscoped(id: string): Promise<Email | undefined> {
  logger.info("Trashing email (unscoped)", { id });
  const [email] = await db
    .update(emails)
    .set({ deletedAt: new Date() })
    .where(and(eq(emails.id, id), isNull(emails.deletedAt)))
    .returning();
  return email;
}

/** Dashboard: bulk trash many ids (no apiKey scoping). */
export async function trashEmailsUnscoped(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  logger.info("Bulk-trashing emails (unscoped)", { count: ids.length });
  const rows = await db
    .update(emails)
    .set({ deletedAt: new Date() })
    .where(and(inArray(emails.id, ids), isNull(emails.deletedAt)))
    .returning({ id: emails.id });
  return rows.length;
}

/** Dashboard: restore a trashed email (no apiKey scoping). */
export async function restoreEmailUnscoped(id: string): Promise<Email | undefined> {
  logger.info("Restoring email (unscoped)", { id });
  const [email] = await db
    .update(emails)
    .set({ deletedAt: null })
    .where(and(eq(emails.id, id), isNotNull(emails.deletedAt)))
    .returning();
  return email;
}

/** Dashboard: permanently delete a trashed email (no apiKey scoping).
 *  Tombstone is recorded under the original email's apiKey via
 *  {@link deleteEmailsWithTombstones} (#34). */
export async function permanentDeleteEmailUnscoped(
  id: string,
): Promise<{ id: string } | undefined> {
  logger.info("Permanently deleting email (unscoped)", { id });
  const rows = await deleteEmailsWithTombstones(
    and(eq(emails.id, id), isNotNull(emails.deletedAt)),
  );
  return rows[0];
}

/** Dashboard: empty trash across all API keys. Tombstones recorded for
 *  every deleted row (#34). */
export async function emptyEmailsTrashUnscoped(): Promise<number> {
  logger.info("Emptying emails trash (unscoped)");
  const rows = await deleteEmailsWithTombstones(isNotNull(emails.deletedAt));
  return rows.length;
}
