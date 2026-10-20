import { describe, test, expect } from "bun:test";
import { serializeEmail } from "../../src/modules/emails/serializations/email.serialization.ts";

/**
 * Unit tests for email serialization.
 *
 * Verifies that internal fields (apiKeyId, domainId) are stripped
 * and field names are mapped to consumer-friendly format.
 */

describe("serializeEmail", () => {
  const email = {
    id: "msg_abc123",
    apiKeyId: "key_secret123",
    domainId: "dom_xyz789",
    fromAddress: "hello@example.com",
    toAddress: "user@test.com",
    cc: "cc@test.com",
    bcc: null,
    replyTo: null,
    headers: null,
    subject: "Test Subject",
    html: "<p>Hello</p>",
    textContent: "Hello",
    status: "sent",
    source: "api",
    fromName: null,
    category: null,
    tags: null,
    attempts: 1,
    nextAttemptAt: new Date("2024-01-01"),
    lockedBy: null,
    leaseUntil: null,
    lastError: null,
    messageId: "<msg123@mail.example.com>",
    sentAt: new Date("2024-06-01"),
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    deletedAt: null,
    deliveryState: null,
  };

  test("maps fromAddress to from", () => {
    const result = serializeEmail(email, []);
    expect(result.from).toBe("hello@example.com");
  });

  test("exposes fromName and category (#250), null when unset or unknown", () => {
    expect(serializeEmail(email, []).fromName).toBeNull();
    expect(serializeEmail(email, []).category).toBeNull();
    const labelled = serializeEmail(
      {
        ...email,
        fromName: "Acme",
        category: "marketing",
      },
      [],
    );
    expect(labelled.fromName).toBe("Acme");
    expect(labelled.category).toBe("marketing");
    expect(serializeEmail({ ...email, category: "bogus" }, []).category).toBeNull();
  });

  test("maps toAddress to to", () => {
    const result = serializeEmail(email, []);
    expect(result.to).toBe("user@test.com");
  });

  test("maps textContent to text", () => {
    const result = serializeEmail(email, []);
    expect(result.text).toBe("Hello");
  });

  test("strips apiKeyId from output", () => {
    const result = serializeEmail(email, []);
    expect("apiKeyId" in result).toBe(false);
  });

  test("strips domainId from output", () => {
    const result = serializeEmail(email, []);
    expect("domainId" in result).toBe(false);
  });

  test("strips updatedAt from output", () => {
    const result = serializeEmail(email, []);
    expect("updatedAt" in result).toBe(false);
  });

  test("includes all expected public fields", () => {
    const result = serializeEmail(email, []);
    expect(result.id).toBe("msg_abc123");
    expect(result.status).toBe("sent");
    expect(result.source).toBe("api");
    expect(result.attempts).toBe(1);
    expect(result.messageId).toBe("<msg123@mail.example.com>");
    expect(result.cc).toBe("cc@test.com");
    expect(result.bcc).toBeNull();
    expect(result.replyTo).toBeNull();
  });

  test("exposes replyTo when set (#169)", () => {
    const result = serializeEmail({ ...email, replyTo: "support@example.com" }, []);
    expect(result.replyTo).toBe("support@example.com");
  });

  test("exposes custom headers, null when none (#177)", () => {
    expect(serializeEmail(email, []).headers).toBeNull();
    const result = serializeEmail(
      { ...email, headers: { "X-Correlation-Id": "abc" } },
      [],
    );
    expect(result.headers).toEqual({ "X-Correlation-Id": "abc" });
  });

  test("exposes tags, null when none (#189)", () => {
    expect(serializeEmail(email, []).tags).toBeNull();
    const result = serializeEmail({ ...email, tags: { flow: "reset" } }, []);
    expect(result.tags).toEqual({ flow: "reset" });
  });

  test("attachments (#181): metadata only, in order, never the bytes", () => {
    expect(serializeEmail(email, []).attachments).toEqual([]);
    const result = serializeEmail(email, [
      {
        position: 0,
        filename: "invoice.pdf",
        contentType: "application/pdf",
        sizeBytes: 1234,
        contentId: null,
        available: true,
      },
      {
        position: 1,
        filename: "logo.png",
        contentType: "image/png",
        sizeBytes: 99,
        contentId: "logo",
        available: false,
      },
    ]);
    expect(result.attachments).toEqual([
      {
        filename: "invoice.pdf",
        contentType: "application/pdf",
        size: 1234,
        contentId: null,
        available: true,
      },
      {
        filename: "logo.png",
        contentType: "image/png",
        size: 99,
        contentId: "logo",
        available: false,
      },
    ]);
  });

  describe("to (#178)", () => {
    test("one stored address is a string", () => {
      expect(serializeEmail(email, []).to).toBe("user@test.com");
    });

    test("several stored addresses are an array", () => {
      const several = { ...email, toAddress: "a@test.com, b@test.org" };
      expect(serializeEmail(several, []).to).toEqual(["a@test.com", "b@test.org"]);
    });

    test("toAsArray answers an array even with one address", () => {
      expect(serializeEmail(email, [], { toAsArray: true }).to).toEqual([
        "user@test.com",
      ]);
    });
  });
});
