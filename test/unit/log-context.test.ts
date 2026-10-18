import { describe, test, expect, spyOn } from "bun:test";
import {
  getLogContext,
  newRequestId,
  requestIdFrom,
  runWithLogContext,
} from "../../src/utils/log-context.ts";
import { logger, redactSecrets } from "../../src/utils/logger.ts";

/**
 * Request-scoped log context and central secret redaction (#284): every
 * log line carries the ID of the request, job or SMTP session it belongs
 * to, parallel work never mixes IDs, and secret-named fields never reach
 * the output.
 */

describe("runWithLogContext", () => {
  test("the context follows awaits and is gone outside", async () => {
    expect(getLogContext()).toBeUndefined();
    const seen = await runWithLogContext({ requestId: "req_a" }, async () => {
      await Bun.sleep(1);
      await Promise.resolve();
      return getLogContext()?.requestId;
    });
    expect(seen).toBe("req_a");
    expect(getLogContext()).toBeUndefined();
  });

  test("nested contexts merge, inner fields win", () => {
    runWithLogContext({ requestId: "req_a", job: "outer" }, () => {
      runWithLogContext({ job: "email-send", jobId: "msg_1" }, () => {
        expect(getLogContext()).toEqual({
          requestId: "req_a",
          job: "email-send",
          jobId: "msg_1",
        });
      });
      expect(getLogContext()).toEqual({ requestId: "req_a", job: "outer" });
    });
  });

  test("parallel work never mixes IDs", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        runWithLogContext({ requestId: `req_${i}` }, async () => {
          await Bun.sleep(Math.random() * 5);
          return getLogContext()?.requestId === `req_${i}`;
        }),
      ),
    );
    expect(results.every(Boolean)).toBe(true);
  });
});

describe("request IDs", () => {
  test("generated IDs are prefixed, hex and unique", () => {
    const a = newRequestId();
    expect(a).toMatch(/^req_[0-9a-f]{32}$/);
    expect(newRequestId()).not.toBe(a);
  });

  test("a well-formed incoming X-Request-Id is reused", () => {
    expect(requestIdFrom("abc-123_X.9")).toBe("abc-123_X.9");
    expect(requestIdFrom("a".repeat(64))).toBe("a".repeat(64));
  });

  test("a missing, empty, too long or unsafe one is replaced", () => {
    for (const header of [
      null,
      "",
      "a".repeat(65),
      "has space",
      "new\nline",
      'quote"',
      "<x>",
    ]) {
      expect(requestIdFrom(header)).toMatch(/^req_[0-9a-f]{32}$/);
    }
  });
});

describe("redactSecrets", () => {
  test("secret-named keys are redacted at any depth and in any case style", () => {
    const out = redactSecrets({
      password: "p",
      newPassword: "p",
      api_key: "k",
      "X-Api-Key": "k",
      sessionToken: "t",
      tokenHash: "h",
      secretHash: "h",
      dkimPrivateKey: "k",
      Authorization: "Bearer x",
      cookie: "bm_session=x",
      nested: { deeper: [{ secret: "s", fine: 1 }] },
    });
    expect(out).toEqual({
      password: "[REDACTED]",
      newPassword: "[REDACTED]",
      api_key: "[REDACTED]",
      "X-Api-Key": "[REDACTED]",
      sessionToken: "[REDACTED]",
      tokenHash: "[REDACTED]",
      secretHash: "[REDACTED]",
      dkimPrivateKey: "[REDACTED]",
      Authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      nested: { deeper: [{ secret: "[REDACTED]", fine: 1 }] },
    });
  });

  test("identifiers and ordinary fields stay readable", () => {
    const fields = {
      apiKeyId: "key_1",
      sessionId: "ses_1",
      userId: "usr_1",
      tokenCount: 3,
      key: "dedup",
      status: 200,
      url: "https://example.com/hook",
    };
    expect(redactSecrets(fields)).toEqual(fields);
  });

  test("non-plain objects pass through and depth is bounded", () => {
    const when = new Date(0);
    expect(redactSecrets({ when })).toEqual({ when });
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 10; i++) deep = { next: deep };
    expect(JSON.stringify(redactSecrets(deep))).toContain("[REDACTED]");
  });
});

describe("logger output", () => {
  test("a line carries the context and has its secrets redacted", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      runWithLogContext({ requestId: "req_ctx", jobId: "msg_9" }, () => {
        logger.error("Something failed", { password: "hunter2", emailId: "msg_9" });
      });
      const line = String(spy.mock.calls[0]?.[0] ?? "");
      expect(line).toContain("req_ctx");
      expect(line).toContain("msg_9");
      expect(line).toContain("[REDACTED]");
      expect(line).not.toContain("hunter2");
    } finally {
      spy.mockRestore();
    }
  });
});
