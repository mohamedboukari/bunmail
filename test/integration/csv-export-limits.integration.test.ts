/**
 * The guards around a CSV export (#430, security review), through the
 * real `pagesPlugin` against real Postgres:
 *
 * - concurrency: at most `EXPORT_MAX_CONCURRENT` exports produce at once
 *   in a process; the next gets the 429 page with `Retry-After`, is
 *   logged and audited (`reason: "busy"`), and takes no budget; a slot is
 *   given back when an export finishes, is cancelled, fails before
 *   streaming (503) or fails while writing its first batch;
 * - `Sec-Fetch-Site`: `cross-site` and `same-site` are refused with 403
 *   before anything is counted or audited; `same-origin`, `none` and no
 *   header are let through;
 * - a Postgres `infinity` timestamp exports as an empty cell;
 * - a cell that cannot be written while the first batch is streamed
 *   fails the export cleanly: logged, audited, the stream errored.
 */
import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { DrizzleQueryError, desc, eq, sql } from "drizzle-orm";
import type { Context } from "elysia";
import { db, seed, truncateAll, emails } from "./_helpers.ts";
import { bodyText, get, parseCsv, rowObjects } from "./_csv.ts";
import { auditEvents } from "../../src/modules/audit/models/audit-event.schema.ts";
import {
  activeExportCount,
  EXPORT_BUSY_RETRY_AFTER_SEC,
  EXPORT_MAX_CONCURRENT,
  exportBudgetMap,
  resetExportSlots,
} from "../../src/pages/lib/export-limiter.ts";
import { csvExportResponse, exportLimits } from "../../src/pages/lib/csv-export.tsx";
import { logger } from "../../src/utils/logger.ts";
import type { ExportSource } from "../../src/modules/exports/types/export.types.ts";
import type { DashboardAuth } from "../../src/modules/users/types/user.types.ts";

const original = { ...exportLimits };
const ids = { admin: "", key: "" };
let token = "";

beforeEach(async () => {
  exportLimits.batchSize = original.batchSize;
  exportLimits.rowCap = original.rowCap;
  exportBudgetMap.clear();
  resetExportSlots();
  await truncateAll();
  ids.admin = (await seed.user({ email: "admin@example.com", role: "admin" })).id;
  token = (await seed.session({ userId: ids.admin })).token;
  ids.key = (await seed.apiKey({ name: "limits-key" })).id;
});

/** The `export.downloaded` events, newest first. */
function exportEvents(): Promise<Array<typeof auditEvents.$inferSelect>> {
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "export.downloaded"))
    .orderBy(desc(auditEvents.occurredAt));
}

/** The admin as the route context carries it. */
function adminAuth(): DashboardAuth {
  return {
    user: { id: ids.admin, email: "admin@example.com", role: "admin" },
    session: { id: "ses_x", assurance: "password" },
  };
}

/** Calls the export directly with a hand-made source. */
function exportWith(source: ExportSource): Promise<Response | string> {
  const set: Context["set"] = { headers: {}, status: 200 };
  return csvExportResponse({
    source,
    filters: [],
    auth: adminAuth(),
    request: new Request("http://localhost/dashboard/emails/export.csv"),
    server: null,
    set,
  });
}

/** Reads a body to its end; the error it ends with, if any. */
async function drain(response: Response): Promise<unknown> {
  try {
    await response.arrayBuffer();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

describe("CSV export concurrency (#430 review)", () => {
  test(`a request past ${EXPORT_MAX_CONCURRENT} running exports gets 429 busy, audited, no budget taken`, async () => {
    exportLimits.batchSize = 1;
    for (let i = 0; i < 3; i++) await seed.email({ apiKeyId: ids.key, subject: `m${i}` });

    /**
     * Not read: each stream holds its first batch and waits for a reader,
     * so its slot stays taken.
     */
    const held: Response[] = [];
    for (let i = 0; i < EXPORT_MAX_CONCURRENT; i++) {
      const response = await get("/dashboard/emails/export.csv", token);
      expect(response.status).toBe(200);
      held.push(response);
    }
    expect(activeExportCount()).toBe(EXPORT_MAX_CONCURRENT);
    const budgetBefore = exportBudgetMap.get(ids.admin)?.count;

    const warn = spyOn(logger, "warn");
    try {
      const busy = await get("/dashboard/users/export.csv", token);
      expect(busy.status).toBe(429);
      expect(busy.headers.get("retry-after")).toBe(String(EXPORT_BUSY_RETRY_AFTER_SEC));
      expect(await busy.text()).toContain("Too many exports");
      const line = warn.mock.calls.find(
        ([m]) => m === "CSV export refused: too many exports running",
      );
      expect(line?.[1]).toMatchObject({ userId: ids.admin, table: "users" });
    } finally {
      warn.mockRestore();
    }
    expect(exportBudgetMap.get(ids.admin)?.count).toBe(budgetBefore);
    const [refusal] = await exportEvents();
    expect(refusal?.outcome).toBe("failure");
    expect(refusal?.metadata).toEqual({
      table: "users",
      filters: [],
      rows: 0,
      truncated: false,
      reason: "busy",
    });

    /** Finishing one export frees its slot for the next. */
    const [first, second] = held;
    if (!first || !second) throw new Error("expected two held exports");
    expect(parseCsv(await bodyText(first)).rows).toHaveLength(3);
    expect(activeExportCount()).toBe(EXPORT_MAX_CONCURRENT - 1);
    const next = await get("/dashboard/users/export.csv", token);
    expect(next.status).toBe(200);
    await bodyText(next);

    /** Cancelling one frees its slot too, audited as failure. */
    await second.body?.cancel();
    expect(activeExportCount()).toBe(0);
    const [cancelled] = await exportEvents();
    expect(cancelled?.outcome).toBe("failure");
    expect(cancelled?.metadata).toMatchObject({ table: "emails" });
  });

  test("a failure before streaming (503) gives the slot back", async () => {
    const response = await exportWith({
      table: "emails",
      headers: ["id"],
      fetchBatch: () =>
        Promise.reject(new DrizzleQueryError("select", [], new Error("down"))),
    });
    expect(response).toBe("Export temporarily unavailable");
    expect(activeExportCount()).toBe(0);
    expect((await exportEvents())[0]?.outcome).toBe("failure");
  });
});

describe("CSV export Sec-Fetch-Site (#430 review)", () => {
  test.each(["cross-site", "same-site"])(
    "%s is refused with 403 before the budget or the audit log",
    async (site) => {
      const response = await get("/dashboard/users/export.csv", token, {
        "sec-fetch-site": site,
      });
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("Forbidden");
      expect(exportBudgetMap.get(ids.admin)).toBeUndefined();
      expect(activeExportCount()).toBe(0);
      expect(await exportEvents()).toHaveLength(0);
    },
  );

  test.each([["same-origin"], ["none"], [null]])("%p is let through", async (site) => {
    const headers: Record<string, string> = site ? { "sec-fetch-site": site } : {};
    const response = await get("/dashboard/users/export.csv", token, headers);
    expect(response.status).toBe(200);
    await bodyText(response);
  });
});

describe("CSV export robustness (#430 review)", () => {
  test("a Postgres infinity timestamp exports as an empty cell", async () => {
    const { id } = await seed.email({ apiKeyId: ids.key, status: "sent" });
    await db
      .update(emails)
      .set({ sentAt: sql`'infinity'::timestamp` })
      .where(eq(emails.id, id));
    const response = await get("/dashboard/emails/export.csv", token);
    expect(response.status).toBe(200);
    const [row] = rowObjects(parseCsv(await bodyText(response)));
    expect(row?.id).toBe(id);
    expect(row?.sent_at).toBe("");
  });

  test("a cell that cannot be written in the first batch fails the export: logged, audited, slot freed", async () => {
    /** A date whose text conversion throws, the shape of an unforeseen bad cell. */
    class UnwritableDate extends Date {
      override toISOString(): string {
        throw new Error("cannot write this cell");
      }
    }
    const error = spyOn(logger, "error");
    try {
      const response = await exportWith({
        table: "emails",
        headers: ["id", "created_at"],
        fetchBatch: () =>
          Promise.resolve({ rows: [["msg_1", new UnwritableDate()]], next: null }),
      });
      if (!(response instanceof Response)) throw new Error("expected a Response");
      expect(String(await drain(response))).toContain("CSV export failed");
      const line = error.mock.calls.find(([m]) => m === "CSV export failed");
      expect(line?.[1]).toMatchObject({ table: "emails", userId: ids.admin });
    } finally {
      error.mockRestore();
    }
    expect(activeExportCount()).toBe(0);
    expect((await exportEvents())[0]?.outcome).toBe("failure");
  });
});
