import { describe, test, expect } from "bun:test";
import {
  filterCustomHeaders,
  isReservedHeaderName,
  validateCustomHeaders,
  MAX_CUSTOM_HEADERS,
  MAX_CUSTOM_HEADERS_BYTES,
  MAX_CUSTOM_HEADER_NAME_LENGTH,
  MAX_CUSTOM_HEADER_VALUE_LENGTH,
  type CustomHeaderProblem,
} from "../../src/modules/emails/services/custom-headers.ts";
import { InvalidCustomHeaderError } from "../../src/modules/emails/errors.ts";

/**
 * The custom-header rules (#177): the one definition of what the send API,
 * SMTP submission and the mailer accept. Header injection lives or dies
 * here, so every rule has a case.
 */

/** The error `validateCustomHeaders` throws for `headers`, or null when it passes. */
function refusal(headers: Record<string, string>): InvalidCustomHeaderError | null {
  try {
    validateCustomHeaders(headers);
    return null;
  } catch (error) {
    if (error instanceof InvalidCustomHeaderError) return error;
    throw error;
  }
}

/** Asserts `headers` is refused for `problem`. */
function expectRefused(
  headers: Record<string, string>,
  problem: CustomHeaderProblem,
): InvalidCustomHeaderError {
  const error = refusal(headers);
  expect(error).not.toBeNull();
  expect(error!.problem).toBe(problem);
  expect(error!.code).toBe("INVALID_CUSTOM_HEADER");
  expect(error!.status).toBe(422);
  return error!;
}

/** `n` distinct, valid headers. */
function many(n: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`X-H${i}`, "v"]));
}

describe("validateCustomHeaders: accepted", () => {
  test.each([
    ["X-Correlation-Id", "abc-123"],
    ["X-Entity-Ref-ID", "order/42"],
    ["In-Reply-To", "<parent@example.com>"],
    ["References", "<a@example.com> <b@example.com>"],
    ["in-reply-to", "<parent@example.com>"],
    ["X-Tab", "a\tb"],
    ["X-Unicode", "héllo wörld"],
    ["X-Empty", ""],
    ["X-Symbols!#$%&'*+.^_`|~", "v"],
  ])("%p", (name, value) => {
    expect(validateCustomHeaders({ [name]: value })).toEqual({ [name]: value });
  });

  test("keeps the caller's spelling of the name", () => {
    expect(validateCustomHeaders({ "x-lower": "1", "X-UPPER": "2" })).toEqual({
      "x-lower": "1",
      "X-UPPER": "2",
    });
  });

  test("exactly at every limit", () => {
    expect(Object.keys(validateCustomHeaders(many(MAX_CUSTOM_HEADERS)))).toHaveLength(
      MAX_CUSTOM_HEADERS,
    );
    const longName = `X-${"a".repeat(MAX_CUSTOM_HEADER_NAME_LENGTH - 2)}`;
    expect(refusal({ [longName]: "v" })).toBeNull();
    expect(refusal({ "X-A": "v".repeat(MAX_CUSTOM_HEADER_VALUE_LENGTH) })).toBeNull();
  });
});

describe("validateCustomHeaders: injection in the value", () => {
  test.each([
    ["CR", "v\rBcc: victim@example.com"],
    ["LF", "v\nBcc: victim@example.com"],
    ["CRLF", "v\r\nBcc: victim@example.com"],
    ["folded CRLF + space", "v\r\n folded"],
    ["NUL", "v\u0000"],
    ["BEL", "v\u0007"],
    ["vertical tab", "v\u000b"],
    ["form feed", "v\u000c"],
    ["ESC", "v\u001b"],
    ["DEL", "v\u007f"],
    ["NEL (C1)", "v\u0085"],
    ["line separator", "v\u2028"],
    ["paragraph separator", "v\u2029"],
  ])("rejects %s", (_label, value) => {
    const error = expectRefused({ "X-A": value }, "invalid_value");
    /** The name is echoed, the value never is. */
    expect(error.message).toContain('"X-A"');
    expect(error.message).not.toContain("victim");
    expect(error.header).toBe("X-A");
  });

  test("rejects a value longer than 998 characters", () => {
    expectRefused(
      { "X-A": "v".repeat(MAX_CUSTOM_HEADER_VALUE_LENGTH + 1) },
      "value_too_long",
    );
  });
});

describe("validateCustomHeaders: invalid names", () => {
  test.each([
    ["colon", "X-A:B"],
    ["space", "X A"],
    ["tab", "X\tA"],
    ["CRLF", "X-A\r\nBcc"],
    ["LF", "X-A\nBcc"],
    ["NUL", "X-A\u0000"],
    ["non-ASCII", "X-Ä"],
    ["empty", ""],
    ["too long", `X-${"a".repeat(MAX_CUSTOM_HEADER_NAME_LENGTH - 1)}`],
  ])("rejects a name with %s, without echoing it", (_label, name) => {
    const error = expectRefused({ [name]: "v" }, "invalid_name");
    expect(error.header).toBeNull();
    if (name) expect(error.message).not.toContain(name);
  });
});

describe("validateCustomHeaders: reserved names", () => {
  const reserved = [
    "From",
    "Sender",
    "To",
    "Cc",
    "Bcc",
    "Reply-To",
    "Subject",
    "Date",
    "Message-ID",
    "Return-Path",
    "Received",
    "DKIM-Signature",
    "Authentication-Results",
    "Received-SPF",
    "MIME-Version",
    "List-Unsubscribe",
    "List-Unsubscribe-Post",
    "List-Id",
    "Feedback-ID",
    "Precedence",
    "Auto-Submitted",
  ];

  /** Each name in three spellings: as listed, lowercase, alternating case. */
  const spellings = (name: string): string[] => [
    name,
    name.toLowerCase(),
    Array.from(name, (c, i) => (i % 2 ? c.toLowerCase() : c.toUpperCase())).join(""),
  ];

  for (const name of reserved) {
    for (const spelling of spellings(name)) {
      test(`rejects ${spelling}`, () => {
        expectRefused({ [spelling]: "v" }, "reserved");
        expect(isReservedHeaderName(spelling)).toBe(true);
      });
    }
  }

  for (const name of [
    "Content-Type",
    "content-transfer-encoding",
    "CONTENT-DISPOSITION",
    "Content-Anything",
    "ARC-Seal",
    "arc-message-signature",
    "Arc-Authentication-Results",
    "X-BunMail-Foo",
    "x-bunmail-internal",
    "X-BUNMAIL-",
  ]) {
    test(`rejects reserved prefix ${name}`, () => {
      expectRefused({ [name]: "v" }, "reserved");
    });
  }

  test.each(["In-Reply-To", "References", "X-Foo", "X-BunMailer", "Contents", "Archive"])(
    "%p is not reserved",
    (name) => {
      expect(isReservedHeaderName(name)).toBe(false);
    },
  );
});

describe("validateCustomHeaders: duplicates and caps", () => {
  test("rejects a case-insensitive duplicate", () => {
    const error = expectRefused({ "X-Foo": "1", "x-foo": "2" }, "duplicate");
    expect(error.header).toBe("x-foo");
  });

  test(`rejects more than ${MAX_CUSTOM_HEADERS} headers`, () => {
    expectRefused(many(MAX_CUSTOM_HEADERS + 1), "too_many");
  });

  test(`rejects more than ${MAX_CUSTOM_HEADERS_BYTES} bytes in total`, () => {
    /** 9 headers of ~990 bytes stay under the count cap but pass 8 KB. */
    const big = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`X-B${i}`, "v".repeat(990)]),
    );
    expectRefused(big, "too_large");
  });

  test("counts multi-byte characters as bytes", () => {
    /** 8 values of 600 two-byte characters: 4,800 chars but 9,600 bytes. */
    const wide = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`X-W${i}`, "é".repeat(600)]),
    );
    expectRefused(wide, "too_large");
  });
});

describe("filterCustomHeaders", () => {
  test("keeps the valid headers and reports the rest, names only", () => {
    const { headers, dropped } = filterCustomHeaders([
      ["X-Ok", "1"],
      ["X-Bad", "v\r\nBcc: victim@example.com"],
      ["From", "evil@example.com"],
      ["x-ok", "2"],
      ["Bad Name", "v"],
      ["In-Reply-To", "<p@example.com>"],
    ]);
    expect(headers).toEqual({ "X-Ok": "1", "In-Reply-To": "<p@example.com>" });
    expect(dropped).toEqual([
      { name: "X-Bad", problem: "invalid_value" },
      { name: "From", problem: "reserved" },
      { name: "x-ok", problem: "duplicate" },
      { name: null, problem: "invalid_name" },
    ]);
  });

  test("first come, first kept past the count cap", () => {
    const entries = Object.entries(many(MAX_CUSTOM_HEADERS + 3));
    const { headers, dropped } = filterCustomHeaders(entries);
    expect(Object.keys(headers)).toHaveLength(MAX_CUSTOM_HEADERS);
    expect(dropped.map((d) => d.problem)).toEqual(["too_many", "too_many", "too_many"]);
  });

  test("a __proto__ name stays a plain key", () => {
    const { headers } = filterCustomHeaders([["__proto__", "x"]]);
    expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
    expect(Object.keys(headers)).toEqual(["__proto__"]);
  });
});
