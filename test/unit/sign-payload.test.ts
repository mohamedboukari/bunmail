import { describe, test, expect } from "bun:test";
import { signPayload } from "../../src/modules/webhooks/services/webhook-dispatch.service.ts";

/**
 * Unit tests for webhook payload signing (#174).
 *
 * These call the real `signPayload` that the dispatch and delivery services
 * use. They used to re-declare it locally, so they passed regardless of the
 * source.
 *
 *   signature = hex(HMAC-SHA256(secret, "<timestamp>.<body>"))
 */

describe("signPayload", () => {
  test("returns a 64-char hex string (HMAC-SHA256)", () => {
    const sig = signPayload("1717000000", '{"event":"sent"}', "webhook-secret");
    expect(sig).toHaveLength(64);
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });

  test("is deterministic: same input always produces same output", () => {
    const sig1 = signPayload("1717000000", "hello", "secret");
    const sig2 = signPayload("1717000000", "hello", "secret");
    expect(sig1).toBe(sig2);
  });

  test("different bodies produce different signatures", () => {
    const sig1 = signPayload("1717000000", "payload-a", "secret");
    const sig2 = signPayload("1717000000", "payload-b", "secret");
    expect(sig1).not.toBe(sig2);
  });

  test("different timestamps produce different signatures (replay protection)", () => {
    const sig1 = signPayload("1717000000", "payload", "secret");
    const sig2 = signPayload("1717000001", "payload", "secret");
    expect(sig1).not.toBe(sig2);
  });

  test("different secrets produce different signatures", () => {
    const sig1 = signPayload("1717000000", "same-payload", "secret-1");
    const sig2 = signPayload("1717000000", "same-payload", "secret-2");
    expect(sig1).not.toBe(sig2);
  });

  test("matches a known-answer vector (pins the wire format)", () => {
    /**
     * Computed independently with openssl, not with Node's crypto:
     *   printf '%s' '1700000000.{"event":"email.sent","id":"msg_123"}' |
     *     openssl dgst -sha256 -hmac 'whsec_test_secret'
     * Receivers verify exactly this construction, so any change to it (the
     * "." separator, the field order, the encoding) breaks every consumer.
     */
    expect(
      signPayload(
        "1700000000",
        '{"event":"email.sent","id":"msg_123"}',
        "whsec_test_secret",
      ),
    ).toBe("e5f0ae64b06323ac2c0fdd0f942f79c4c20b110c05c56dee9d39d7897b896ac4");
  });
});
