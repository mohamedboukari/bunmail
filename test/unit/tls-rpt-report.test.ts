import { describe, expect, test } from "bun:test";
import {
  buildReport,
  encodeReport,
  reportFilename,
  reportSubject,
  reportTotals,
} from "../../src/modules/tls-rpt/services/tls-rpt-report.ts";
import type { TlsRptResultRow } from "../../src/modules/tls-rpt/types/tls-rpt.types.ts";

/**
 * The report document (RFC 8460 section 4, #345), checked against the
 * shape of the RFC's own example (Appendix B), plus the file name, the
 * subject and the gzip encoding.
 */

const POLICY = {
  policyType: "sts" as const,
  policyHash: "a".repeat(32),
  policyString:
    "version: STSv1\nmode: testing\nmx: *.mail.company-y.example\nmax_age: 86400",
  mxHost: "*.mail.company-y.example",
};

/** The counters behind RFC 8460 Appendix B's example. */
const ROWS: TlsRptResultRow[] = [
  {
    ...POLICY,
    resultType: "success",
    receivingMxHostname: "",
    receivingIp: "",
    failureReasonCode: "",
    sessionCount: 5326,
  },
  {
    ...POLICY,
    resultType: "certificate-expired",
    receivingMxHostname: "mx1.mail.company-y.example",
    receivingIp: "2001:db8:abcd:0013::1",
    failureReasonCode: "",
    sessionCount: 100,
  },
  {
    ...POLICY,
    resultType: "starttls-not-supported",
    receivingMxHostname: "mx2.mail.company-y.example",
    receivingIp: "203.0.113.56",
    failureReasonCode: "",
    sessionCount: 200,
  },
  {
    ...POLICY,
    resultType: "validation-failure",
    receivingMxHostname: "mx-backup.mail.company-y.example",
    receivingIp: "203.0.113.56",
    failureReasonCode: "tls-handshake-failed",
    sessionCount: 3,
  },
];

const INPUT = {
  organizationName: "Company-X",
  contactEmail: "sts-reporting@company-x.example",
  rfcReportId: "5065427c-23d3-47ca-b6e0-946ea0e8c4be",
  day: "2016-04-01",
  policyDomain: "company-y.example",
  results: ROWS,
  sendingIps: ["198.51.100.62", "2001:db8:abcd:0012::1"],
};

describe("buildReport", () => {
  test("the RFC 8460 Appendix B shape", () => {
    expect(buildReport(INPUT)).toEqual({
      "organization-name": "Company-X",
      "date-range": {
        "start-datetime": "2016-04-01T00:00:00Z",
        "end-datetime": "2016-04-01T23:59:59Z",
      },
      "contact-info": "sts-reporting@company-x.example",
      "report-id": "5065427c-23d3-47ca-b6e0-946ea0e8c4be",
      policies: [
        {
          policy: {
            "policy-type": "sts",
            "policy-string": [
              "version: STSv1",
              "mode: testing",
              "mx: *.mail.company-y.example",
              "max_age: 86400",
            ],
            "policy-domain": "company-y.example",
            "mx-host": ["*.mail.company-y.example"],
          },
          summary: {
            "total-successful-session-count": 5326,
            "total-failure-session-count": 303,
          },
          "failure-details": [
            {
              "result-type": "starttls-not-supported",
              "sending-mta-ip": "198.51.100.62",
              "receiving-mx-hostname": "mx2.mail.company-y.example",
              "receiving-ip": "203.0.113.56",
              "failed-session-count": 200,
            },
            {
              "result-type": "certificate-expired",
              "sending-mta-ip": "2001:db8:abcd:0012::1",
              "receiving-mx-hostname": "mx1.mail.company-y.example",
              "receiving-ip": "2001:db8:abcd:0013::1",
              "failed-session-count": 100,
            },
            {
              "result-type": "validation-failure",
              "sending-mta-ip": "198.51.100.62",
              "receiving-mx-hostname": "mx-backup.mail.company-y.example",
              "receiving-ip": "203.0.113.56",
              "failed-session-count": 3,
              "failure-reason-code": "tls-handshake-failed",
            },
          ],
        },
      ],
    });
  });

  test("no-policy-found: no policy string or MX list; no failures, no failure-details", () => {
    const report = buildReport({
      ...INPUT,
      sendingIps: [],
      results: [
        {
          policyType: "no-policy-found",
          policyHash: "b".repeat(32),
          policyString: "",
          mxHost: "",
          resultType: "success",
          receivingMxHostname: "",
          receivingIp: "",
          failureReasonCode: "",
          sessionCount: 7,
        },
      ],
    });
    expect(report.policies).toEqual([
      {
        policy: {
          "policy-type": "no-policy-found",
          "policy-domain": "company-y.example",
        },
        summary: {
          "total-successful-session-count": 7,
          "total-failure-session-count": 0,
        },
      },
    ]);
  });

  test("one entry per policy; fields BunMail does not know are left out", () => {
    const report = buildReport({
      ...INPUT,
      sendingIps: [],
      results: [
        ...ROWS,
        {
          policyType: "no-policy-found",
          policyHash: "c".repeat(32),
          policyString: "",
          mxHost: "",
          resultType: "validation-failure",
          receivingMxHostname: "",
          receivingIp: "",
          failureReasonCode: "mx-not-in-policy",
          sessionCount: 2,
        },
      ],
    });
    expect(report.policies).toHaveLength(2);
    expect(report.policies[1]?.["failure-details"]).toEqual([
      {
        "result-type": "validation-failure",
        "failed-session-count": 2,
        "failure-reason-code": "mx-not-in-policy",
      },
    ]);
    expect(reportTotals(report)).toEqual({ policies: 2, successful: 5326, failed: 305 });
  });
});

describe("delivery parts", () => {
  test("file name: submitter!policy-domain!begin!end.json.gz (RFC 8460 section 5.1)", () => {
    expect(reportFilename("mail.sender.example", "company-y.example", "2016-04-01")).toBe(
      "mail.sender.example!company-y.example!1459468800!1459555199.json.gz",
    );
  });

  test("subject (RFC 8460 section 5.3)", () => {
    expect(reportSubject("company-y.example", "company-x.example", "abc-123")).toBe(
      "Report Domain: company-y.example Submitter: company-x.example Report-ID: <abc-123>",
    );
  });

  test("gzip round trip", () => {
    const report = buildReport(INPUT);
    const body = encodeReport(report);
    expect(body[0]).toBe(0x1f);
    expect(body[1]).toBe(0x8b);
    expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(body)))).toEqual(report);
  });
});
