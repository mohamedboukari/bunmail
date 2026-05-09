/**
 * Detects, parses, and persists incoming DMARC aggregate (rua) reports.
 *
 * Wired into `smtp-receiver.service.ts`'s `onData` after the bounce
 * branch and before the generic `inbound_emails` insert. When a
 * message is recognised and parsed successfully, the handler stores
 * the `dmarc_reports` row + per-source-IP `dmarc_records` rows AND
 * tells the receiver to suppress the normal inbound insert (DMARC
 * reports would otherwise pile up in the inbox view).
 *
 * Same orchestration-with-injected-deps pattern as `bounce-handler`
 * from #24 — the core decision logic is unit-testable; the public
 * wrapper supplies real DB callbacks.
 */

import { sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { dmarcReports } from "../models/dmarc-report.schema.ts";
import { dmarcRecords } from "../models/dmarc-record.schema.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { parseAggregateReport, looksLikeDmarcReport } from "./dmarc-parser.service.ts";
import type { ParsedDmarcReport } from "../types/dmarc-report.types.ts";

/**
 * Subset of mailparser's `Attachment` shape that we actually use. Keeps
 * tests free of mailparser as a dev dependency.
 */
export interface DmarcAttachment {
  filename?: string;
  contentType?: string;
  content: Uint8Array;
}

export interface DmarcHandlerDeps {
  /**
   * Persist the report + records atomically. The implementation should
   * use `ON CONFLICT (org_email, report_id) DO NOTHING` on the report
   * row so duplicate deliveries don't error.
   *
   * Returns whether a NEW row was inserted (true) or the conflict
   * caused a no-op (false). The handler logs differently in each case.
   */
  persistReport: (
    parsed: ParsedDmarcReport,
  ) => Promise<{ inserted: boolean; reportId: string }>;
}

export interface HandleDmarcResult {
  /** "stored" — fresh report inserted; "duplicate" — already had it; "skipped" — not a report. */
  outcome: "stored" | "duplicate" | "skipped";
  reportId?: string;
  recordCount?: number;
}

/**
 * Examines a parsed inbound message + its raw bytes, finds a DMARC
 * report attachment (or inline body), parses it, and persists.
 *
 * @returns The outcome plus identifiers when stored.
 */
export async function handleInboundDmarcReport(
  rawMessage: string,
  attachments: DmarcAttachment[],
  textBody: string | null,
  deps: DmarcHandlerDeps,
): Promise<HandleDmarcResult> {
  /**
   * Cheap pre-filter: sender / subject / content-type heuristics. If
   * none match, this almost certainly isn't a DMARC report — skip the
   * decompression cost.
   */
  if (!looksLikeDmarcReport(rawMessage)) {
    return { outcome: "skipped" };
  }

  /**
   * Try every attachment in turn — the report is usually the first one
   * but receivers occasionally include a human-readable HTML preamble
   * as a separate attachment that we'd skip on parse failure.
   */
  let parsed: ParsedDmarcReport | null = null;
  for (const att of attachments) {
    parsed = parseAggregateReport(att.content);
    if (parsed) break;
  }

  /**
   * Some senders inline the XML directly (uncompressed) in the message
   * body instead of attaching it. Last-resort: try the text body bytes.
   */
  if (!parsed && textBody) {
    parsed = parseAggregateReport(new TextEncoder().encode(textBody));
  }

  if (!parsed) {
    logger.warn(
      "DMARC: detected report-shaped message but couldn't parse any attachment",
      {
        attachmentCount: attachments.length,
      },
    );
    return { outcome: "skipped" };
  }

  const result = await deps.persistReport(parsed);

  if (result.inserted) {
    logger.info("DMARC report stored", {
      reportId: result.reportId,
      orgName: parsed.orgName,
      domain: parsed.domain,
      records: parsed.records.length,
      dateBegin: parsed.dateBegin.toISOString(),
      dateEnd: parsed.dateEnd.toISOString(),
    });
    return {
      outcome: "stored",
      reportId: result.reportId,
      recordCount: parsed.records.length,
    };
  }

  logger.debug("DMARC report deduplicated — already stored", {
    orgEmail: parsed.orgEmail,
    reportId: parsed.reportId,
  });
  return { outcome: "duplicate", reportId: result.reportId };
}

/**
 * Real-DB implementation of `persistReport`. Uses a transaction so the
 * report row + its records insert atomically — partial state would
 * produce orphan reports in the dashboard.
 */
async function persistReportToDb(
  parsed: ParsedDmarcReport,
): Promise<{ inserted: boolean; reportId: string }> {
  const reportId = generateId("dmr");
  let actuallyInserted = false;
  let finalReportId = reportId;

  await db.transaction(async (tx) => {
    /**
     * The unique index `(org_email, report_id)` is the de-dup key.
     * `ON CONFLICT DO NOTHING` returns no rows when the conflict fires;
     * we detect that and short-circuit the records insert.
     */
    const inserted = await tx
      .insert(dmarcReports)
      .values({
        id: reportId,
        orgName: parsed.orgName,
        orgEmail: parsed.orgEmail,
        reportId: parsed.reportId,
        domain: parsed.domain,
        dateBegin: parsed.dateBegin,
        dateEnd: parsed.dateEnd,
        policyP: parsed.policyP,
        policyPct: parsed.policyPct,
        rawXml: parsed.rawXml,
      })
      .onConflictDoNothing({
        target: [dmarcReports.orgEmail, dmarcReports.reportId],
      })
      .returning({ id: dmarcReports.id });

    if (inserted.length === 0) {
      /**
       * Conflict — an existing row has the same (org_email, report_id).
       * Look it up so the caller can return its id (useful for logging
       * and for the smoke-test path that re-sends the same report).
       */
      const [existing] = await tx
        .select({ id: dmarcReports.id })
        .from(dmarcReports)
        .where(
          sql`${dmarcReports.orgEmail} = ${parsed.orgEmail} AND ${dmarcReports.reportId} = ${parsed.reportId}`,
        )
        .limit(1);
      finalReportId = existing?.id ?? reportId;
      return;
    }

    actuallyInserted = true;

    /** Fan-in records. Empty reports (no <record> blocks) are valid;
     *  insert nothing in that case. */
    if (parsed.records.length > 0) {
      await tx.insert(dmarcRecords).values(
        parsed.records.map((r) => ({
          id: generateId("dmrec"),
          reportId,
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
      );
    }
  });

  return { inserted: actuallyInserted, reportId: finalReportId };
}

/**
 * Public wrapper. The smtp-receiver calls this with mailparser's
 * `ParsedMail.attachments` + the raw message string + the text body.
 */
export async function persistDmarcReportFromInbound(
  rawMessage: string,
  attachments: DmarcAttachment[],
  textBody: string | null,
): Promise<HandleDmarcResult> {
  return handleInboundDmarcReport(rawMessage, attachments, textBody, {
    persistReport: persistReportToDb,
  });
}
