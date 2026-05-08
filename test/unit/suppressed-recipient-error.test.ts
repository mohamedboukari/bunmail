import { describe, test, expect } from "bun:test";
import { SuppressedRecipientError } from "../../src/modules/suppressions/errors.ts";

/**
 * Trivial unit test for the error class — the constructor wires up
 * `.suppressionId`, `.recipient`, and the human-readable message.
 * Currently 0% covered because nothing constructs it directly outside
 * production code; integration tests catch instances of it but the
 * coverage tool doesn't credit those calls when run combined with
 * mocked-DB unit tests.
 */

describe("SuppressedRecipientError", () => {
  test("constructor populates suppressionId + recipient + message + name", () => {
    const err = new SuppressedRecipientError({
      suppressionId: "sup_abc123",
      recipient: "blocked@example.com",
    });
    expect(err.suppressionId).toBe("sup_abc123");
    expect(err.recipient).toBe("blocked@example.com");
    expect(err.name).toBe("SuppressedRecipientError");
    expect(err.message).toMatch(/Recipient is on the suppression list/);
  });

  test("is an instance of Error so global onError handlers can catch it", () => {
    const err = new SuppressedRecipientError({
      suppressionId: "sup_x",
      recipient: "x@example.com",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SuppressedRecipientError);
  });
});
