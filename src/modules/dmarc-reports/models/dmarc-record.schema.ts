import { pgTable, varchar, integer, boolean, index } from "drizzle-orm/pg-core";
import { dmarcReports } from "./dmarc-report.schema.ts";

/**
 * Per-source-IP detail rows from a DMARC aggregate report. One row per
 * `<record>` element in the XML — typically one per source IP that
 * sent mail claiming to be from the report's domain during the window.
 *
 * The dashboard's primary view summarises these by `(disposition,
 * dkim_aligned, spf_aligned)` to surface alignment-rate stats. The
 * `source_ip` index serves the "where is X.X.X.X showing up across all
 * my reports?" lookup — which is how operators investigate spoofing
 * attempts after seeing a misaligned record.
 */
export const dmarcRecords = pgTable(
  "dmarc_records",
  {
    /** Unique identifier, prefixed with `dmrec_`. */
    id: varchar("id", { length: 36 }).primaryKey(),

    /**
     * The report this record came from. `ON DELETE CASCADE` so deleting
     * a report row purges its detail rows automatically — there's no
     * scenario where we want detail without the parent.
     */
    reportId: varchar("report_id", { length: 36 })
      .notNull()
      .references(() => dmarcReports.id, { onDelete: "cascade" }),

    /** IPv4 or IPv6 — `varchar(45)` covers `2001:0db8:...` worst case. */
    sourceIp: varchar("source_ip", { length: 45 }).notNull(),

    /** Number of messages this IP sent during the window. */
    count: integer("count").notNull(),

    /**
     * What the receiver actually did with the messages:
     * `none` (delivered), `quarantine` (spam folder), `reject` (bounced).
     */
    disposition: varchar("disposition", { length: 20 }).notNull(),

    /** Whether DMARC's DKIM-alignment check passed for these messages. */
    dkimAligned: boolean("dkim_aligned").notNull(),

    /** Whether DMARC's SPF-alignment check passed for these messages. */
    spfAligned: boolean("spf_aligned").notNull(),

    /** The `From:` header domain on the messages — should match the report's `domain`. */
    headerFrom: varchar("header_from", { length: 255 }).notNull(),

    /**
     * Auth result detail — what the underlying SPF / DKIM checks
     * returned, regardless of whether DMARC alignment also passed.
     * Useful for debugging "DKIM passed but DMARC didn't align" cases
     * where the signing domain doesn't match `header.from`.
     */
    dkimAuthDomain: varchar("dkim_auth_domain", { length: 255 }),
    dkimSelector: varchar("dkim_selector", { length: 255 }),
    dkimResult: varchar("dkim_result", { length: 20 }),
    spfAuthDomain: varchar("spf_auth_domain", { length: 255 }),
    spfResult: varchar("spf_result", { length: 20 }),
  },
  (table) => [
    index("dmarc_records_report_id_idx").on(table.reportId),
    /** "Where is this IP showing up across reports?" — operators investigating
     *  a misaligned source IP (likely spoof / unauthorised third-party). */
    index("dmarc_records_source_ip_idx").on(table.sourceIp),
  ],
);
