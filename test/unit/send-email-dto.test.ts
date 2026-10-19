import { describe, test, expect } from "bun:test";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { sendEmailDto } from "../../src/modules/emails/dtos/send-email.dto.ts";

/**
 * Unit tests for the send-email DTO's header-injection defense-in-depth
 * (#133): `cc`/`bcc`/`subject` must reject CR/LF and enforce length caps,
 * so a newline in an address/subject field can't split an SMTP header.
 */

const check = TypeCompiler.Compile(sendEmailDto);

/** Minimal valid body we can spread + override per case. */
const base = {
  from: "sender@example.com",
  to: "rcpt@example.com",
  subject: "Hello",
};

describe("sendEmailDto: CRLF header-injection guard (#133)", () => {
  test("accepts a clean body", () => {
    expect(check.Check(base)).toBe(true);
  });

  test("accepts a comma-separated cc list (multi-address)", () => {
    expect(check.Check({ ...base, cc: "a@example.com, b@example.com" })).toBe(true);
  });

  for (const field of ["cc", "bcc", "subject", "replyTo"] as const) {
    test(`rejects a CR in ${field}`, () => {
      expect(check.Check({ ...base, [field]: "x\r@example.com" })).toBe(false);
    });

    test(`rejects an LF in ${field}`, () => {
      expect(check.Check({ ...base, [field]: "x\n@example.com" })).toBe(false);
    });

    test(`rejects an injected header line in ${field}`, () => {
      expect(
        check.Check({ ...base, [field]: "a@example.com\r\nBcc: victim@example.com" }),
      ).toBe(false);
    });
  }

  test("rejects an over-long cc value", () => {
    expect(check.Check({ ...base, cc: "a@example.com,".repeat(200) })).toBe(false);
  });

  test("accepts a comma-separated replyTo list (#169)", () => {
    expect(
      check.Check({ ...base, replyTo: "support@example.com, sales@example.com" }),
    ).toBe(true);
  });

  test("rejects an over-long replyTo value (#169)", () => {
    expect(check.Check({ ...base, replyTo: "a@example.com,".repeat(200) })).toBe(false);
  });
});

describe("sendEmailDto: template variable caps", () => {
  test("accepts up to 100 variables", () => {
    const variables = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`v${i}`, "x"]),
    );
    expect(check.Check({ ...base, templateId: "tpl_x", variables })).toBe(true);
  });

  test("rejects more than 100 variables", () => {
    const variables = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`v${i}`, "x"]),
    );
    expect(check.Check({ ...base, templateId: "tpl_x", variables })).toBe(false);
  });

  test("rejects a variable value over 100 KB", () => {
    expect(
      check.Check({
        ...base,
        templateId: "tpl_x",
        variables: { a: "x".repeat(100_001) },
      }),
    ).toBe(false);
  });
});

describe("sendEmailDto: custom headers syntax (#177)", () => {
  const withHeaders = (headers: Record<string, string>) => ({ ...base, headers });

  test("accepts application and threading headers", () => {
    expect(
      check.Check(
        withHeaders({
          "X-Correlation-Id": "abc",
          "In-Reply-To": "<p@example.com>",
          "X-Tab": "a\tb",
        }),
      ),
    ).toBe(true);
  });

  test.each([
    ["CRLF", "v\r\nBcc: victim@example.com"],
    ["CR", "v\rBcc: victim@example.com"],
    ["LF", "v\nBcc: victim@example.com"],
    ["NUL", "v\u0000"],
    ["ESC", "v\u001b"],
    ["DEL", "v\u007f"],
    ["NEL", "v\u0085"],
    ["line separator", "v\u2028"],
  ])("rejects a value with %s", (_label, value) => {
    expect(check.Check(withHeaders({ "X-A": value }))).toBe(false);
  });

  test("rejects a value over 998 characters", () => {
    expect(check.Check(withHeaders({ "X-A": "v".repeat(999) }))).toBe(false);
  });

  test.each(["X-A:B", "X A", "X-A\r\nBcc", "X-Ä", `X-${"a".repeat(63)}`])(
    "rejects the name %p",
    (name) => {
      expect(check.Check(withHeaders({ [name]: "v" }))).toBe(false);
    },
  );

  test("rejects more than 20 headers", () => {
    const headers = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`X-H${i}`, "v"]),
    );
    expect(check.Check(withHeaders(headers))).toBe(false);
  });

  test("rejects a non-string value", () => {
    expect(check.Check({ ...base, headers: { "X-A": 1 } })).toBe(false);
  });
});

describe("sendEmailDto: fromName and category (#250)", () => {
  test("accepts both", () => {
    expect(check.Check({ ...base, fromName: "Acme", category: "transactional" })).toBe(
      true,
    );
    expect(check.Check({ ...base, category: "marketing" })).toBe(true);
  });

  test("rejects an unknown category", () => {
    expect(check.Check({ ...base, category: "newsletter" })).toBe(false);
    expect(check.Check({ ...base, category: "Marketing" })).toBe(false);
  });

  test("rejects a non-string or over-long raw fromName (the rules run in createEmail)", () => {
    expect(check.Check({ ...base, fromName: 1 })).toBe(false);
    expect(check.Check({ ...base, fromName: "a".repeat(1001) })).toBe(false);
  });
});
