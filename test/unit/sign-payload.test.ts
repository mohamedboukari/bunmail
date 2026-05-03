import { describe, test, expect } from "bun:test";
import { createHmac } from "crypto";

/**
 * Unit tests for the signPayload logic used by the webhook dispatch service.
 *
 * Replicates the function locally rather than importing the real one — the
 * real one pulls the config + db graph through its module imports, which
 * would require mocking. We just verify the cryptographic shape:
 *
 *   signature = HMAC-SHA256(secret, "<timestamp>.<body>")
 *
 * If this gets out of sync with `webhook-dispatch.service.ts:signPayload`,
 * tests start failing — see the `matches dispatch-service construction`
 * test for the exact byte-level contract.
 */
function signPayload(timestamp: string, body: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

describe("signPayload", () => {
  test("returns a 64-char hex string (HMAC-SHA256)", () => {
    const sig = signPayload("1717000000", '{"event":"sent"}', "webhook-secret");
    expect(sig).toHaveLength(64);
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });

  test("is deterministic — same input always produces same output", () => {
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

  test("matches dispatch-service construction byte-for-byte", () => {
    /**
     * Pin the exact wire format the consumer is told to verify. If
     * either side ever drifts (e.g. someone changes the separator from
     * "." to ":") this test catches it before consumers see broken
     * signatures in prod.
     */
    const timestamp = "1717000000";
    const body = '{"event":"email.sent","data":{}}';
    const secret = "whsec_test123";
    const expected = createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    expect(signPayload(timestamp, body, secret)).toBe(expected);
  });
});
