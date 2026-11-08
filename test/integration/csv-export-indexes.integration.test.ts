/**
 * The keyset indexes of the CSV exports (migration 0044, #430 review):
 * each export's batch query, built the way the export builds it
 * (`keysetPage` after a cursor, the page's filter, `ORDER BY ts DESC, id
 * DESC LIMIT n`), is served by its `(ts, id)` index in index order, with
 * no Sort node. Sequential and bitmap scans and sorts are discouraged
 * inside the transaction so a tiny test table cannot make the planner
 * prefer them; a Sort node then only appears when no index can give the
 * query's order. What is checked is that the index matches the query's
 * filter and order, which is what keeps a deep batch cheap on a large
 * table.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { and, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db, seed, truncateAll, emails, suppressions } from "./_helpers.ts";
import { emailTombstones } from "../../src/modules/emails/models/email-tombstone.schema.ts";
import { dmarcReports } from "../../src/modules/dmarc-reports/models/dmarc-report.schema.ts";
import { keysetPage } from "../../src/modules/exports/services/keyset.ts";

beforeAll(async () => {
  await truncateAll();
  const key = await seed.apiKey();
  await seed.email({ apiKeyId: key.id });
});

/** The plan of the export's batch query over the table of `ts`, after a cursor. */
async function planOf(
  ts: PgColumn,
  id: PgColumn,
  filter: SQL | undefined,
): Promise<string> {
  const page = keysetPage(
    { at: ts, id, direction: "desc" },
    { at: "2026-11-01 10:00:00.123456", id: "x_cursor" },
    500,
  );
  const query = db
    .select({ id, cursorAt: page.cursorAt })
    .from(ts.table)
    .where(and(filter, page.after))
    .orderBy(...page.orderBy)
    .limit(page.limit);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
    await tx.execute(sql`SET LOCAL enable_sort = off`);
    const rows: unknown = await tx.execute(sql`EXPLAIN ${query}`);
    if (!Array.isArray(rows)) throw new Error("unexpected EXPLAIN result");
    return rows
      .map((row: unknown) =>
        typeof row === "object" && row !== null ? String(Object.values(row)[0]) : "",
      )
      .join("\n");
  });
}

describe("CSV export keyset indexes (#430 review)", () => {
  const cases: Array<[string, PgColumn, PgColumn, SQL | undefined, string]> = [
    [
      "emails",
      emails.createdAt,
      emails.id,
      isNull(emails.deletedAt),
      "idx_emails_live_created_id",
    ],
    [
      "emails trash",
      emails.deletedAt,
      emails.id,
      isNotNull(emails.deletedAt),
      "idx_emails_trash_deleted_id",
    ],
    [
      "suppressions",
      suppressions.createdAt,
      suppressions.id,
      undefined,
      "suppressions_created_id_idx",
    ],
    [
      "tombstones",
      emailTombstones.purgedAt,
      emailTombstones.id,
      undefined,
      "idx_email_tombstones_purged_id",
    ],
    [
      "DMARC reports",
      dmarcReports.dateEnd,
      dmarcReports.id,
      undefined,
      "dmarc_reports_date_end_id_idx",
    ],
  ];

  for (const [name, ts, id, filter, index] of cases) {
    test(`${name}: served by ${index}, no sort`, async () => {
      const plan = await planOf(ts, id, filter);
      expect(plan).toContain(index);
      expect(plan).not.toMatch(/\bSort\b/);
    });
  }
});
