import { describe, test, expect } from "bun:test";
import { gzipSync, zipSync, strToU8 } from "fflate";
import {
  parseAggregateReport,
  looksLikeDmarcReport,
} from "../../src/modules/dmarc-reports/services/dmarc-parser.service.ts";

/**
 * Unit tests for the DMARC aggregate report parser.
 *
 * Pure-function tests: build a fake report XML, compress with the
 * format we want to exercise (gzip / zip / raw), feed it to the
 * parser, assert on the parsed shape. No DB, no I/O.
 *
 * Coverage:
 *   - RFC 7489 happy path with multiple records
 *   - gzip-compressed (Google / Yahoo style)
 *   - zip-compressed (Microsoft style)
 *   - Single-record "scalar vs array" XML quirk (fast-xml-parser
 *     collapses single elements to scalars; we coerce both shapes)
 *   - Malformed input → null
 *   - Non-XML bytes → null
 *   - Missing required fields → null
 *   - looksLikeDmarcReport heuristic
 */

const SAMPLE_REPORT_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata>
    <org_name>Microsoft Corporation</org_name>
    <email>noreply@dmarcreport.microsoft.com</email>
    <report_id>26f8b015df374531ad45438fd367340a</report_id>
    <date_range>
      <begin>1746230400</begin>
      <end>1746316800</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>yourdns.example</domain>
    <adkim>r</adkim>
    <aspf>r</aspf>
    <p>quarantine</p>
    <sp>quarantine</sp>
    <pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>23.95.164.177</source_ip>
      <count>147</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>yourdns.example</header_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>yourdns.example</domain>
        <selector>bunmail</selector>
        <result>pass</result>
      </dkim>
      <spf>
        <domain>yourdns.example</domain>
        <result>pass</result>
      </spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>185.220.101.33</source_ip>
      <count>3</count>
      <policy_evaluated>
        <disposition>quarantine</disposition>
        <dkim>fail</dkim>
        <spf>fail</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>yourdns.example</header_from>
    </identifiers>
    <auth_results>
      <spf>
        <domain>different-domain.example</domain>
        <result>fail</result>
      </spf>
    </auth_results>
  </record>
</feedback>`;

const SINGLE_RECORD_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>1234567890</report_id>
    <date_range>
      <begin>1746230400</begin>
      <end>1746316800</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>example.com</domain>
    <p>none</p>
    <pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>1.2.3.4</source_ip>
      <count>5</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>example.com</header_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>example.com</domain>
        <selector>default</selector>
        <result>pass</result>
      </dkim>
      <spf>
        <domain>example.com</domain>
        <result>pass</result>
      </spf>
    </auth_results>
  </record>
</feedback>`;

describe("parseAggregateReport — RFC 7489 happy path", () => {
  test("parses raw XML (no compression)", () => {
    const parsed = parseAggregateReport(strToU8(SAMPLE_REPORT_XML));
    expect(parsed).not.toBeNull();
    expect(parsed!.orgName).toBe("Microsoft Corporation");
    expect(parsed!.orgEmail).toBe("noreply@dmarcreport.microsoft.com");
    expect(parsed!.reportId).toBe("26f8b015df374531ad45438fd367340a");
    expect(parsed!.domain).toBe("yourdns.example");
    expect(parsed!.policyP).toBe("quarantine");
    expect(parsed!.policyPct).toBe(100);
    expect(parsed!.records).toHaveLength(2);
  });

  test("date_range begin/end are converted from unix-seconds to JS Date", () => {
    const parsed = parseAggregateReport(strToU8(SAMPLE_REPORT_XML));
    /** 1746230400 = 2025-05-03 00:00:00 UTC. */
    expect(parsed!.dateBegin.getTime()).toBe(1746230400 * 1000);
    expect(parsed!.dateEnd.getTime()).toBe(1746316800 * 1000);
  });

  test("first record: source_ip + alignment + auth detail", () => {
    const parsed = parseAggregateReport(strToU8(SAMPLE_REPORT_XML));
    const first = parsed!.records[0]!;
    expect(first.sourceIp).toBe("23.95.164.177");
    expect(first.count).toBe(147);
    expect(first.disposition).toBe("none");
    expect(first.dkimAligned).toBe(true);
    expect(first.spfAligned).toBe(true);
    expect(first.headerFrom).toBe("yourdns.example");
    expect(first.dkimAuthDomain).toBe("yourdns.example");
    expect(first.dkimSelector).toBe("bunmail");
    expect(first.dkimResult).toBe("pass");
    expect(first.spfAuthDomain).toBe("yourdns.example");
    expect(first.spfResult).toBe("pass");
  });

  test("second record: misaligned source IP (potential spoof)", () => {
    const parsed = parseAggregateReport(strToU8(SAMPLE_REPORT_XML));
    const second = parsed!.records[1]!;
    expect(second.sourceIp).toBe("185.220.101.33");
    expect(second.disposition).toBe("quarantine");
    expect(second.dkimAligned).toBe(false);
    expect(second.spfAligned).toBe(false);
    /** No DKIM auth_results in this record — fields are null. */
    expect(second.dkimAuthDomain).toBeNull();
    expect(second.dkimSelector).toBeNull();
    /** SPF auth result is present and aimed at a DIFFERENT domain — the signal that
     *  someone else's mail is getting forwarded with our From header. */
    expect(second.spfAuthDomain).toBe("different-domain.example");
    expect(second.spfResult).toBe("fail");
  });
});

describe("parseAggregateReport — compression formats", () => {
  test("gzipped XML (Google / Yahoo style)", () => {
    const compressed = gzipSync(strToU8(SAMPLE_REPORT_XML));
    const parsed = parseAggregateReport(compressed);
    expect(parsed).not.toBeNull();
    expect(parsed!.records).toHaveLength(2);
  });

  test("zipped XML (Microsoft style)", () => {
    const xmlBytes = strToU8(SAMPLE_REPORT_XML);
    const compressed = zipSync({ "report.xml": xmlBytes });
    const parsed = parseAggregateReport(compressed);
    expect(parsed).not.toBeNull();
    expect(parsed!.records).toHaveLength(2);
  });
});

describe("parseAggregateReport — fast-xml-parser scalar/array quirk", () => {
  test("single-record report — fast-xml-parser collapses to scalar; parser coerces back", () => {
    const parsed = parseAggregateReport(strToU8(SINGLE_RECORD_XML));
    expect(parsed).not.toBeNull();
    expect(parsed!.records).toHaveLength(1);
    expect(parsed!.records[0]!.sourceIp).toBe("1.2.3.4");
  });
});

describe("parseAggregateReport — drop paths", () => {
  test("non-XML bytes return null", () => {
    expect(parseAggregateReport(strToU8("hello world"))).toBeNull();
  });

  test("invalid gzip bytes return null", () => {
    /** 1f 8b magic but garbage after — gunzip throws. */
    expect(parseAggregateReport(new Uint8Array([0x1f, 0x8b, 0x00, 0x00]))).toBeNull();
  });

  test("missing report_metadata returns null", () => {
    const broken = `<?xml version="1.0"?>
<feedback>
  <policy_published><domain>x.com</domain><p>none</p></policy_published>
</feedback>`;
    expect(parseAggregateReport(strToU8(broken))).toBeNull();
  });

  test("missing policy_published returns null", () => {
    const broken = `<?xml version="1.0"?>
<feedback>
  <report_metadata>
    <org_name>x</org_name>
    <email>x@x.com</email>
    <report_id>1</report_id>
    <date_range><begin>1</begin><end>2</end></date_range>
  </report_metadata>
</feedback>`;
    expect(parseAggregateReport(strToU8(broken))).toBeNull();
  });

  test("missing date_range timestamps returns null", () => {
    const broken = `<?xml version="1.0"?>
<feedback>
  <report_metadata>
    <org_name>x</org_name>
    <email>x@x.com</email>
    <report_id>1</report_id>
    <date_range><begin>nope</begin><end>also nope</end></date_range>
  </report_metadata>
  <policy_published><domain>x.com</domain><p>none</p></policy_published>
</feedback>`;
    expect(parseAggregateReport(strToU8(broken))).toBeNull();
  });

  test("non-feedback XML root returns null", () => {
    const wrong = `<?xml version="1.0"?><something_else><x/></something_else>`;
    expect(parseAggregateReport(strToU8(wrong))).toBeNull();
  });
});

describe("looksLikeDmarcReport heuristic", () => {
  test("matches Microsoft enterprise.protection.outlook.com sender", () => {
    const raw = `From: noreply@enterprise.protection.outlook.com\nSubject: Report Domain: yourdns.example\n\nbody`;
    expect(looksLikeDmarcReport(raw)).toBe(true);
  });

  test("matches Google noreply-dmarc-support sender", () => {
    const raw = `From: noreply-dmarc-support@google.com\nSubject: Report-id 1234\n\nbody`;
    expect(looksLikeDmarcReport(raw)).toBe(true);
  });

  test("matches Yahoo dmarcreport sender", () => {
    const raw = `From: dmarcreport@yahoo.com\nSubject: Daily report\n\nbody`;
    expect(looksLikeDmarcReport(raw)).toBe(true);
  });

  test("matches subject mentioning 'Report Domain'", () => {
    const raw = `From: someone@example.com\nSubject: Report Domain: yourdns.example Submitter: x.com Report-ID: abc\n\nbody`;
    expect(looksLikeDmarcReport(raw)).toBe(true);
  });

  test("matches subject mentioning DMARC", () => {
    const raw = `From: x@y.z\nSubject: dmarc daily aggregate\n\nbody`;
    expect(looksLikeDmarcReport(raw)).toBe(true);
  });

  test("rejects regular customer mail", () => {
    const raw = `From: alice@gmail.com\nSubject: Question about the API\n\ncontent`;
    expect(looksLikeDmarcReport(raw)).toBe(false);
  });

  test("doesn't classify based on zip attachment alone", () => {
    const raw = `From: alice@example.com\nSubject: Photos from yesterday\nContent-Type: application/zip\n\n...`;
    expect(looksLikeDmarcReport(raw)).toBe(false);
  });

  test("DOES classify zip attachment + DMARC body mention as a report", () => {
    const raw = `From: dmarc@somewhere.example\nSubject: Aggregate report\nContent-Type: application/zip\n\nDMARC aggregate report attached.`;
    expect(looksLikeDmarcReport(raw)).toBe(true);
  });
});
