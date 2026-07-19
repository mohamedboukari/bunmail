import { describe, test, expect } from "bun:test";
import {
  dedupeJoin,
  buildSubmissionInput,
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

describe("buildSubmissionInput — sender resolution", () => {
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

describe("buildSubmissionInput — recipients & BCC preservation", () => {
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

describe("buildSubmissionInput — body & subject passthrough", () => {
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
