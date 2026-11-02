import { db } from "../../../db/index.ts";
import { emails } from "../models/email.schema.ts";
import { prepareEmail, type PreparedEmail } from "./email-prepare.service.ts";
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
import { IdempotencyKeyReusedError } from "../errors.ts";
import { attachmentStorage } from "./attachment-storage.ts";
import { logger } from "../../../utils/logger.ts";
import { enqueueEvent } from "../../webhooks/services/webhook-dispatch.service.ts";
import type {
  SendEmailInput,
  EmailSource,
  CreatedEmail,
  DbExecutor,
  SendResponse,
  IdempotentSendResult,
  Tx,
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
  /**
   * One transaction: the email row, its files (#181) and its
   * `email.queued` event (#371) commit together or not at all.
   */
  return db.transaction((tx) => insertPreparedEmail(tx, prepared));
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
 * removes its content everywhere. Attachments (#181) are stored with the
 * email in the same transaction; the snapshot keeps only their metadata,
 * as the first response gave it, never the bytes.
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

/**
 * Inserts a prepared send with status `queued` in `tx` (the idempotent
 * send's transaction, or the one `createEmail` opens), with its
 * attachments (#181) and its `email.queued` event (#371), and logs it.
 * The event goes through the webhook outbox in the same transaction, so a
 * subscriber hears about an email exactly when it exists.
 */
async function insertPreparedEmail(
  tx: Tx,
  prepared: PreparedEmail,
): Promise<CreatedEmail> {
  const { values, warnings, senderDomain, attachments } = prepared;
  const { id, apiKeyId, source, domainId, headers, tags } = values;
  const [email] = await tx.insert(emails).values(values).returning();
  await attachmentStorage.saveAttachments(tx, id, attachments);
  await enqueueEvent(
    tx,
    "email.queued",
    {
      emailId: id,
      from: values.fromAddress,
      to: values.toAddress,
      subject: values.subject,
      tags: tags ?? null,
      source,
    },
    { apiKeyId },
  );

  logger.debug("Email created and queued", {
    id,
    status: email!.status,
    domainId,
    customHeaders: headers ? Object.keys(headers) : [],
    /** Keys only: tag values may hold customer ids (#189). */
    tagKeys: tags ? Object.keys(tags) : [],
    /** Count and size only: filenames may carry personal data (#181). */
    attachmentCount: attachments.length,
    attachmentBytes: attachments.reduce((sum, a) => sum + a.sizeBytes, 0),
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

  return {
    email: email!,
    warnings,
    attachments: attachments.map((a) => ({
      position: a.position,
      filename: a.filename,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      contentId: a.contentId,
      available: true,
    })),
  };
}
