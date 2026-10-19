import { describe, test, expect } from "bun:test";
import {
  isFeedbackReport,
  parseFeedbackReport,
} from "../../src/modules/inbound/services/arf-parser.service.ts";
import { parseBounce } from "../../src/modules/bounces/services/bounce-parser.service.ts";

/**
 * Unit tests for the ARF parser (RFC 5965, #191). Pure function: fixture
 * strings in, parsed report out. The fixtures are written for these tests
 * in the shape Yahoo/AOL and Microsoft JMRP send (example.com addresses,
 * no real provider data).
 */

/** Yahoo/AOL Complaint Feedback Loop style, with `Original-Rcpt-To` present. */
const YAHOO_STYLE = `Return-Path: <>
From: "Mail AntiSpam Feedback" <feedback@arf.mail.example.net>
To: fbl@example.com
Subject: FW: Your weekly digest
Date: Mon, 19 Oct 2026 10:05:00 +0000
Message-ID: <report-0001@arf.mail.example.net>
MIME-Version: 1.0
Content-Type: multipart/report; report-type=feedback-report;
\tboundary="----=_Part_1234_5678"

------=_Part_1234_5678
Content-Type: text/plain; charset=us-ascii
Content-Transfer-Encoding: 7bit

This is an email abuse report for an email message received from IP
192.0.2.10 on Mon, 19 Oct 2026 10:00:00 +0000.

------=_Part_1234_5678
Content-Type: message/feedback-report

Feedback-Type: abuse
User-Agent: Example-Mail-Feedback/2.0
Version: 0.1
Original-Mail-From: <bounce@example.com>
Original-Rcpt-To: Reader@Example.org
Arrival-Date: Mon, 19 Oct 2026 10:00:00 +0000
Reported-Domain: example.com
Source-IP: 192.0.2.10

------=_Part_1234_5678
Content-Type: message/rfc822
Content-Disposition: inline

Received: from mail.example.com (mail.example.com [192.0.2.10])
\tby mx.example.net; Mon, 19 Oct 2026 10:00:00 +0000
From: hello@example.com
To: reader@example.org
Subject: Your weekly digest
Message-ID: <0a1b2c3d4e5f@mail.example.com>

[body redacted]
------=_Part_1234_5678--
`;

/** Microsoft JMRP style: CRLF line ends, no Original-Rcpt-To, full original. */
const JMRP_STYLE = [
  "From: staff@hotmail.example",
  "To: jmrp@example.com",
  "Subject: complaint about message from 192.0.2.10",
  "MIME-Version: 1.0",
  'Content-Type: multipart/report; report-type="feedback-report"; boundary="JMRP_BND"',
  "",
  "--JMRP_BND",
  "Content-Type: text/plain",
  "",
  "This is an email abuse report for an email message received from IP 192.0.2.10.",
  "--JMRP_BND",
  "Content-Type: message/feedback-report",
  "",
  "Feedback-Type: abuse",
  "User-Agent: Junk Mail Reporting Program",
  "Version: 1.0",
  "Original-Mail-From: <bounce@example.com>",
  "Arrival-Date: Mon, 19 Oct 2026 09:00:00 -0700",
  "Source-IP: 192.0.2.10",
  "--JMRP_BND",
  "Content-Type: message/rfc822",
  "",
  "X-HmXmrOriginalRecipient: <someone@hotmail.example>",
  "From: hello@example.com",
  "Subject: Hello",
  "Message-Id: <ffee99@mail.example.com>",
  "",
  "Original body.",
  "--JMRP_BND--",
  "",
].join("\r\n");

/** A minimal report with a headers-only third part and a custom feedback part. */
function report(opts: {
  contentType?: string;
  feedback: string;
  third?: string;
  boundary?: string;
}): string {
  const boundary = opts.boundary ?? "bnd";
  return `From: fbl@isp.example.net
To: fbl@example.com
Subject: report
Content-Type: ${opts.contentType ?? `multipart/report; report-type=feedback-report; boundary="${boundary}"`}

--${boundary}
Content-Type: text/plain

A report.
--${boundary}
Content-Type: message/feedback-report

${opts.feedback}
--${boundary}
${
  opts.third ??
  `Content-Type: text/rfc822-headers

From: hello@example.com
Message-ID: <third-part@mail.example.com>
`
}
--${boundary}--
`;
}

describe("isFeedbackReport", () => {
  test("recognises Yahoo- and JMRP-style reports", () => {
    expect(isFeedbackReport(YAHOO_STYLE)).toBe(true);
    expect(isFeedbackReport(JMRP_STYLE)).toBe(true);
  });

  test("case variations of the type and parameter", () => {
    const raw = report({
      feedback: "Feedback-Type: abuse",
      contentType: 'Multipart/Report; Report-Type="Feedback-Report"; Boundary="bnd"',
    });
    expect(isFeedbackReport(raw)).toBe(true);
  });

  test("a DSN, plain mail, or another report type is not one", () => {
    expect(
      isFeedbackReport(
        report({
          feedback: "Feedback-Type: abuse",
          contentType: 'multipart/report; report-type=delivery-status; boundary="bnd"',
        }),
      ),
    ).toBe(false);
    expect(isFeedbackReport("From: a@example.com\nSubject: hi\n\nfeedback-report")).toBe(
      false,
    );
    expect(isFeedbackReport("")).toBe(false);
  });

  test("only the top-level Content-Type counts, not a nested one", () => {
    const raw = `From: a@example.com
Content-Type: multipart/mixed; boundary="outer"

--outer
Content-Type: multipart/report; report-type=feedback-report; boundary="bnd"

--outer--
`;
    expect(isFeedbackReport(raw)).toBe(false);
  });
});

describe("parseFeedbackReport: provider shapes", () => {
  test("Yahoo style: every field, folded Content-Type, Message-ID from the third part", () => {
    expect(parseFeedbackReport(YAHOO_STYLE)).toEqual({
      feedbackType: "abuse",
      userAgent: "Example-Mail-Feedback/2.0",
      version: "0.1",
      originalMailFrom: "bounce@example.com",
      originalRcptTo: ["reader@example.org"],
      arrivalDate: new Date("2026-10-19T10:00:00Z"),
      reportedDomain: "example.com",
      sourceIp: "192.0.2.10",
      originalMessageId: "0a1b2c3d4e5f@mail.example.com",
      reporterDomain: "arf.mail.example.net",
    });
  });

  test("Yahoo style with Original-Rcpt-To redacted: no recipient kept", () => {
    const raw = YAHOO_STYLE.replace(
      "Original-Rcpt-To: Reader@Example.org",
      "Original-Rcpt-To: redacted",
    );
    expect(parseFeedbackReport(raw)?.originalRcptTo).toEqual([]);
  });

  test("JMRP style: CRLF, quoted report-type, no Original-Rcpt-To, Message-Id in any case", () => {
    const parsed = parseFeedbackReport(JMRP_STYLE);
    expect(parsed).toMatchObject({
      feedbackType: "abuse",
      userAgent: "Junk Mail Reporting Program",
      originalRcptTo: [],
      originalMessageId: "ffee99@mail.example.com",
      reporterDomain: "hotmail.example",
      arrivalDate: new Date("2026-10-19T16:00:00Z"),
    });
  });

  test("text/rfc822-headers third part", () => {
    expect(
      parseFeedbackReport(report({ feedback: "Feedback-Type: abuse" }))
        ?.originalMessageId,
    ).toBe("third-part@mail.example.com");
  });

  test("Original-Message-ID in the feedback part wins over the third part", () => {
    const parsed = parseFeedbackReport(
      report({
        feedback: "Feedback-Type: abuse\nOriginal-Message-ID: <fb-part@mail.example.com>",
      }),
    );
    expect(parsed?.originalMessageId).toBe("fb-part@mail.example.com");
  });

  test("repeated Original-Rcpt-To, in several forms", () => {
    const parsed = parseFeedbackReport(
      report({
        feedback: [
          "Feedback-Type: abuse",
          "Original-Rcpt-To: <One@example.org>",
          "Original-Rcpt-To: rfc822; two@example.org",
          "Original-Rcpt-To: not-an-address",
          "Original-Rcpt-To: three@example.org",
        ].join("\n"),
      }),
    );
    expect(parsed?.originalRcptTo).toEqual([
      "one@example.org",
      "two@example.org",
      "three@example.org",
    ]);
  });

  test("folded feedback fields and field names in any case", () => {
    const parsed = parseFeedbackReport(
      report({
        feedback: [
          "FEEDBACK-TYPE: Fraud",
          "user-agent: Example-Feedback",
          "  /3.1",
          "ORIGINAL-RCPT-TO:",
          "\treader@example.org",
        ].join("\n"),
      }),
    );
    expect(parsed).toMatchObject({
      feedbackType: "fraud",
      userAgent: "Example-Feedback /3.1",
      originalRcptTo: ["reader@example.org"],
    });
  });

  test("base64 feedback part", () => {
    const fields = "Feedback-Type: opt-out\nOriginal-Rcpt-To: reader@example.org\n";
    const raw = report({ feedback: "" }).replace(
      "Content-Type: message/feedback-report\n\n",
      `Content-Type: message/feedback-report\nContent-Transfer-Encoding: base64\n\n${Buffer.from(fields).toString("base64")}`,
    );
    expect(parseFeedbackReport(raw)).toMatchObject({
      feedbackType: "opt-out",
      originalRcptTo: ["reader@example.org"],
    });
  });

  test("Received-Date is read when Arrival-Date is missing", () => {
    const parsed = parseFeedbackReport(
      report({
        feedback: "Feedback-Type: abuse\nReceived-Date: Tue, 20 Oct 2026 08:00:00 +0000",
      }),
    );
    expect(parsed?.arrivalDate).toEqual(new Date("2026-10-20T08:00:00Z"));
  });
});

describe("parseFeedbackReport: missing or bad fields", () => {
  test("no Original-Message-ID anywhere: originalMessageId is null", () => {
    const parsed = parseFeedbackReport(
      report({
        feedback: "Feedback-Type: abuse",
        third: "Content-Type: text/rfc822-headers\n\nFrom: hello@example.com\n",
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.originalMessageId).toBeNull();
  });

  test("missing or empty Feedback-Type is null", () => {
    expect(parseFeedbackReport(report({ feedback: "Version: 1" }))?.feedbackType).toBe(
      null,
    );
    expect(
      parseFeedbackReport(report({ feedback: "Feedback-Type:   \nVersion: 1" }))
        ?.feedbackType,
    ).toBe(null);
  });

  test("an unparseable date or a Message-ID with spaces is null", () => {
    const parsed = parseFeedbackReport(
      report({
        feedback:
          "Feedback-Type: abuse\nArrival-Date: yesterday-ish\nOriginal-Message-ID: not an id",
      }),
    );
    expect(parsed?.arrivalDate).toBeNull();
    /** Falls back to the third part's Message-ID. */
    expect(parsed?.originalMessageId).toBe("third-part@mail.example.com");
  });

  test("a Message-ID longer than any stored one is ignored", () => {
    const parsed = parseFeedbackReport(
      report({
        feedback: `Feedback-Type: abuse\nOriginal-Message-ID: <${"a".repeat(300)}@example.com>`,
        third: "Content-Type: text/rfc822-headers\n\nFrom: hello@example.com\n",
      }),
    );
    expect(parsed?.originalMessageId).toBeNull();
  });

  test("no message/feedback-report part: null", () => {
    const raw = report({ feedback: "Feedback-Type: abuse" }).replace(
      "message/feedback-report",
      "text/plain",
    );
    expect(parseFeedbackReport(raw)).toBeNull();
  });

  test("no boundary, or an oversized one: null", () => {
    expect(
      parseFeedbackReport(
        report({
          feedback: "Feedback-Type: abuse",
          contentType: "multipart/report; report-type=feedback-report",
        }),
      ),
    ).toBeNull();
    const long = "b".repeat(500);
    expect(
      parseFeedbackReport(report({ feedback: "Feedback-Type: abuse", boundary: long })),
    ).toBeNull();
  });

  test("not a feedback report at all: null", () => {
    expect(parseFeedbackReport("From: a@example.com\n\nhello")).toBeNull();
  });
});

describe("parseFeedbackReport: bounded on hostile input", () => {
  const TEN_MB = 10 * 1024 * 1024;
  const BUDGET_MS = 1000;
  const RUNNER_TIMEOUT_MS = 30_000;

  function timed(raw: string): number {
    const start = performance.now();
    isFeedbackReport(raw);
    parseFeedbackReport(raw);
    return performance.now() - start;
  }

  test.each([
    [
      "10 MB of boundary delimiters",
      () => report({ feedback: "Feedback-Type: abuse" }) + "--bnd\n".repeat(TEN_MB / 6),
    ],
    [
      "one 10 MB header line",
      () =>
        "Content-Type: multipart/report; report-type=feedback-report; boundary=b" +
        "x".repeat(TEN_MB),
    ],
    [
      "10 MB of header fields",
      () =>
        "X-A: b\n".repeat(TEN_MB / 7) +
        "Content-Type: multipart/report; report-type=feedback-report; boundary=b\n\n",
    ],
    [
      "a 10 MB feedback part of fields",
      () =>
        report({
          feedback: "Original-Rcpt-To: " + "a".repeat(200) + "\n".repeat(1),
        }).replace(
          "Content-Type: message/feedback-report\n\n",
          "Content-Type: message/feedback-report\n\n" +
            "Original-Rcpt-To: a@b.example\n".repeat(TEN_MB / 30),
        ),
    ],
    [
      "a 10 MB folded field",
      () =>
        report({
          feedback: "Feedback-Type: abuse\nUser-Agent: x\n" + " y\n".repeat(TEN_MB / 3),
        }),
    ],
    [
      "a 10 MB embedded message",
      () =>
        report({
          feedback: "Feedback-Type: abuse",
          third: "Content-Type: message/rfc822\n\nSubject: x\n" + "z".repeat(TEN_MB),
        }),
    ],
  ])(
    "%s",
    (_name, build) => {
      const raw = build();
      expect(timed(raw)).toBeLessThan(BUDGET_MS);
    },
    RUNNER_TIMEOUT_MS,
  );

  test("field counts and lengths are capped", () => {
    const parsed = parseFeedbackReport(
      report({
        feedback:
          "Feedback-Type: abuse\n" +
          `User-Agent: ${"u".repeat(5000)}\n` +
          Array.from(
            { length: 120 },
            (_, i) => `Original-Rcpt-To: r${i}@example.org`,
          ).join("\n"),
      }),
    );
    expect(parsed?.userAgent?.length).toBe(1000);
    expect(parsed?.originalRcptTo.length).toBe(50);
  });
});

describe("parseBounce no longer takes an ARF report (#191)", () => {
  test("a feedback report is not a bounce", () => {
    expect(parseBounce(YAHOO_STYLE)).toBeNull();
    expect(parseBounce(JMRP_STYLE)).toBeNull();
  });

  test("even one whose reported message reads like a bounce to the fallback parser", () => {
    /** A status-code-shaped string and an address in the reported body used
     *  to send the report into `parseFallback`, linked by its own Message-ID. */
    const raw = YAHOO_STYLE.replace(
      "[body redacted]",
      "Order 4.2.1 is on its way to <reader@example.org>.",
    );
    expect(parseBounce(raw)).toBeNull();
  });
});
