import { getSchemaValidator, t } from "elysia";
import { IDEMPOTENCY_KEY_PATTERN, sendEmailDto } from "./send-email.dto.ts";

/** Most emails in one `POST /api/v1/emails/batch` request (#178). */
export const MAX_BATCH_EMAILS = 100;

/** Most validation problems reported for one batch item, as for a whole request. */
const MAX_ITEM_DETAILS = 10;

/** Longest message of one reported validation problem, as for a whole request. */
const MAX_DETAIL_MESSAGE_LENGTH = 200;

/**
 * One item of a batch (#178): exactly the `POST /api/v1/emails/send` body,
 * plus an optional `idempotencyKey`, which takes the place of the
 * `Idempotency-Key` header for that item (#188 rules).
 */
export const batchSendEmailItemDto = t.Object({
  ...sendEmailDto.properties,
  idempotencyKey: t.Optional(
    t.String({
      pattern: IDEMPOTENCY_KEY_PATTERN,
      description:
        "Makes this item safe to retry, like the Idempotency-Key header of /send (which the batch endpoint refuses): the same key and item body within IDEMPOTENCY_KEY_TTL_HOURS creates nothing and answers the first result with replayed: true; the same key with another body fails this item with IDEMPOTENCY_KEY_REUSED. 1 to 255 printable ASCII characters, no spaces. Scoped to the API key, shared with /send.",
    }),
  ),
});

/**
 * Body of `POST /api/v1/emails/batch` (#178). Only the envelope is
 * validated here: each item is validated on its own by
 * {@link parseBatchItem}, so one bad item fails alone instead of the whole
 * request.
 */
export const batchSendEmailDto = t.Object({
  emails: t.Array(
    t.Unknown({
      description:
        "A POST /api/v1/emails/send body, plus an optional idempotencyKey. Validated per item: an invalid item fails alone with VALIDATION_ERROR.",
    }),
    {
      minItems: 1,
      maxItems: MAX_BATCH_EMAILS,
      description:
        "1 to 100 emails, each its own message, processed in order and independently.",
    },
  ),
});

/** A batch item that passed validation, unknown properties removed. */
export type BatchSendEmailItem = (typeof batchSendEmailItemDto)["static"];

/** One validation problem of an item: the JSON pointer inside the item and the rule. */
export interface BatchItemProblem {
  path: string;
  message: string;
}

/**
 * The item validator, compiled once. Elysia's own, with the same
 * normalization as a route body: unknown properties are removed.
 */
const itemValidator = getSchemaValidator(batchSendEmailItemDto, { normalize: true });

/**
 * Validates one batch item against {@link batchSendEmailItemDto}: the item,
 * or its problems (at most 10, paths inside the item, never the values),
 * shaped like the `details` of a request validation failure.
 */
export function parseBatchItem(
  value: unknown,
): { ok: true; item: BatchSendEmailItem } | { ok: false; problems: BatchItemProblem[] } {
  const parsed = itemValidator.safeParse(value);
  if (parsed.success) return { ok: true, item: parsed.data };
  return {
    ok: false,
    problems: parsed.errors
      .filter((e) => e !== undefined)
      .slice(0, MAX_ITEM_DETAILS)
      .map((e) => ({
        path: e.path,
        message: e.message.slice(0, MAX_DETAIL_MESSAGE_LENGTH),
      })),
  };
}
