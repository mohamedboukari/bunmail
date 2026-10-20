import { describe, test, expect } from "bun:test";
import {
  batchItemInternalError,
  batchItemInvalid,
  batchItemRefused,
  batchItemSuccess,
} from "../../src/modules/emails/serializations/batch-item.serialization.ts";
import { serializeSendError } from "../../src/modules/emails/serializations/send-error.serialization.ts";
import {
  AttachmentTypeNotAllowedError,
  TooManyRecipientsError,
} from "../../src/modules/emails/errors.ts";
import { SuppressedRecipientError } from "../../src/modules/suppressions/errors.ts";
import { UnauthorizedSenderError } from "../../src/modules/api-keys/errors.ts";

/**
 * Per-item results of the batch send (#178): every result starts with the
 * item's index; a refusal carries what `/send` would answer, with the
 * refused attachment's index renamed so it cannot clash.
 */

/** The refusal body `/send` answers for `error`. */
function refusalOf(error: unknown) {
  const refusal = serializeSendError(error);
  if (refusal === null) throw new Error("expected a send refusal");
  return refusal;
}

describe("batch item results", () => {
  test("a success keeps the /send body after the index, with replayed", () => {
    const result = batchItemSuccess(
      2,
      { success: true, data: { id: "msg_1" }, warnings: [] },
      true,
    );
    expect(result).toEqual({
      index: 2,
      success: true,
      data: { id: "msg_1" },
      warnings: [],
      replayed: true,
    });
    expect(Object.keys(result)[0]).toBe("index");
  });

  test("a validation failure has the VALIDATION_ERROR shape", () => {
    expect(batchItemInvalid(1, [{ path: "/to", message: "Expected string" }])).toEqual({
      index: 1,
      success: false,
      error: "Request validation failed",
      code: "VALIDATION_ERROR",
      details: [{ path: "/to", message: "Expected string" }],
    });
  });

  test("a recipient cap refusal carries its code and status", () => {
    const refusal = refusalOf(new TooManyRecipientsError("to", 50));
    expect(refusal.status).toBe(422);
    expect(batchItemRefused(0, refusal.body)).toEqual({
      index: 0,
      success: false,
      error: "At most 50 addresses in to.",
      code: "TOO_MANY_RECIPIENTS",
    });
  });

  test("a suppression keeps suppressionId, null for a shared one", () => {
    const own = refusalOf(
      new SuppressedRecipientError({
        suppressionId: "sup_1",
        recipient: "a@example.com",
      }),
    );
    expect(batchItemRefused(3, own.body)).toMatchObject({
      index: 3,
      code: "RECIPIENT_SUPPRESSED",
      suppressionId: "sup_1",
    });
    const shared = refusalOf(
      new SuppressedRecipientError({ suppressionId: null, recipient: "a@example.com" }),
    );
    expect(batchItemRefused(3, shared.body)).toMatchObject({ suppressionId: null });
  });

  test("an attachment's index becomes attachmentIndex, the item's index stays", () => {
    const refusal = refusalOf(new AttachmentTypeNotAllowedError(4, "extension"));
    expect(refusal.body.index).toBe(4);
    const result = batchItemRefused(7, refusal.body);
    expect(result).toMatchObject({
      index: 7,
      attachmentIndex: 4,
      code: "ATTACHMENT_TYPE_NOT_ALLOWED",
    });
  });

  test("an unauthorized sender keeps its sender field", () => {
    const refusal = refusalOf(new UnauthorizedSenderError("ceo@example.com"));
    expect(refusal.status).toBe(403);
    expect(batchItemRefused(0, refusal.body)).toMatchObject({
      code: "UNAUTHORIZED_SENDER",
      sender: "ceo@example.com",
    });
  });

  test("an unexpected error is not a send refusal, and its item says nothing internal", () => {
    expect(serializeSendError(new Error("relation emails: bad value"))).toBeNull();
    expect(batchItemInternalError(5)).toEqual({
      index: 5,
      success: false,
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  });
});
