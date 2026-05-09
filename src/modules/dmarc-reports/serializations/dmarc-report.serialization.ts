import type { DmarcReport, DmarcRecord } from "../types/dmarc-report.types.ts";

/**
 * Public response shape for the list endpoint. Drops `rawXml` — list
 * responses don't need the raw XML, the detail endpoint surfaces it
 * separately when the operator wants to inspect.
 */
export interface SerializedDmarcReportSummary {
  id: string;
  orgName: string;
  orgEmail: string;
  reportId: string;
  domain: string;
  dateBegin: Date;
  dateEnd: Date;
  policyP: string;
  policyPct: number;
  receivedAt: Date;
}

export function serializeDmarcReportSummary(
  row: DmarcReport,
): SerializedDmarcReportSummary {
  return {
    id: row.id,
    orgName: row.orgName,
    orgEmail: row.orgEmail,
    reportId: row.reportId,
    domain: row.domain,
    dateBegin: row.dateBegin,
    dateEnd: row.dateEnd,
    policyP: row.policyP,
    policyPct: row.policyPct,
    receivedAt: row.receivedAt,
  };
}

/**
 * Detail response — summary plus per-record breakdown. We DO surface
 * `rawXml` here so operators investigating an alignment failure can
 * see exactly what the receiver sent.
 */
export interface SerializedDmarcReportDetail extends SerializedDmarcReportSummary {
  rawXml: string;
  records: SerializedDmarcRecord[];
  totals: {
    messages: number;
    dkimAligned: number;
    spfAligned: number;
    bothAligned: number;
  };
}

export interface SerializedDmarcRecord {
  id: string;
  sourceIp: string;
  count: number;
  disposition: string;
  dkimAligned: boolean;
  spfAligned: boolean;
  headerFrom: string;
  dkimAuthDomain: string | null;
  dkimSelector: string | null;
  dkimResult: string | null;
  spfAuthDomain: string | null;
  spfResult: string | null;
}

export function serializeDmarcReportDetail(
  row: DmarcReport,
  records: DmarcRecord[],
): SerializedDmarcReportDetail {
  /**
   * Pre-compute the totals the dashboard surfaces — alignment rates
   * are derived from the raw records but having them on the response
   * means the dashboard doesn't have to re-aggregate client-side.
   */
  const totals = records.reduce(
    (acc, r) => {
      acc.messages += r.count;
      if (r.dkimAligned) acc.dkimAligned += r.count;
      if (r.spfAligned) acc.spfAligned += r.count;
      if (r.dkimAligned && r.spfAligned) acc.bothAligned += r.count;
      return acc;
    },
    { messages: 0, dkimAligned: 0, spfAligned: 0, bothAligned: 0 },
  );

  return {
    ...serializeDmarcReportSummary(row),
    rawXml: row.rawXml,
    records: records.map((r) => ({
      id: r.id,
      sourceIp: r.sourceIp,
      count: r.count,
      disposition: r.disposition,
      dkimAligned: r.dkimAligned,
      spfAligned: r.spfAligned,
      headerFrom: r.headerFrom,
      dkimAuthDomain: r.dkimAuthDomain,
      dkimSelector: r.dkimSelector,
      dkimResult: r.dkimResult,
      spfAuthDomain: r.spfAuthDomain,
      spfResult: r.spfResult,
    })),
    totals,
  };
}
