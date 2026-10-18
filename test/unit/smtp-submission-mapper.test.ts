import { describe, test, expect } from "bun:test";
import {
  dedupeJoin,
  buildSubmissionInput,
  selectRelayHeaders,
} from "../../src/modules/smtp-submission/message-mapper.ts";

/**
 * Unit tests for the SMTP submission message mapper (#120).
 *
 * The mapper is the pure core of the submission server: it turns the raw
 * addresses extracted from a parsed message + SMTP envelope into a
 * `SendEmailInput`, applying sender resolution, BCC preservation, and the
 * To fallback. It has no I/O, so we can exercise every branch directly
 * without starting a server or touching the DB.
 */

describe("dedupeJoin", () => {
  test("dedupes case-insensitively, first occurrence wins, preserves order", () => {
    expect(dedupeJoin(["A@x.com", "b@x.com", "a@X.com"])).toBe("A@x.com, b@x.com");
  });

  test("trims whitespace and drops empty entries", () => {
    expect(dedupeJoin([" a@x.com ", "", "  ", "b@x.com"])).toBe("a@x.com, b@x.com");
  });

  test("empty input yields empty string", () => {
    expect(dedupeJoin([])).toBe("");
  });
});

describe("buildSubmissionInput: sender resolution", () => {
  test("prefers the From header over the envelope sender", () => {
    const input = buildSubmissionInput({
      fromHeader: "header@x.com",
      envelopeFrom: "envelope@x.com",
      toHeader: ["to@y.com"],
      ccHeader: [],
      envelopeRecipients: ["to@y.com"],
    });
    expect(input.from).toBe("header@x.com");
  });

  test("falls back to the envelope MAIL FROM when no From header", () => {
    const input = buildSubmissionInput({
      envelopeFrom: "envelope@x.com",
      toHeader: ["to@y.com"],
      ccHeader: [],
      envelopeRecipients: ["to@y.com"],
    });
    expect(input.from).toBe("envelope@x.com");
  });

  test("throws when neither From header nor envelope sender is present", () => {
    expect(() =>
      buildSubmissionInput({
        toHeader: ["to@y.com"],
        ccHeader: [],
        envelopeRecipients: ["to@y.com"],
      }),
    ).toThrow(/Missing sender/);
  });
});

describe("buildSubmissionInput: Reply-To (#169)", () => {
  test("maps the Reply-To header through, deduped", () => {
    const input = buildSubmissionInput({
      fromHeader: "s@x.com",
      toHeader: ["a@y.com"],
      ccHeader: [],
      replyToHeader: ["help@x.com", "HELP@x.com", "sales@x.com"],
      envelopeRecipients: ["a@y.com"],
    });
    expect(input.replyTo).toBe("help@x.com, sales@x.com");
  });

  test("absent or empty Reply-To yields undefined", () => {
    const base = {
      fromHeader: "s@x.com",
      toHeader: ["a@y.com"],
      ccHeader: [],
      envelopeRecipients: ["a@y.com"],
    };
    expect(buildSubmissionInput(base).replyTo).toBeUndefined();
    expect(buildSubmissionInput({ ...base, replyToHeader: [] }).replyTo).toBeUndefined();
  });

  test("a Reply-To address is never treated as a recipient or BCC", () => {
    const input = buildSubmissionInput({
      fromHeader: "s@x.com",
      toHeader: ["a@y.com"],
      ccHeader: [],
      replyToHeader: ["help@x.com"],
      envelopeRecipients: ["a@y.com"],
    });
    expect(input.to).toBe("a@y.com");
    expect(input.bcc).toBeUndefined();
  });
});

describe("buildSubmissionInput: recipients & BCC preservation", () => {
  test("maps visible To/Cc from headers", () => {
    const input = buildSubmissionInput({
      fromHeader: "s@x.com",
      toHeader: ["a@y.com"],
      ccHeader: ["c@z.com"],
      envelopeRecipients: ["a@y.com", "c@z.com"],
    });
    expect(input.to).toBe("a@y.com");
    expect(input.cc).toBe("c@z.com");
    expect(input.bcc).toBeUndefined();
  });

  test("envelope recipient absent from To/Cc becomes BCC", () => {
    const input = buildSubmissionInput({
      fromHeader: "s@x.com",
      toHeader: ["a@y.com"],
      ccHeader: [],
      envelopeRecipients: ["a@y.com", "secret@hidden.com"],
    });
    expect(input.to).toBe("a@y.com");
    expect(input.bcc).toBe("secret@hidden.com");
  });

  test("BCC match against To/Cc is case-insensitive (not double-counted)", () => {
    const input = buildSubmissionInput({
      fromHeader: "s@x.com",
      toHeader: ["Alice@Y.com"],
      ccHeader: [],
      envelopeRecipients: ["alice@y.com"],
    });
    expect(input.to).toBe("Alice@Y.com");
    expect(input.bcc).toBeUndefined();
  });

  test("no To header → non-BCC envelope recipients become the To field", () => {
    const input = buildSubmissionInput({
      fromHeader: "s@x.com",
      toHeader: [],
      ccHeader: [],
      envelopeRecipients: ["only@env.com"],
    });
    expect(input.to).toBe("only@env.com");
    expect(input.bcc).toBeUndefined();
  });

  test("delivers only to envelope recipients: header-only addresses are dropped", () => {
    /** One RCPT plus a long To header must not fan out past the envelope. */
    const header = Array.from({ length: 1000 }, (_, i) => `victim${i}@example.org`);
    const input = buildSubmissionInput({
      fromHeader: "s@x.com",
      toHeader: ["a@y.com", ...header],
      ccHeader: ["c@z.com", "extra@example.org"],
      envelopeRecipients: ["a@y.com", "c@z.com"],
    });
    expect(input.to).toBe("a@y.com");
    expect(input.cc).toBe("c@z.com");
    expect(input.bcc).toBeUndefined();
  });

  test("rejects headers that name recipients when none is in the envelope", () => {
    /** Showing the envelope in To instead would expose blind recipients. */
    expect(() =>
      buildSubmissionInput({
        fromHeader: "s@x.com",
        toHeader: ["list@example.org"],
        ccHeader: [],
        envelopeRecipients: ["hidden1@example.com", "hidden2@example.com"],
      }),
    ).toThrow(/RCPT TO/);
  });

  test("throws when there are no recipients at all", () => {
    expect(() =>
      buildSubmissionInput({
        fromHeader: "s@x.com",
        toHeader: [],
        ccHeader: [],
        envelopeRecipients: [],
      }),
    ).toThrow(/No recipients/);
  });
});

describe("buildSubmissionInput: body & subject passthrough", () => {
  test("passes subject/html/text through; empty subject defaults to ''", () => {
    const input = buildSubmissionInput({
      fromHeader: "s@x.com",
      toHeader: ["a@y.com"],
      ccHeader: [],
      envelopeRecipients: ["a@y.com"],
      html: "<p>hi</p>",
      text: "hi",
    });
    expect(input.subject).toBe("");
    expect(input.html).toBe("<p>hi</p>");
    expect(input.text).toBe("hi");
  });
});

describe("selectRelayHeaders (#177)", () => {
  /** mailparser's `headerLines` shape: lowercase key plus the raw line. */
  const line = (raw: string) => ({
    key: raw.slice(0, raw.indexOf(":")).toLowerCase(),
    line: raw,
  });

  test("relays In-Reply-To, References and X-* only", () => {
    const { headers, dropped } = selectRelayHeaders([
      line("From: a@example.com"),
      line("Received: from evil"),
      line("Content-Type: text/plain"),
      line("List-Unsubscribe: <mailto:evil@example.com>"),
      line("In-Reply-To: <parent@example.com>"),
      line("References: <a@example.com> <b@example.com>"),
      line("X-Foo: bar"),
    ]);
    expect(headers).toEqual({
      "In-Reply-To": "<parent@example.com>",
      References: "<a@example.com> <b@example.com>",
      "X-Foo": "bar",
    });
    expect(dropped).toEqual([]);
  });

  test("unfolds continuation lines and trims the value", () => {
    const { headers } = selectRelayHeaders([
      line("References: <a@example.com>\r\n <b@example.com>\r\n\t<c@example.com>  "),
    ]);
    expect(headers).toEqual({
      References: "<a@example.com> <b@example.com>\t<c@example.com>",
    });
  });

  test("drops X-BunMail-* as reserved, reporting the name only", () => {
    const { headers, dropped } = selectRelayHeaders([
      line("X-BunMail-Foo: spoofed"),
      line("X-Ok: 1"),
    ]);
    expect(headers).toEqual({ "X-Ok": "1" });
    expect(dropped).toEqual([{ name: "X-BunMail-Foo", problem: "reserved" }]);
  });

  test("drops a value that still holds a bare line break after unfolding", () => {
    const { headers, dropped } = selectRelayHeaders([
      line("X-Bad: v\nBcc: victim@example.com"),
    ]);
    expect(headers).toBeUndefined();
    expect(dropped).toEqual([{ name: "X-Bad", problem: "invalid_value" }]);
  });

  test("drops duplicates and anything past the count cap", () => {
    const lines = [line("X-Dup: 1"), line("x-dup: 2")];
    for (let i = 0; i < 25; i++) lines.push(line(`X-H${i}: v`));
    const { headers, dropped } = selectRelayHeaders(lines);
    expect(Object.keys(headers ?? {})).toHaveLength(20);
    expect(dropped[0]).toEqual({ name: "x-dup", problem: "duplicate" });
    expect(dropped.filter((d) => d.problem === "too_many")).toHaveLength(6);
  });

  test("no relayable headers: headers is undefined", () => {
    expect(selectRelayHeaders([line("Subject: hi")]).headers).toBeUndefined();
  });

  test("buildSubmissionInput passes the headers through", () => {
    const input = buildSubmissionInput({
      fromHeader: "a@x.com",
      toHeader: ["b@y.com"],
      ccHeader: [],
      envelopeRecipients: ["b@y.com"],
      headers: { "X-Foo": "bar" },
    });
    expect(input.headers).toEqual({ "X-Foo": "bar" });
  });
});
