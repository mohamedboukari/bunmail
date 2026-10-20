import { createEmail, createEmailIdempotent } from "./email.service.ts";
import { toJsonObject } from "./idempotency.service.ts";
import { parseBatchItem } from "../dtos/batch-send-email.dto.ts";
import { serializeSendError } from "../serializations/send-error.serialization.ts";
import {
  batchItemInternalError,
  batchItemInvalid,
  batchItemRefused,
  batchItemSuccess,
  type BatchItemResult,
} from "../serializations/batch-item.serialization.ts";
import { logger } from "../../../utils/logger.ts";
import type { CreatedEmail, SendEmailInput, SendResponse } from "../types/email.types.ts";

/**
 * `POST /api/v1/emails/batch` (#178): N distinct messages in one request,
 * each its own email row and Message-ID.
 *
 * Items are processed in order and independently: each is validated,
 * checked (suppression, sender, template, caps) and created on its own,
 * exactly as `POST /api/v1/emails/send` would, so one bad item never fails
 * the others. There is no transaction around the batch: an item created
 * stays created whatever happens to a later one.
 */

/**
 * The `/send` response for a created email (status and body), built by
 * the route so serialization stays with the plugin. `toAsArray` is
 * whether the item gave `to` as an array (#178).
 */
type BuildSendResponse = (created: CreatedEmail, toAsArray: boolean) => SendResponse;

/** Counts for the batch's boundary log line. */
interface BatchCounts {
  created: number;
  replayed: number;
  failed: number;
}

/**
 * Sends every item of a batch, in order, and returns one result per item
 * in the same order. Never throws for an item: an unexpected error is
 * logged and answered as that item's `INTERNAL_ERROR`. Logs one line for
 * the batch with counts and the duration, never an address.
 */
export async function sendBatch(
  items: readonly unknown[],
  apiKeyId: string,
  buildResponse: BuildSendResponse,
): Promise<BatchItemResult[]> {
  const startedAt = performance.now();
  const counts: BatchCounts = { created: 0, replayed: 0, failed: 0 };
  const results: BatchItemResult[] = [];

  for (const [index, value] of items.entries()) {
    const result = await sendBatchItem(index, value, apiKeyId, buildResponse);
    if (!result.success) counts.failed += 1;
    else if (result["replayed"] === true) counts.replayed += 1;
    else counts.created += 1;
    results.push(result);
  }

  logger.info("Batch send processed", {
    apiKeyId,
    count: items.length,
    ...counts,
    durationMs: Math.round(performance.now() - startedAt),
  });
  return results;
}

/** One item: validated, then created (or replayed), or its refusal. */
async function sendBatchItem(
  index: number,
  value: unknown,
  apiKeyId: string,
  buildResponse: BuildSendResponse,
): Promise<BatchItemResult> {
  const parsed = parseBatchItem(value);
  if (!parsed.ok) {
    /** Paths only, never the submitted values. */
    logger.warn("Batch item refused: validation failed", {
      apiKeyId,
      index,
      paths: parsed.problems.map((problem) => problem.path),
    });
    return batchItemInvalid(index, parsed.problems);
  }

  const { idempotencyKey, ...input } = parsed.item;
  const sendInput: SendEmailInput = input;
  const toAsArray = Array.isArray(input.to);

  try {
    if (idempotencyKey !== undefined) {
      const result = await createEmailIdempotent(
        sendInput,
        apiKeyId,
        idempotencyKey,
        (created) => buildResponse(created, toAsArray),
      );
      return batchItemSuccess(index, result.body, result.replayed);
    }
    const created = await createEmail(sendInput, apiKeyId);
    return batchItemSuccess(
      index,
      toJsonObject(buildResponse(created, toAsArray).body),
      false,
    );
  } catch (error) {
    /** A refusal: the service already logged it with the email id. */
    const refusal = serializeSendError(error);
    if (refusal) return batchItemRefused(index, refusal.body);
    /** The error's name only: a driver error's message embeds query parameters. */
    logger.error("Batch item failed unexpectedly", {
      apiKeyId,
      index,
      error: error instanceof Error ? error.name : typeof error,
    });
    return batchItemInternalError(index);
  }
}
