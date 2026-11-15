import { describe, test, expect } from "bun:test";
import {
  verifyReportDkim,
  type DkimCheck,
} from "../../src/modules/inbound/services/feedback-handler.service.ts";
import {
  readSignedHeaderView,
  verifyFeedbackReport,
  type SignedHeaderView,
} from "../../src/modules/inbound/services/feedback-verification.service.ts";
import {
  mailboxAddress,
  parseFeedbackReport,
} from "../../src/modules/inbound/services/arf-parser.service.ts";
import {
  ARF_FROM,
  arfReport,
  arfResolveTxt,
  signArf,
  signArfWith,
} from "../signed-arf.ts";

/**
 * The header fields a verified complaint relies on are read the way the
 * DKIM verifier reads them (`readSignedHeaderView`), so they are the
 * instances a signature covers. Real signatures (a test key), the real
 * DKIM check and the real rule: a report whose `From` or `Content-Type`
 * could be read in more than one way is never verified.
 */

/** The trusted feedback-loop signer and its sender. */
const SIGNER = "fbl.isp.example.net";
const POLICY = { domains: [SIGNER], senders: [ARF_FROM] };

/** Another address at the same signer: not a listed sender. */
const OTHER = "user@fbl.isp.example.net";

/** The signed `From` line of a report from {@link OTHER}, as `arfReport` writes it. */
const OTHER_FROM_LINE = `\r\nFrom: "Feedback Loop" <${OTHER}>`;

/** A report from {@link OTHER}, as the signer would sign it. */
function reportFromOther(): string {
  return arfReport({
    originalMessageId: "abc@mail.example.com",
    rcptTo: "reader@example.org",
    from: OTHER,
  });
}

/** Header names a plain (not over-signing) signer covers. */
const PLAIN_HEADERS = [
  "from",
  "to",
  "subject",
  "date",
  "message-id",
  "mime-version",
  "content-type",
];

/** The DKIM check, the signed header view and the rule on `bytes`. */
async function decide(bytes: Buffer): Promise<{
  dkim: DkimCheck;
  headers: SignedHeaderView;
  verdict: ReturnType<typeof verifyFeedbackReport>;
}> {
  const dkim = await verifyReportDkim(bytes.toString("utf-8"), bytes, {
    resolveTxt: arfResolveTxt([SIGNER]),
  });
  const headers = readSignedHeaderView(bytes);
  const verdict = verifyFeedbackReport({ dkim, headers, envelopeFrom: null }, POLICY);
  return { dkim, headers, verdict };
}

/** `signed` with its signed `From` line replaced by `lines` (latin1). */
function withFromLines(signed: Buffer, lines: string): Buffer {
  const text = signed.toString("latin1");
  expect(text).toContain(OTHER_FROM_LINE);
  return Buffer.from(text.replace(OTHER_FROM_LINE, lines), "latin1");
}

describe("the signed header view of a well-formed report", () => {
  test("a report from the listed sender is verified, plain and over-signed", async () => {
    const report = arfReport({
      originalMessageId: "abc@mail.example.com",
      rcptTo: "r@example.org",
    });
    for (const signed of [
      signArf(report, SIGNER),
      signArfWith(report, SIGNER, { headers: PLAIN_HEADERS }),
    ]) {
      const { headers, verdict } = await decide(signed);
      expect(headers).toEqual({ from: ARF_FROM, contentTypeSingle: true });
      expect(verdict).toEqual({ verified: true, signingDomain: SIGNER });
    }
  });

  test("a report from another address at the signer is not", async () => {
    const { verdict } = await decide(signArf(reportFromOther(), SIGNER));
    expect(verdict).toEqual({ verified: false, reason: "sender_not_listed" });
  });
});

describe("a From field the signature does not cover is not trusted", () => {
  test("only the signed From instance counts", async () => {
    const signed = signArfWith(reportFromOther(), SIGNER, { headers: PLAIN_HEADERS });
    const bytes = withFromLines(
      signed,
      `\r\nFrom: ${ARF_FROM}\r\nFrom${" ".repeat(80)}: "Feedback Loop" <${OTHER}>`,
    );
    const { dkim, headers, verdict } = await decide(bytes);
    /** The signature still verifies: only an unsigned field was added. */
    expect(dkim.passingDomains).toEqual([SIGNER]);
    expect(headers.from).toBeNull();
    expect(verdict).toEqual({ verified: false, reason: "sender_missing" });
  });

  test("an unsigned From and Content-Type ahead of many other fields are refused", async () => {
    const signed = signArfWith(reportFromOther(), SIGNER, { headers: PLAIN_HEADERS });
    const filler = Array.from({ length: 200 }, (_, i) => `X-Filler-${i}: a`).join("\r\n");
    const bytes = Buffer.concat([
      Buffer.from(
        'Content-Type: multipart/report; report-type=feedback-report; boundary="arf_bnd"\r\n' +
          `From: ${ARF_FROM}\r\n${filler}\r\n`,
        "latin1",
      ),
      signed,
    ]);
    const { dkim, headers, verdict } = await decide(bytes);
    expect(dkim.passingDomains).toEqual([SIGNER]);
    expect(headers).toEqual({ from: null, contentTypeSingle: false });
    expect(verdict.verified).toBe(false);
  });

  test("a From hidden from one reader is refused", async () => {
    const signed = signArfWith(reportFromOther(), SIGNER, { headers: PLAIN_HEADERS });
    for (const odd of ["\x0b", "\x0c", "\xa0", "\x00"]) {
      const bytes = withFromLines(
        signed,
        `\r\nFrom${odd}: ${ARF_FROM}${OTHER_FROM_LINE}`,
      );
      const { dkim, headers, verdict } = await decide(bytes);
      expect(dkim.passingDomains).toEqual([SIGNER]);
      expect(headers.from).toBeNull();
      expect(verdict.verified).toBe(false);
    }
    /** Other bytes before the name. */
    for (const odd of ["\xc2\xa0", "\xef\xbb\xbf"]) {
      const bytes = withFromLines(
        signed,
        `\r\n${odd}From: ${ARF_FROM}${OTHER_FROM_LINE}`,
      );
      expect((await decide(bytes)).verdict.verified).toBe(false);
    }
  });

  test("an unsigned From is refused with an over-signing signer too", async () => {
    const signed = signArf(reportFromOther(), SIGNER);
    const bytes = withFromLines(
      signed,
      `\r\nFrom\x0b: ${ARF_FROM}\r\nFrom${" ".repeat(80)}: "Feedback Loop" <${OTHER}>`,
    );
    const { dkim, headers, verdict } = await decide(bytes);
    expect(dkim.passingDomains).toEqual([SIGNER]);
    expect(headers.from).toBeNull();
    expect(verdict).toEqual({ verified: false, reason: "sender_missing" });
  });

  test("a line folded under another field is part of it, not a second From", () => {
    /** Like a DKIM-Signature whose `h=` list folds before `from:`. */
    const raw = `From: ${ARF_FROM}\r\nX-Note: h=to:\r\n from:subject\r\nContent-Type: text/plain\r\n\r\nbody\r\n`;
    expect(readSignedHeaderView(Buffer.from(raw, "latin1"))).toEqual({
      from: ARF_FROM,
      contentTypeSingle: true,
    });
  });

  test("a From after a bare line break counts as a second From", () => {
    const raw = `From: ${ARF_FROM}\r\nX-Note: a\rFrom: ${OTHER}\r\nContent-Type: text/plain\r\n\r\nbody\r\n`;
    expect(readSignedHeaderView(Buffer.from(raw, "latin1")).from).toBeNull();
  });
});

describe("a Content-Type the signature does not cover is not trusted", () => {
  test("a second top-level Content-Type: content_type_ambiguous", async () => {
    const report = arfReport({
      originalMessageId: "abc@mail.example.com",
      rcptTo: "r@example.org",
    });
    const signed = signArfWith(report, SIGNER, { headers: PLAIN_HEADERS });
    const bytes = Buffer.concat([
      Buffer.from(
        'Content-Type: multipart/report; report-type=feedback-report; boundary="x"\r\n',
      ),
      signed,
    ]);
    const { dkim, headers, verdict } = await decide(bytes);
    expect(dkim.passingDomains).toEqual([SIGNER]);
    expect(headers.contentTypeSingle).toBe(false);
    expect(verdict).toEqual({ verified: false, reason: "content_type_ambiguous" });
  });

  test("a Content-Type hidden from one reader also counts", () => {
    for (const name of [
      `Content-Type${" ".repeat(80)}`,
      "Content-Type\x0b",
      "\x0bcontent-type",
    ]) {
      const raw = `From: ${ARF_FROM}\r\nContent-Type: text/plain\r\n${name}: text/html\r\n\r\nbody\r\n`;
      expect(readSignedHeaderView(Buffer.from(raw, "latin1")).contentTypeSingle).toBe(
        false,
      );
    }
  });
});

/**
 * The `From` value is accepted only when it is plainly one mailbox; the
 * rest is refused, never tokenized.
 */
describe("mailboxAddress", () => {
  test.each([
    ["feedback@fbl.example.net", "feedback@fbl.example.net"],
    ["  Feedback@FBL.Example.NET  ", "feedback@fbl.example.net"],
    ["<feedback@fbl.example.net>", "feedback@fbl.example.net"],
    ["Feedback Loop <feedback@fbl.example.net>", "feedback@fbl.example.net"],
    ['"Loop, Feedback" <feedback@fbl.example.net>', "feedback@fbl.example.net"],
    ["=?utf-8?q?Feedback?= <feedback@fbl.example.net>", "feedback@fbl.example.net"],
    ['"Postmaster (FBL)" <feedback@fbl.example.net>', "feedback@fbl.example.net"],
    ['"Loop <other@example.org>" <feedback@fbl.example.net>', "feedback@fbl.example.net"],
    ["staff@hotmail.example", "staff@hotmail.example"],
    [
      "Yahoo! Mail AntiSpam Feedback <feedback@arf.example.net>",
      "feedback@arf.example.net",
    ],
    ['"Postmaster (FBL)" <fbl@example.net>', "fbl@example.net"],
    ["=?UTF-8?B?RmVlZGJhY2s=?= <fbl@example.net>", "fbl@example.net"],
  ])("%p is %p", (value, address) => {
    expect(mailboxAddress(value)).toBe(address);
  });

  test.each([
    ["a comment", "feedback@fbl.example.net (Loop)"],
    ["a nested comment", "Loop (a (b) c) <feedback@fbl.example.net>"],
    ["a comment after a display name", "Loop (FBL) <feedback@fbl.example.net>"],
    ["an escaped backslash in a quoted name", '"Loop\\\\" <feedback@fbl.example.net>'],
    ["a parenthesis outside the quotes", '"Loop" ) <feedback@fbl.example.net>'],
    [
      "a quoted string after the address",
      'staff@hotmail.example"<user@hotmail.example>"',
    ],
    [
      "a quoted string before a bare address",
      '"<user@hotmail.example>"staff@hotmail.example',
    ],
    ["a quoted string inside the address", 'sta"x"ff@hotmail.example'],
    ["text after the closing bracket", "Loop <feedback@fbl.example.net> x"],
    ["a quote inside the brackets", '<"user"@fbl.example.net>'],
    ["a backslash", '"Loop\\" <x@y>" <feedback@fbl.example.net>'],
    ["a list", "feedback@fbl.example.net, other@example.org"],
    ["a group", "Loop: feedback@fbl.example.net;"],
    ["an unterminated quote", '"Loop <feedback@fbl.example.net>'],
    ["two angle addresses", "<feedback@fbl.example.net> <other@example.org>"],
    ["a non-ASCII address (KELVIN SIGN)", "feedbacK@fbl.example.net"],
    ["a non-ASCII domain", "feedback@fbl.exämple.net"],
    ["no address", "Feedback Loop"],
    ["an empty value", ""],
  ])("refuses %s", (_label, value) => {
    expect(mailboxAddress(value)).toBeNull();
  });

  test("a value at the length cap is refused (it may have been cut)", () => {
    const long = `${"N".repeat(1000)} <feedback@fbl.example.net>`;
    expect(mailboxAddress(long)).toBeNull();
    expect(mailboxAddress(long.slice(0, 1000))).toBeNull();
  });
});

/**
 * A relaxed DKIM signature (`c=relaxed/relaxed`, what most providers use)
 * still verifies after whitespace changes in the body: runs of spaces or
 * tabs, spaces at the end of a line, a line of spaces in place of an empty
 * line, empty lines at the end. Whatever the report links to and names must
 * read the same either way.
 */
describe("a body a relaxed signature cannot tell apart parses the same", () => {
  /** A listed sender's report with no Original-Message-ID, about a text email. */
  const GENUINE = [
    `From: ${ARF_FROM}`,
    "To: fbl@example.com",
    "Subject: complaint",
    "Date: Mon, 19 Oct 2026 10:05:00 +0000",
    "Message-ID: <r1@fbl.isp.example.net>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/report; report-type=feedback-report; boundary="arf_bnd"',
    "",
    "--arf_bnd",
    "Content-Type: text/plain",
    "",
    "abuse report",
    "",
    "--arf_bnd",
    "Content-Type: message/feedback-report",
    "",
    "Feedback-Type: abuse",
    "Version: 1",
    "Original-Rcpt-To: reader@example.org",
    "",
    "--arf_bnd",
    "Content-Type: message/rfc822",
    "",
    "From: hello@example.com",
    "To: reader@example.org",
    "Subject: hi",
    "Message-ID: <genuine@mail.example.com>",
    "Content-Type: text/plain",
    "",
    "Message-ID: <other@mail.example.com>",
    "",
    "hello",
    "",
    "--arf_bnd--",
    "",
  ].join("\r\n");

  /** The same body after edits a relaxed body canonicalization ignores. */
  const EDITS: Array<[string, (text: string) => string]> = [
    [
      "a line of spaces in place of an empty line",
      (t) =>
        t.replace(
          "Content-Type: message/rfc822\r\n\r\n",
          "Content-Type: message/rfc822\r\n \t \r\n",
        ),
    ],
    [
      "spaces at the end of lines",
      (t) => t.replaceAll("--arf_bnd\r\n", "--arf_bnd   \r\n"),
    ],
    [
      "longer runs of whitespace",
      (t) =>
        t.replace("Content-Type: message/rfc822", "Content-Type:\t   message/rfc822"),
    ],
    ["empty lines and spaces at the end", (t) => `${t}\r\n  \r\n\r\n`],
    [
      "every empty line in the body",
      (t) => {
        const at = t.indexOf("\r\n\r\n") + 4;
        return t.slice(0, at) + t.slice(at).replaceAll("\r\n\r\n", "\r\n \r\n");
      },
    ],
  ];

  test("the parser reads the same link from each form", () => {
    const genuine = parseFeedbackReport(GENUINE);
    expect(genuine?.originalMessageId).toBe("genuine@mail.example.com");
    for (const [label, edit] of EDITS) {
      expect({ label, report: parseFeedbackReport(edit(GENUINE)) }).toEqual({
        label,
        report: genuine,
      });
    }
  });

  test("a whitespace-only line still ends a header section, and the signature still verifies", async () => {
    const signed = signArfWith(GENUINE, SIGNER, { headers: PLAIN_HEADERS }).toString(
      "latin1",
    );
    for (const [label, edit] of EDITS) {
      const bytes = Buffer.from(edit(signed), "latin1");
      const { dkim, verdict } = await decide(bytes);
      expect({ label, passing: dkim.passingDomains }).toEqual({
        label,
        passing: [SIGNER],
      });
      expect(verdict.verified).toBe(true);
      expect(parseFeedbackReport(bytes.toString("utf-8"))?.originalMessageId).toBe(
        "genuine@mail.example.com",
      );
    }
  });
});
