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
    subject: "Test Subject",
    html: "<p>Hello</p>",
    textContent: "Hello",
    status: "sent",
    attempts: 1,
    lastError: null,
    messageId: "<msg123@mail.example.com>",
    sentAt: new Date("2024-06-01"),
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    deletedAt: null,
  };

  test("maps fromAddress to from", () => {
    const result = serializeEmail(email);
    expect(result.from).toBe("hello@example.com");
  });

  test("maps toAddress to to", () => {
    const result = serializeEmail(email);
    expect(result.to).toBe("user@test.com");
  });

  test("maps textContent to text", () => {
    const result = serializeEmail(email);
    expect(result.text).toBe("Hello");
  });

  test("strips apiKeyId from output", () => {
    const result = serializeEmail(email);
    expect("apiKeyId" in result).toBe(false);
  });

  test("strips domainId from output", () => {
    const result = serializeEmail(email);
    expect("domainId" in result).toBe(false);
  });

  test("strips updatedAt from output", () => {
    const result = serializeEmail(email);
    expect("updatedAt" in result).toBe(false);
  });

  test("includes all expected public fields", () => {
    const result = serializeEmail(email);
    expect(result.id).toBe("msg_abc123");
    expect(result.status).toBe("sent");
    expect(result.attempts).toBe(1);
    expect(result.messageId).toBe("<msg123@mail.example.com>");
    expect(result.cc).toBe("cc@test.com");
    expect(result.bcc).toBeNull();
  });
});
