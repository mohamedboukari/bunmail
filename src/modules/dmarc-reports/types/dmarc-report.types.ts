import type { InferSelectModel } from "drizzle-orm";
import type { dmarcReports } from "../models/dmarc-report.schema.ts";
import type { dmarcRecords } from "../models/dmarc-record.schema.ts";

export type DmarcReport = InferSelectModel<typeof dmarcReports>;
export type DmarcRecord = InferSelectModel<typeof dmarcRecords>;

/**
 * Output of `parseAggregateReport`. The handler maps these straight to
 * `dmarcReports` + `dmarcRecords` rows. `records` is the per-source-IP
 * detail. `rawXml` is preserved so the caller can store it for forensics.
 */
export interface ParsedDmarcReport {
  orgName: string;
  orgEmail: string;
  reportId: string;
  domain: string;
  dateBegin: Date;
  dateEnd: Date;
  policyP: string;
  policyPct: number;
  rawXml: string;
  records: ParsedDmarcRecord[];
}

export interface ParsedDmarcRecord {
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
