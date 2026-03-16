import { describe, test, expect } from "bun:test";
import { createHmac } from "crypto";

/**
 * Unit tests for the signPayload logic.
 *
 * Tests HMAC-SHA256 payload signing used by the webhook dispatch service.
 * The function is private in the service, so we replicate the same logic
 * here to verify the cryptographic properties.
 */

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

describe("signPayload", () => {
  test("returns a 64-char hex string (HMAC-SHA256)", () => {
    const sig = signPayload('{"event":"sent"}', "webhook-secret");
    expect(sig).toHaveLength(64);
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });

  test("is deterministic — same input always produces same output", () => {
    const sig1 = signPayload("hello", "secret");
    const sig2 = signPayload("hello", "secret");
    expect(sig1).toBe(sig2);
  });

  test("different payloads produce different signatures", () => {
    const sig1 = signPayload("payload-a", "secret");
    const sig2 = signPayload("payload-b", "secret");
    expect(sig1).not.toBe(sig2);
  });

  test("different secrets produce different signatures", () => {
    const sig1 = signPayload("same-payload", "secret-1");
    const sig2 = signPayload("same-payload", "secret-2");
    expect(sig1).not.toBe(sig2);
  });

  test("matches Node crypto HMAC-SHA256 output", () => {
    const payload = '{"event":"email.sent","data":{}}';
    const secret = "whsec_test123";
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    const result = signPayload(payload, secret);
    expect(result).toBe(expected);
  });
});
