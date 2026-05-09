import {
  pgTable,
  varchar,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * DMARC aggregate (rua) report — one row per report received from a
 * remote receiver (Microsoft, Google, Yahoo, etc.). Reports are about
 * a domain, NOT a tenant — receivers send them to the address listed
 * in `_dmarc.<domain>` TXT's `rua=` tag, which is operator-managed.
 *
 * Per-source-IP detail lives in the sibling `dmarc_records` table.
 *
 * Detected and parsed by `dmarc-handler.service` when a matching
 * message hits the inbound SMTP path (see `smtp-receiver.service.ts`
 * branching). The original `inbound_emails` row is suppressed for
 * DMARC reports so they don't clutter the inbox view.
 */
export const dmarcReports = pgTable(
  "dmarc_reports",
  {
    /** Unique identifier, prefixed with `dmr_`. */
    id: varchar("id", { length: 36 }).primaryKey(),

    /** Reporting org's display name (e.g. "Microsoft Corporation", "google.com"). */
    orgName: varchar("org_name", { length: 255 }).notNull(),

    /**
     * Mailbox the report was sent from (e.g. `noreply-dmarc-support@google.com`).
     * Combined with `reportId` to de-dupe — receivers occasionally re-send
     * the same report.
     */
    orgEmail: varchar("org_email", { length: 255 }).notNull(),

    /** Receiver-assigned report ID from `<report_metadata><report_id>`. */
    reportId: varchar("report_id", { length: 255 }).notNull(),

    /**
     * Domain this report concerns — the `<policy_published><domain>`
     * value. Stored as plain text (not FK) so reports for unregistered
     * or typo'd domains can still be parsed and surfaced.
     */
    domain: varchar("domain", { length: 255 }).notNull(),

    /** Window the report covers, from `<report_metadata><date_range>`. */
    dateBegin: timestamp("date_begin", { withTimezone: true }).notNull(),
    dateEnd: timestamp("date_end", { withTimezone: true }).notNull(),

    /**
     * Published DMARC policy that was in effect during the window:
     * `none` | `quarantine` | `reject`. Lets the dashboard contrast
     * "what we said to do" vs "what the receiver actually did" at the
     * record level.
     */
    policyP: varchar("policy_p", { length: 20 }).notNull(),

    /** Sampling rate (`pct`) the policy applied at, 0-100. */
    policyPct: integer("policy_pct").notNull().default(100),

    /**
     * Raw decompressed XML kept for forensics. Reports are small
     * (typically < 50 KB); the cost of storing them buys ground-truth
     * for re-parsing if our parser misses a field. Operators concerned
     * about storage can drop the column without breaking other code.
     */
    rawXml: text("raw_xml").notNull(),

    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * De-dup key. If a receiver re-sends the same report (rare but
     * happens with retries), the second insert no-ops via
     * `ON CONFLICT DO NOTHING` in the handler.
     */
    uniqueIndex("dmarc_reports_org_email_report_id_unique").on(
      table.orgEmail,
      table.reportId,
    ),
    /** Dashboard "recent reports for X" hot path. */
    index("dmarc_reports_domain_date_end_idx").on(table.domain, table.dateEnd),
  ],
);
