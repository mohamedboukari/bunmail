/**
 * How a CSV export (#430) is served, through the real `pagesPlugin`
 * against real Postgres:
 *
 * - headers: `text/csv; charset=utf-8`, an attachment named
 *   `bunmail-<table>-<UTC date>.csv`, `Cache-Control: no-store`; the body
 *   starts with the UTF-8 BOM;
 * - streaming: more rows than one batch come out exactly once, in order,
 *   one chunk per batch, including rows whose timestamps differ only in
 *   microseconds (the keyset cursor keeps Postgres precision);
 * - the row cap: past it the file ends with the truncation row; exactly
 *   at it, no such row;
 * - every export recorded as `export.downloaded` (actor, table, filter
 *   names, rows, truncated), a failure mid-stream recorded as `failure`
 *   and logged without the driver's message;
 * - the per-user budget: the 11th export in the window gets a 429 page
 *   with `Retry-After`, logged at `warn`, another user is unaffected;
 * - access: members get 403 and see no Export link, admins see it with
 *   the page's filters; without a session, the login page.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { DrizzleQueryError, desc, eq, sql } from "drizzle-orm";
import { db, seed, truncateAll, emails } from "./_helpers.ts";
import { bodyText, get, parseCsv } from "./_csv.ts";
import { auditEvents } from "../../src/modules/audit/models/audit-event.schema.ts";
import {
  exportBudgetMap,
  EXPORT_MAX_PER_WINDOW,
  resetExportSlots,
} from "../../src/pages/lib/export-limiter.ts";
import {
  csvExportResponse,
  exportLimits,
  truncationNote,
} from "../../src/pages/lib/csv-export.tsx";
import { logger } from "../../src/utils/logger.ts";
import type { ExportSource } from "../../src/modules/exports/types/export.types.ts";
import type { Context } from "elysia";

const original = { ...exportLimits };
const ids = { admin: "", member: "", owner: "", key: "" };
const tokens = { admin: "", member: "", owner: "" };

beforeEach(async () => {
  exportBudgetMap.clear();
  resetExportSlots();
  await truncateAll();
  for (const role of ["admin", "member", "owner"] as const) {
    ids[role] = (await seed.user({ email: `${role}@example.com`, role })).id;
    tokens[role] = (await seed.session({ userId: ids[role] })).token;
  }
  ids.key = (await seed.apiKey({ name: "stream-key" })).id;
});

afterEach(() => {
  exportLimits.batchSize = original.batchSize;
  exportLimits.rowCap = original.rowCap;
});

/** Seeds `count` emails whose `created_at` are one minute apart, newest = index 0. */
async function seedEmails(count: number): Promise<string[]> {
  const created: string[] = [];
  for (let i = 0; i < count; i++) {
    const { id } = await seed.email({ apiKeyId: ids.key, subject: `mail ${i}` });
    await db
      .update(emails)
      .set({ createdAt: sql`now() - make_interval(mins => ${i})` })
      .where(eq(emails.id, id));
    created.push(id);
  }
  return created;
}

/** The newest `export.downloaded` event. */
async function lastExportEvent(): Promise<typeof auditEvents.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "export.downloaded"))
    .orderBy(desc(auditEvents.occurredAt))
    .limit(1);
  return row;
}

/** Reads a streamed body chunk by chunk. */
async function readChunks(response: Response): Promise<string[]> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no body");
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(decoder.decode(value));
  }
}

describe("CSV export response (#430)", () => {
  test("headers, BOM, attachment name with the UTC date", async () => {
    await seedEmails(1);
    const response = await get("/dashboard/emails/export.csv", tokens.admin);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const today = new Date().toISOString().slice(0, 10);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="bunmail-emails-${today}.csv"`,
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });

  test("more rows than one batch: every row once, newest first, one chunk per batch", async () => {
    exportLimits.batchSize = 2;
    const created = await seedEmails(7);
    const response = await get("/dashboard/emails/export.csv", tokens.admin);
    const chunks = await readChunks(response);
    /** BOM + header, then four batches (2 + 2 + 2 + 1). */
    expect(chunks.length).toBe(5);
    const csv = parseCsv(chunks.join(""));
    expect(csv.rows.map((r) => r[0])).toEqual(created);
  });

  test("rows in the same millisecond, microseconds apart, are neither skipped nor repeated", async () => {
    exportLimits.batchSize = 1;
    const created = await seedEmails(5);
    const micros = ["123999", "123700", "123456", "123456", "123001"];
    for (const [index, id] of created.entries()) {
      await db
        .update(emails)
        .set({
          createdAt: sql`${`2026-11-01 10:00:00.${micros[index] ?? "0"}`}::timestamp`,
        })
        .where(eq(emails.id, id));
    }
    const csv = parseCsv(
      await bodyText(await get("/dashboard/emails/export.csv", tokens.admin)),
    );
    const exported = csv.rows.map((r) => r[0] ?? "");
    expect(exported.toSorted((x, y) => x.localeCompare(y))).toEqual(
      created.toSorted((x, y) => x.localeCompare(y)),
    );
    expect(new Set(exported).size).toBe(created.length);
  });

  test("past the row cap: the cap's rows, then the truncation row; audited as truncated", async () => {
    exportLimits.batchSize = 2;
    exportLimits.rowCap = 5;
    const created = await seedEmails(8);
    const csv = parseCsv(
      await bodyText(await get("/dashboard/emails/export.csv", tokens.admin)),
    );
    expect(csv.rows).toHaveLength(6);
    expect(csv.rows.slice(0, 5).map((r) => r[0])).toEqual(created.slice(0, 5));
    const note = csv.rows[5] ?? [];
    expect(note[0]).toBe(truncationNote(5));
    expect(note).toHaveLength(csv.header.length);
    expect(note.slice(1).every((cell) => cell === "")).toBe(true);
    const event = await lastExportEvent();
    expect(event?.metadata).toEqual({
      table: "emails",
      filters: [],
      rows: 5,
      truncated: true,
    });
  });

  test("exactly at the row cap: no truncation row", async () => {
    exportLimits.batchSize = 2;
    exportLimits.rowCap = 4;
    await seedEmails(4);
    const csv = parseCsv(
      await bodyText(await get("/dashboard/emails/export.csv", tokens.admin)),
    );
    expect(csv.rows).toHaveLength(4);
    expect((await lastExportEvent())?.metadata).toMatchObject({
      rows: 4,
      truncated: false,
    });
  });

  test("audit: actor, table, filter names (never values), rows; one info line", async () => {
    await seedEmails(2);
    const info = spyOn(logger, "info");
    try {
      const response = await get(
        `/dashboard/emails/export.csv?status=queued&apiKeyId=${ids.key}`,
        tokens.admin,
      );
      await bodyText(response);
      const line = info.mock.calls.find(([message]) => message === "CSV export finished");
      expect(line?.[1]).toMatchObject({ userId: ids.admin, table: "emails", rows: 2 });
      expect(typeof line?.[1]?.["durationMs"]).toBe("number");
    } finally {
      info.mockRestore();
    }
    const event = await lastExportEvent();
    expect(event).toMatchObject({
      actorType: "user",
      actorId: ids.admin,
      actorLabel: "admin@example.com",
      outcome: "success",
    });
    expect(event?.metadata).toEqual({
      table: "emails",
      filters: ["status", "apiKeyId"],
      rows: 2,
      truncated: false,
    });
    expect(JSON.stringify(event)).not.toContain(ids.key);
  });

  test("a database failure mid-stream: the stream errors, audited as failure, logged without the driver message", async () => {
    let calls = 0;
    const source: ExportSource = {
      table: "emails",
      headers: ["id"],
      fetchBatch: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            rows: [["msg_1"]],
            next: { at: "2026-01-01", id: "msg_1" },
          });
        }
        return Promise.reject(
          new DrizzleQueryError("select ...", ["secret@example.com"], new Error("boom")),
        );
      },
    };
    const set: Context["set"] = { headers: {}, status: 200 };
    const error = spyOn(logger, "error");
    try {
      const response = await csvExportResponse({
        source,
        filters: [],
        auth: {
          user: { id: ids.admin, email: "admin@example.com", role: "admin" },
          session: { id: "ses_x", assurance: "password" },
        },
        request: new Request("http://localhost/dashboard/emails/export.csv"),
        server: null,
        set,
      });
      if (!(response instanceof Response)) throw new Error("expected a Response");
      let streamError: unknown;
      try {
        await readChunks(response);
      } catch (caught: unknown) {
        streamError = caught;
      }
      expect(String(streamError)).toContain("CSV export failed");
      const line = error.mock.calls.find(([message]) => message === "CSV export failed");
      expect(line?.[1]).toMatchObject({ table: "emails", rows: 1 });
      expect(JSON.stringify(line?.[1])).not.toContain("secret@example.com");
    } finally {
      error.mockRestore();
    }
    const event = await lastExportEvent();
    expect(event?.outcome).toBe("failure");
    expect(event?.metadata).toMatchObject({ rows: 1, truncated: false });
  });
});

describe("CSV export budget (#430)", () => {
  test(`the export after ${EXPORT_MAX_PER_WINDOW} in the window is refused with 429; another user is not`, async () => {
    const warn = spyOn(logger, "warn");
    try {
      for (let i = 0; i < EXPORT_MAX_PER_WINDOW; i++) {
        const ok = await get("/dashboard/domains/export.csv", tokens.admin);
        expect(ok.status).toBe(200);
        await bodyText(ok);
      }
      const refused = await get("/dashboard/users/export.csv", tokens.admin);
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await refused.text()).toContain("Too many exports");
      const line = warn.mock.calls.find(
        ([m]) => m === "CSV export refused: rate limited",
      );
      expect(line?.[1]).toMatchObject({ userId: ids.admin, table: "users" });
    } finally {
      warn.mockRestore();
    }
    const owner = await get("/dashboard/users/export.csv", tokens.owner);
    expect(owner.status).toBe(200);
    await bodyText(owner);
    const recorded = await db
      .select({ outcome: auditEvents.outcome, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(eq(auditEvents.action, "export.downloaded"));
    /** Every success, plus the refusal itself (#430 review: refused attempts are audited). */
    expect(recorded.filter((r) => r.outcome === "success")).toHaveLength(
      EXPORT_MAX_PER_WINDOW + 1,
    );
    const refused = recorded.filter((r) => r.outcome === "failure");
    expect(refused.map((r) => r.metadata)).toEqual([
      { table: "users", filters: [], rows: 0, truncated: false, reason: "rate_limited" },
    ]);
  });
});

describe("CSV export access (#430)", () => {
  test("a member gets 403 on an export route and sees no Export link", async () => {
    const forbidden = await get("/dashboard/emails/export.csv", tokens.member);
    expect(forbidden.status).toBe(403);
    const page = await get("/dashboard/emails?status=sent", tokens.member);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain("Export CSV");
  });

  test("an admin sees the Export link carrying the page's filters", async () => {
    const page = await get(
      `/dashboard/emails?status=sent&apiKeyId=${ids.key}`,
      tokens.admin,
    );
    const html = await page.text();
    expect(html).toContain(
      `href="/dashboard/emails/export.csv?status=sent&apiKeyId=${ids.key}"`,
    );
  });

  test("without a session: the login page", async () => {
    const response = await get("/dashboard/users/export.csv", null);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard/login");
  });
});
