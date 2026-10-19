import { describe, test, expect } from "bun:test";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import {
  DEFAULT_IDEMPOTENCY_KEY_TTL_HOURS,
  MAX_IDEMPOTENCY_KEY_TTL_HOURS,
  MIN_IDEMPOTENCY_KEY_TTL_HOURS,
  readIdempotencyKeyTtlHours,
} from "../../src/config.ts";
import { sendEmailHeadersDto } from "../../src/modules/emails/dtos/send-email.dto.ts";
import {
  canonicalJson,
  hashSendRequest,
  toJsonObject,
} from "../../src/modules/emails/services/idempotency.service.ts";

/**
 * Idempotency keys on the send API (#188): the canonical request hash a
 * retry is compared against, the `Idempotency-Key` header rule, and the
 * TTL env var's bounds. The database flow is covered by
 * `test/integration/idempotency-keys.integration.test.ts`.
 */

describe("canonicalJson", () => {
  test("sorts object keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}',
    );
  });

  test("keeps array order", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  test("drops undefined members, like JSON", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test("keeps a __proto__ key like any other", () => {
    const parsed: unknown = JSON.parse('{"__proto__":"x","a":1}');
    expect(canonicalJson(parsed)).toBe('{"__proto__":"x","a":1}');
  });

  test("escapes strings as JSON does", () => {
    expect(canonicalJson({ 'q"': 'line\nbreak "quoted"' })).toBe(
      '{"q\\"":"line\\nbreak \\"quoted\\""}',
    );
  });
});

describe("hashSendRequest", () => {
  const body = {
    from: "hello@example.com",
    to: "user@example.org",
    subject: "Hi",
    text: "x",
    headers: { "X-A": "1", "X-B": "2" },
  };

  test("is SHA-256 hex", () => {
    expect(hashSendRequest(body)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("ignores key order, at every depth", () => {
    const reordered = {
      headers: { "X-B": "2", "X-A": "1" },
      text: "x",
      subject: "Hi",
      to: "user@example.org",
      from: "hello@example.com",
    };
    expect(hashSendRequest(reordered)).toBe(hashSendRequest(body));
  });

  test("changes with any value", () => {
    expect(hashSendRequest({ ...body, subject: "Hi!" })).not.toBe(hashSendRequest(body));
    expect(hashSendRequest({ ...body, headers: { "X-A": "1" } })).not.toBe(
      hashSendRequest(body),
    );
    expect(hashSendRequest({ ...body, cc: "a@example.com" })).not.toBe(
      hashSendRequest(body),
    );
  });
});

describe("toJsonObject", () => {
  test("turns dates into ISO strings", () => {
    const createdAt = new Date("2026-10-19T00:00:00.000Z");
    expect(toJsonObject({ data: { createdAt, sentAt: null } })).toEqual({
      data: { createdAt: "2026-10-19T00:00:00.000Z", sentAt: null },
    });
  });
});

describe("sendEmailHeadersDto: Idempotency-Key", () => {
  const check = TypeCompiler.Compile(sendEmailHeadersDto);

  test("is optional, and other headers pass through", () => {
    expect(check.Check({})).toBe(true);
    expect(check.Check({ authorization: "Bearer x", "content-type": "a/b" })).toBe(true);
  });

  test.each([
    ["one character", "a"],
    ["a UUID", "4f9c2b1e-8d4a-4c3b-9e2f-1a2b3c4d5e6f"],
    [
      "every printable ASCII character",
      "!\"#$%&'()*+,-./0123456789:;<=>?@AZ[\\]^_`az{|}~",
    ],
    ["255 characters", "k".repeat(255)],
  ])("accepts %s", (_label, value) => {
    expect(check.Check({ "idempotency-key": value })).toBe(true);
  });

  test.each([
    ["empty", ""],
    ["a space", "a b"],
    ["a tab", "a\tb"],
    ["a line break", "a\nb"],
    ["DEL", "a\u007fb"],
    ["a non-ASCII character", "clé"],
    ["256 characters", "k".repeat(256)],
    ["two joined headers", "a, b"],
  ])("refuses %s", (_label, value) => {
    expect(check.Check({ "idempotency-key": value })).toBe(false);
  });
});

describe("readIdempotencyKeyTtlHours", () => {
  test("unset or blank: 24 hours", () => {
    expect(DEFAULT_IDEMPOTENCY_KEY_TTL_HOURS).toBe(24);
    expect(readIdempotencyKeyTtlHours(undefined)).toBe(24);
    expect(readIdempotencyKeyTtlHours("")).toBe(24);
    expect(readIdempotencyKeyTtlHours("  ")).toBe(24);
  });

  test.each([
    ["1", 1],
    [" 48 ", 48],
    ["168", 168],
  ])("accepts %p", (raw, hours) => {
    expect(readIdempotencyKeyTtlHours(raw)).toBe(hours);
  });

  test.each([
    String(MIN_IDEMPOTENCY_KEY_TTL_HOURS - 1),
    String(MAX_IDEMPOTENCY_KEY_TTL_HOURS + 1),
    "-1",
    "1.5",
    "1e2",
    "0x10",
    "24h",
    "abc",
  ])("refuses %p", (raw) => {
    expect(() => readIdempotencyKeyTtlHours(raw)).toThrow(/IDEMPOTENCY_KEY_TTL_HOURS/);
  });
});
