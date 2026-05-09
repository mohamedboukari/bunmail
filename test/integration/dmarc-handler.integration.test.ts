/**
 * Integration tests for the DMARC report handler against real Postgres.
 *
 * Catches the parts the parser unit tests can't:
 *   - `ON CONFLICT DO NOTHING` dedup on (org_email, report_id)
 *   - `ON DELETE CASCADE` from dmarc_reports → dmarc_records
 *   - Transactional atomicity (report + records insert as one unit)
 *   - The reads-side `listDmarcReports` + `getDmarcReportById` plumbing
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { strToU8 } from "fflate";
import { persistDmarcReportFromInbound } from "../../src/modules/dmarc-reports/services/dmarc-handler.service.ts";
import {
  listDmarcReports,
  getDmarcReportById,
} from "../../src/modules/dmarc-reports/services/dmarc-reports.service.ts";
import { dmarcReports } from "../../src/modules/dmarc-reports/models/dmarc-report.schema.ts";
import { dmarcRecords } from "../../src/modules/dmarc-reports/models/dmarc-record.schema.ts";
import { truncateAll, db } from "./_helpers.ts";

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata>
    <org_name>Microsoft Corporation</org_name>
    <email>noreply@dmarcreport.microsoft.com</email>
    <report_id>integration-test-1</report_id>
    <date_range>
      <begin>1746230400</begin>
      <end>1746316800</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>bunmail.xyz</domain>
    <p>quarantine</p>
    <pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>23.95.164.177</source_ip>
      <count>10</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>bunmail.xyz</header_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>bunmail.xyz</domain>
        <selector>bunmail</selector>
        <result>pass</result>
      </dkim>
      <spf>
        <domain>bunmail.xyz</domain>
        <result>pass</result>
      </spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>1.2.3.4</source_ip>
      <count>2</count>
      <policy_evaluated>
        <disposition>quarantine</disposition>
        <dkim>fail</dkim>
        <spf>fail</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>bunmail.xyz</header_from>
    </identifiers>
    <auth_results>
      <spf>
        <domain>spoof.example</domain>
        <result>fail</result>
      </spf>
    </auth_results>
  </record>
</feedback>`;

const RAW_REPORT_MAIL =
  "From: noreply@enterprise.protection.outlook.com\n" +
  "Subject: Report Domain: bunmail.xyz Submitter: x Report-ID: integration-test-1\n" +
  "\n" +
  "DMARC aggregate report attached.";

beforeEach(async () => {
  await truncateAll();
  /** dmarc_reports / dmarc_records aren't in `truncateAll` — wipe them
   *  here so each test starts clean. */
  await db.delete(dmarcRecords);
  await db.delete(dmarcReports);
});

describe("persistDmarcReportFromInbound — happy path", () => {
  test("stores the report + all records in one transaction", async () => {
    const result = await persistDmarcReportFromInbound(
      RAW_REPORT_MAIL,
      [
        {
          filename: "report.xml",
          contentType: "application/xml",
          content: strToU8(SAMPLE_XML),
        },
      ],
      null,
    );

    expect(result.outcome).toBe("stored");
    expect(result.recordCount).toBe(2);
    expect(result.reportId).toMatch(/^dmr_/);

    /** Verify the report row. */
    const reports = await db.select().from(dmarcReports);
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report.orgName).toBe("Microsoft Corporation");
    expect(report.domain).toBe("bunmail.xyz");
    expect(report.policyP).toBe("quarantine");
    expect(report.rawXml).toContain("<feedback>");

    /** Verify both records were inserted with the right shape. */
    const records = await db
      .select()
      .from(dmarcRecords)
      .where(eq(dmarcRecords.reportId, result.reportId!));
    expect(records).toHaveLength(2);
    const aligned = records.find((r) => r.sourceIp === "23.95.164.177");
    const misaligned = records.find((r) => r.sourceIp === "1.2.3.4");
    expect(aligned?.dkimAligned).toBe(true);
    expect(aligned?.spfAligned).toBe(true);
    expect(misaligned?.dkimAligned).toBe(false);
    expect(misaligned?.disposition).toBe("quarantine");
    expect(misaligned?.spfAuthDomain).toBe("spoof.example");
  });
});

describe("persistDmarcReportFromInbound — dedup + skip", () => {
  test("re-receiving the same report (same org_email + report_id) returns 'duplicate'", async () => {
    const first = await persistDmarcReportFromInbound(
      RAW_REPORT_MAIL,
      [{ filename: "report.xml", content: strToU8(SAMPLE_XML) }],
      null,
    );
    expect(first.outcome).toBe("stored");

    const second = await persistDmarcReportFromInbound(
      RAW_REPORT_MAIL,
      [{ filename: "report.xml", content: strToU8(SAMPLE_XML) }],
      null,
    );
    expect(second.outcome).toBe("duplicate");
    /** Same report id surfaced — caller can log "we already have this". */
    expect(second.reportId).toBe(first.reportId);

    /** Records weren't double-inserted. */
    const allRecords = await db.select().from(dmarcRecords);
    expect(allRecords).toHaveLength(2);
  });

  test("returns 'skipped' when the message doesn't look like a DMARC report", async () => {
    const result = await persistDmarcReportFromInbound(
      "From: alice@gmail.com\nSubject: question\n\ncontent",
      [],
      "regular customer mail",
    );
    expect(result.outcome).toBe("skipped");

    const reports = await db.select().from(dmarcReports);
    expect(reports).toHaveLength(0);
  });

  test("returns 'skipped' when the message looks DMARC-shaped but no attachment parses", async () => {
    const result = await persistDmarcReportFromInbound(
      RAW_REPORT_MAIL,
      [{ filename: "garbage.bin", content: new Uint8Array([0xff, 0xff, 0xff, 0xff]) }],
      null,
    );
    expect(result.outcome).toBe("skipped");
  });
});

describe("ON DELETE CASCADE on dmarc_reports → dmarc_records", () => {
  test("deleting a report wipes its records", async () => {
    const result = await persistDmarcReportFromInbound(
      RAW_REPORT_MAIL,
      [{ filename: "report.xml", content: strToU8(SAMPLE_XML) }],
      null,
    );
    expect(result.outcome).toBe("stored");

    /** Sanity: 2 records are present. */
    const before = await db.select().from(dmarcRecords);
    expect(before).toHaveLength(2);

    /** Delete the parent report. */
    await db.delete(dmarcReports).where(eq(dmarcReports.id, result.reportId!));

    /** CASCADE — records are gone too. */
    const after = await db.select().from(dmarcRecords);
    expect(after).toHaveLength(0);
  });
});

describe("listDmarcReports + getDmarcReportById", () => {
  test("listDmarcReports paginates and filters by domain", async () => {
    /** Seed a few reports for two domains. */
    for (let i = 0; i < 3; i++) {
      const xml = SAMPLE_XML.replace("integration-test-1", `bm-${i}`).replace(
        "bunmail.xyz",
        "bunmail.xyz",
      );
      await persistDmarcReportFromInbound(
        RAW_REPORT_MAIL.replace("integration-test-1", `bm-${i}`),
        [{ filename: "r.xml", content: strToU8(xml) }],
        null,
      );
    }
    for (let i = 0; i < 2; i++) {
      const xml = SAMPLE_XML.replace("integration-test-1", `oth-${i}`).replace(
        /bunmail\.xyz/g,
        "other.com",
      );
      await persistDmarcReportFromInbound(
        RAW_REPORT_MAIL.replace("integration-test-1", `oth-${i}`).replace(
          "bunmail.xyz",
          "other.com",
        ),
        [{ filename: "r.xml", content: strToU8(xml) }],
        null,
      );
    }

    const all = await listDmarcReports({ page: 1, limit: 20 });
    expect(all.total).toBe(5);

    const filtered = await listDmarcReports({
      page: 1,
      limit: 20,
      domain: "bunmail.xyz",
    });
    expect(filtered.total).toBe(3);
    expect(filtered.data.every((r) => r.domain === "bunmail.xyz")).toBe(true);
  });

  test("getDmarcReportById returns the report with its records", async () => {
    const stored = await persistDmarcReportFromInbound(
      RAW_REPORT_MAIL,
      [{ filename: "r.xml", content: strToU8(SAMPLE_XML) }],
      null,
    );

    const result = await getDmarcReportById(stored.reportId!);
    expect(result).toBeDefined();
    expect(result!.report.id).toBe(stored.reportId!);
    expect(result!.records).toHaveLength(2);
  });

  test("getDmarcReportById returns undefined for unknown id", async () => {
    expect(await getDmarcReportById("dmr_does_not_exist")).toBeUndefined();
  });
});
