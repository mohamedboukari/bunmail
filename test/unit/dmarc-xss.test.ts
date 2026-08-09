import { describe, test, expect } from "bun:test";
import { DmarcReportsPage } from "../../src/pages/routes/dmarc-reports.tsx";
import { DmarcReportDetailPage } from "../../src/pages/routes/dmarc-report-detail.tsx";
import type {
  DmarcReport,
  DmarcRecord,
} from "../../src/modules/dmarc-reports/types/dmarc-report.types.ts";

/**
 * Stored-XSS regression tests for the DMARC dashboard pages (#131).
 *
 * DMARC aggregate reports arrive over the UNAUTHENTICATED inbound path and
 * their fields (`org_name`, `domain`, `source_ip`, `disposition`, auth
 * domains/results, and the raw XML) are stored verbatim. `@kitajs/html` does
 * NOT auto-escape interpolated children — escaping needs the `safe`
 * attribute. If a page omits `safe`, an attacker-supplied `<script>`/`<img
 * onerror>` executes in the admin dashboard origin.
 *
 * These tests render the pages with a payload in every attacker-controlled
 * field and assert the raw payload never appears unescaped in the output
 * (i.e. `safe` is doing its job).
 */

/** A payload whose escaped form differs unmistakably from its raw form. */
const XSS = `<img src=x onerror="alert(1)">`;
/** After HTML-escaping, `<` becomes `&lt;` — the payload can't open a tag. */
const ESCAPED_LT = "&lt;img";

function makeReport(overrides: Partial<DmarcReport> = {}): DmarcReport {
  return {
    id: "dmr_x",
    orgName: XSS,
    orgEmail: "reporter@example.com",
    reportId: "report-1",
    domain: XSS,
    dateBegin: new Date("2026-05-01T00:00:00Z"),
    dateEnd: new Date("2026-05-02T00:00:00Z"),
    policyP: XSS,
    policyPct: 100,
    rawXml: XSS,
    receivedAt: new Date("2026-05-02T06:00:00Z"),
    ...overrides,
  };
}

function makeRecord(overrides: Partial<DmarcRecord> = {}): DmarcRecord {
  return {
    id: "dmrec_x",
    reportId: "dmr_x",
    sourceIp: XSS,
    count: 5,
    disposition: XSS,
    dkimAligned: false,
    spfAligned: false,
    headerFrom: XSS,
    dkimAuthDomain: XSS,
    dkimSelector: XSS,
    dkimResult: XSS,
    spfAuthDomain: XSS,
    spfResult: XSS,
    ...overrides,
  };
}

describe("DMARC reports list — XSS (#131)", () => {
  test("escapes attacker-controlled orgName / domain / policyP / filter", () => {
    const html = DmarcReportsPage({
      reports: [makeReport()],
      total: 1,
      page: 1,
      limit: 20,
      domainFilter: undefined,
      /** Two domains so the filter chips (which render {d}) are shown. */
      domains: [XSS, "b.example.com"],
    }).toString();

    /** The unescaped payload must NOT be present as a live tag. */
    expect(html).not.toContain(XSS);
    /** ...and the escaped form must be, proving the field rendered inert. */
    expect(html).toContain(ESCAPED_LT);
  });
});

describe("DMARC report detail — XSS (#131)", () => {
  test("escapes header fields, per-record fields, and raw XML", () => {
    const html = DmarcReportDetailPage({
      report: makeReport(),
      records: [makeRecord()],
    }).toString();

    expect(html).not.toContain(XSS);
    expect(html).toContain(ESCAPED_LT);
  });

  test("escapes even when optional auth domains are absent", () => {
    const html = DmarcReportDetailPage({
      report: makeReport({ orgName: "clean", domain: "clean", policyP: "reject" }),
      records: [makeRecord({ dkimAuthDomain: null, spfAuthDomain: null })],
    }).toString();

    /** sourceIp/disposition still carry the payload — must be escaped. */
    expect(html).not.toContain(XSS);
    expect(html).toContain(ESCAPED_LT);
  });
});
