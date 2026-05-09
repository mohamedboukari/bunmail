/**
 * Read-side queries for the DMARC reports module. Insertion happens via
 * `dmarc-handler.service` from the inbound SMTP path; this file is
 * exclusively the surface the dashboard + REST API consume.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { dmarcReports } from "../models/dmarc-report.schema.ts";
import { dmarcRecords } from "../models/dmarc-record.schema.ts";
import type { DmarcReport, DmarcRecord } from "../types/dmarc-report.types.ts";

export async function listDmarcReports(filters: {
  page: number;
  limit: number;
  domain?: string;
}): Promise<{ data: DmarcReport[]; total: number }> {
  const offset = (filters.page - 1) * filters.limit;
  const where = filters.domain ? eq(dmarcReports.domain, filters.domain) : undefined;
  const condition = where ? and(where) : undefined;

  const [data, totalRows] = await Promise.all([
    db
      .select()
      .from(dmarcReports)
      .where(condition)
      .orderBy(desc(dmarcReports.dateEnd))
      .limit(filters.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(dmarcReports)
      .where(condition),
  ]);

  return { data, total: totalRows[0]?.count ?? 0 };
}

/**
 * Distinct list of domains that have at least one stored report —
 * drives the dashboard's filter dropdown.
 */
export async function listReportDomains(): Promise<string[]> {
  const rows = await db
    .select({ domain: dmarcReports.domain })
    .from(dmarcReports)
    .groupBy(dmarcReports.domain)
    .orderBy(dmarcReports.domain);
  return rows.map((r) => r.domain);
}

export async function getDmarcReportById(
  id: string,
): Promise<{ report: DmarcReport; records: DmarcRecord[] } | undefined> {
  const [report] = await db
    .select()
    .from(dmarcReports)
    .where(eq(dmarcReports.id, id))
    .limit(1);
  if (!report) return undefined;

  const records = await db
    .select()
    .from(dmarcRecords)
    .where(eq(dmarcRecords.reportId, id))
    .orderBy(desc(dmarcRecords.count));

  return { report, records };
}
