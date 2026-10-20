import { describe, test, expect } from "bun:test";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import {
  batchSendEmailDto,
  MAX_BATCH_EMAILS,
  parseBatchItem,
} from "../../src/modules/emails/dtos/batch-send-email.dto.ts";

/**
 * The batch send body (#178): the envelope is validated as a whole (1 to
 * 100 items of any shape), each item on its own by `parseBatchItem`.
 */

const envelope = TypeCompiler.Compile(batchSendEmailDto);

const item = {
  from: "sender@example.com",
  to: ["a@example.com", "b@example.org"],
  subject: "Hello",
  text: "Hi",
};

describe("batchSendEmailDto", () => {
  test("accepts 1 to 100 items, whatever each item is", () => {
    expect(envelope.Check({ emails: [item] })).toBe(true);
    expect(envelope.Check({ emails: [item, "not an object", 3] })).toBe(true);
    expect(
      envelope.Check({ emails: Array.from({ length: MAX_BATCH_EMAILS }, () => item) }),
    ).toBe(true);
  });

  test("rejects no items, more than 100, or a missing list", () => {
    expect(envelope.Check({ emails: [] })).toBe(false);
    expect(
      envelope.Check({
        emails: Array.from({ length: MAX_BATCH_EMAILS + 1 }, () => item),
      }),
    ).toBe(false);
    expect(envelope.Check({})).toBe(false);
  });
});

describe("parseBatchItem", () => {
  test("a valid item, with its idempotency key", () => {
    const parsed = parseBatchItem({ ...item, idempotencyKey: "order-1" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.item.idempotencyKey).toBe("order-1");
      expect(parsed.item.to).toEqual(["a@example.com", "b@example.org"]);
    }
  });

  test("unknown properties are removed", () => {
    const parsed = parseBatchItem({ ...item, bogus: "x" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Object.keys(parsed.item)).not.toContain("bogus");
  });

  test("a bad item reports the paths inside the item, not the values", () => {
    const parsed = parseBatchItem({ ...item, to: "nope", subject: "a\r\nBcc: x" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const paths = parsed.problems.map((p) => p.path);
      expect(paths).toContain("/to");
      expect(paths).toContain("/subject");
      expect(JSON.stringify(parsed.problems)).not.toContain("Bcc: x");
    }
  });

  test("an invalid idempotency key, a non-object, and a missing from are refused", () => {
    expect(parseBatchItem({ ...item, idempotencyKey: "has space" }).ok).toBe(false);
    expect(parseBatchItem("text").ok).toBe(false);
    expect(parseBatchItem({ to: "a@example.com", subject: "s" }).ok).toBe(false);
  });

  test("at most 10 problems are reported", () => {
    const parsed = parseBatchItem({
      from: 1,
      to: 2,
      cc: 3,
      bcc: 4,
      replyTo: 5,
      subject: 6,
      html: 7,
      text: 8,
      templateId: 9,
      fromName: 10,
      category: 11,
      idempotencyKey: 12,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.length).toBeLessThanOrEqual(10);
  });
});
