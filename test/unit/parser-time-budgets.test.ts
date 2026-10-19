import { describe, test, expect } from "bun:test";
import { gzipSync, strToU8 } from "fflate";
import { simpleParser } from "mailparser";
import {
  looksLikeDmarcReport,
  parseAggregateReport,
} from "../../src/modules/dmarc-reports/services/dmarc-parser.service.ts";
import { buildInboundNotification } from "../../src/modules/inbound/services/inbound-notify.service.ts";

/**
 * Time budgets for parsers on the unauthenticated inbound path (#232).
 *
 * Every inbound message (up to the 10 MB SMTP cap) runs through these
 * before any authentication. The inputs are generated at that cap, shaped
 * to stress each parser's regexes and loops, and must finish inside a
 * generous budget so a super-linear regression fails CI instead of being
 * found by whoever sends the first crafted message. The bounce parser has
 * its own budget tests in bounce-parser.test.ts, and the recipient parser
 * in recipients.test.ts.
 *
 * Bun kills a test after 5 s by default, before an assertion budget can
 * report anything useful, so the heavy cases carry an explicit runner
 * timeout. Budgets stay well above the idle timings (10 MB of HTML takes
 * about a second idle and several under full-suite load).
 */

/** Runner timeout for the heavy cases; the assertion budget is separate. */
const RUNNER_TIMEOUT_MS = 30_000;

const TEN_MB = 10 * 1024 * 1024;

function timedSync(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

async function timedAsync(run: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await run();
  return performance.now() - start;
}

describe("looksLikeDmarcReport at 10 MB", () => {
  const BUDGET_MS = 500;

  test.each([
    ["many non-matching Subject lines", () => "Subject: hello\n".repeat(TEN_MB / 15)],
    [
      "many From lines that almost match a reporter",
      () => "From: noreply-dmarc-support@google.com.x\n".repeat(TEN_MB / 40),
    ],
    ["one 10 MB line, no newline", () => "Content-Type: " + "x".repeat(TEN_MB)],
    [
      "zip content type with a huge body",
      () => "Content-Type: application/zip\n\n" + "a ".repeat(TEN_MB / 2),
    ],
  ])("%s", (_name, build) => {
    const raw = build();
    expect(timedSync(() => looksLikeDmarcReport(raw))).toBeLessThan(BUDGET_MS);
  });
});

describe("parseAggregateReport at the decompression cap", () => {
  const BUDGET_MS = 5_000;

  function report(records: number, pad = ""): Uint8Array {
    const record = `<record><row><source_ip>203.0.113.9</source_ip><count>1</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row>
      <identifiers><header_from>example.org</header_from></identifiers>
      <auth_results><dkim><domain>example.org</domain><result>pass</result></dkim>
      <spf><domain>example.org</domain><result>pass</result></spf></auth_results>${pad}</record>`;
    const xml = `<?xml version="1.0"?><feedback><report_metadata><org_name>o</org_name>
      <email>r@example.net</email><report_id>1</report_id>
      <date_range><begin>1</begin><end>2</end></date_range></report_metadata>
      <policy_published><domain>example.org</domain><p>none</p><pct>100</pct></policy_published>
      ${record.repeat(records)}</feedback>`;
    return gzipSync(strToU8(xml));
  }

  test(
    "50k records",
    () => {
      const bytes = report(50_000);
      expect(timedSync(() => parseAggregateReport(bytes))).toBeLessThan(BUDGET_MS);
    },
    RUNNER_TIMEOUT_MS,
  );

  test(
    "records padded with a 1 MB text node",
    () => {
      const bytes = report(1, "<x>" + "p".repeat(1024 * 1024) + "</x>");
      expect(timedSync(() => parseAggregateReport(bytes))).toBeLessThan(BUDGET_MS);
    },
    RUNNER_TIMEOUT_MS,
  );

  test(
    "a gzip bomb just under the cap is rejected quickly",
    () => {
      const bomb = gzipSync(new Uint8Array(24 * 1024 * 1024));
      expect(timedSync(() => parseAggregateReport(bomb))).toBeLessThan(BUDGET_MS);
    },
    RUNNER_TIMEOUT_MS,
  );
});

describe("mailparser at 10 MB (inbound and submission)", () => {
  const BUDGET_MS = 10_000;
  const headers = "From: a@example.org\nTo: b@example.net\nSubject: s\n";

  test.each([
    ["10 MB plain text", () => headers + "\n" + "word ".repeat(TEN_MB / 5)],
    [
      "2 MB HTML body (html-to-text is the slowest step: 10 MB takes seconds under load)",
      () =>
        headers +
        "Content-Type: text/html\n\n<p>" +
        "<b>x</b> ".repeat((2 * 1024 * 1024) / 9) +
        "</p>",
    ],
    ["100k header lines", () => "X-H: v\n".repeat(100_000) + headers + "\nbody"],
    [
      "one header folded over 100k lines",
      () => "Subject: a\n" + " b\n".repeat(100_000) + "\nbody",
    ],
    [
      "10k MIME parts",
      () =>
        'Content-Type: multipart/mixed; boundary="b"\n\n' +
        "--b\nContent-Type: text/plain\n\nx\n".repeat(10_000) +
        "--b--\n",
    ],
    [
      "10 MB base64 attachment",
      () =>
        'Content-Type: multipart/mixed; boundary="b"\n\n--b\nContent-Type: application/octet-stream\n' +
        "Content-Transfer-Encoding: base64\n\n" +
        "QUJDRA==\n".repeat(TEN_MB / 9) +
        "--b--\n",
    ],
  ])(
    "%s",
    async (_name, build) => {
      const raw = build();
      /** mailparser caps the number of MIME parts itself (EMAXLEN); a quick
       *  rejection is as good as a quick parse. Anything else is a bug. */
      const ms = await timedAsync(() =>
        simpleParser(raw).catch((err: unknown) => {
          if (!(err instanceof Error && "code" in err && err.code === "EMAXLEN"))
            throw err;
        }),
      );
      expect(ms).toBeLessThan(BUDGET_MS);
    },
    RUNNER_TIMEOUT_MS,
  );
});

describe("buildInboundNotification with 10 MB fields", () => {
  /**
   * Same budget as the mailparser cases: 3 s was tight enough that CI's
   * coverage instrumentation pushed the 10 MB subject case past it (3.6 s).
   * A super-linear regression at 10 MB takes minutes, so 10 s still catches it.
   */
  const BUDGET_MS = 10_000;

  test.each([
    [
      "10 MB text body",
      { text: "word ".repeat(TEN_MB / 5), subject: "s", from: "a@example.org" },
    ],
    [
      "10 MB subject and from",
      { text: "x", subject: "&<>\"'".repeat(TEN_MB / 5), from: "<".repeat(TEN_MB) },
    ],
    [
      "10 MB of HTML-significant characters in the body",
      { text: "<&>".repeat(TEN_MB / 3), subject: "s", from: "a@example.org" },
    ],
    [
      "10 MB of links in the body and subject (#250)",
      {
        text: "https://x.example/ ".repeat(TEN_MB / 19),
        subject: "www.x.example ".repeat(TEN_MB / 14),
        from: "a@example.org",
      },
    ],
  ])(
    "%s",
    (_name, fields) => {
      expect(
        timedSync(() =>
          buildInboundNotification({
            to: "inbox@example.org",
            detailUrl: null,
            receivedAt: new Date(),
            sizeBytes: TEN_MB,
            /** The preview on: the most work the builder can do. */
            preview: true,
            skipped: null,
            ...fields,
          }),
        ),
      ).toBeLessThan(BUDGET_MS);
    },
    RUNNER_TIMEOUT_MS,
  );
});
