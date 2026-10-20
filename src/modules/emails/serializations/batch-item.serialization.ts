import type { JsonObject } from "../types/email.types.ts";
import type { BatchItemProblem } from "../dtos/batch-send-email.dto.ts";
import type { SendErrorBody } from "./send-error.serialization.ts";

/**
 * One result in the `data` of `POST /api/v1/emails/batch` (#178): the
 * item's 0-based `index` in the request, then either `success: true` with
 * `data` (the email, as `/send` answers it), `warnings` and `replayed`
 * (true when its `idempotencyKey` replayed an earlier send), or
 * `success: false` with `error`, `code` and, depending on the code,
 * `details`, `suppressionId`, `attachmentIndex` or `sender`.
 */
export type BatchItemResult = JsonObject & { index: number; success: boolean };

/**
 * A created (or replayed) item: the `/send` response body (`success`,
 * `data`, `warnings`) after the index, and whether it was replayed.
 */
export function batchItemSuccess(
  index: number,
  body: JsonObject,
  replayed: boolean,
): BatchItemResult {
  return { index, ...body, success: true, replayed };
}

/** An item that failed validation: the same shape `/send` answers, per item. */
export function batchItemInvalid(
  index: number,
  problems: readonly BatchItemProblem[],
): BatchItemResult {
  return {
    index,
    success: false,
    error: "Request validation failed",
    code: "VALIDATION_ERROR",
    details: problems.map(({ path, message }) => ({ path, message })),
  };
}

/**
 * An item refused as `/send` would refuse it (`serializeSendError`). The
 * refused attachment's `index` would clash with the item's, so it is
 * `attachmentIndex` here.
 */
export function batchItemRefused(index: number, refusal: SendErrorBody): BatchItemResult {
  const { index: attachmentIndex, details, suppressionId, sender, ...rest } = refusal;
  return {
    index,
    ...rest,
    ...(details === undefined
      ? {}
      : { details: details.map(({ path, message }) => ({ path, message })) }),
    ...(suppressionId === undefined ? {} : { suppressionId }),
    ...(attachmentIndex === undefined ? {} : { attachmentIndex }),
    ...(sender === undefined ? {} : { sender }),
  };
}

/** An item that failed unexpectedly: a fixed answer, nothing internal. */
export function batchItemInternalError(index: number): BatchItemResult {
  return {
    index,
    success: false,
    error: "Internal server error",
    code: "INTERNAL_ERROR",
  };
}
