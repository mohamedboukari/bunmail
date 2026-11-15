/**
 * Postgres `infinity` / `-infinity` timestamps (#457) against real
 * Postgres. BunMail never writes them, but a hand-edited row can hold one,
 * and Bun 1.4 decodes it as the number `Infinity` (an invalid `Date` under
 * 1.3.14) although drizzle types the column `Date`. Every path below reads
 * such a row: the API serializer, the dashboard pages, the CSV export, the
 * trash purge (which copies timestamps into tombstones) and the domain
 * check (which wrote `verified_at` back). None may throw; a non-finite
 * value reads as "no date".
 */
import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { eq, sql } from "drizzle-orm";
import { emailsPlugin } from "../../src/modules/emails/emails.plugin.ts";
import { emailEvents } from "../../src/modules/emails/models/email-event.schema.ts";
import { emailTombstones } from "../../src/modules/emails/models/email-tombstone.schema.ts";
import { auditEvents } from "../../src/modules/audit/models/audit-event.schema.ts";
import { runTrashPurge } from "../../src/modules/trash/services/purge.service.ts";
import { applyDomainCheck } from "../../src/modules/domains/services/domain-check.service.ts";
import type { DomainCheckResult } from "../../src/modules/domains/types/domain-check.types.ts";
import { exportBudgetMap, resetExportSlots } from "../../src/pages/lib/export-limiter.ts";
import { finiteDate } from "../../src/utils/finite-date.ts";
import { generateId } from "../../src/utils/id.ts";
import { readJson } from "../read-json.ts";
import { bodyText, get, parseCsv, rowObjects } from "./_csv.ts";
import { db, seed, truncateAll, emails, domains } from "./_helpers.ts";

/** The emails API, as `src/app.ts` mounts it. */
const api = new Elysia().use(emailsPlugin);

const ctx = { adminToken: "", rawKey: "", apiKeyId: "", emailId: "" };

/** A serialized email, as far as these tests read it. */
interface EmailBody {
  success: boolean;
  data?: {
    id: string;
    createdAt: string | null;
    sentAt: string | null;
    firstOpenedAt: string | null;
  };
}

beforeAll(async () => {
  await truncateAll();
  const admin = await seed.user({ email: "admin@example.com", role: "admin" });
  ctx.adminToken = (await seed.session({ userId: admin.id })).token;
  const key = await seed.apiKey({ name: "infinity-key" });
  ctx.rawKey = key.rawKey;
  ctx.apiKeyId = key.id;

  /** A sent email with every kind of infinite timestamp the pages show. */
  ctx.emailId = (await seed.email({ apiKeyId: key.id, status: "sent" })).id;
  await db
    .update(emails)
    .set({
      createdAt: sql`'infinity'::timestamptz`,
      sentAt: sql`'infinity'::timestamptz`,
      firstOpenedAt: sql`'-infinity'::timestamptz`,
    })
    .where(eq(emails.id, ctx.emailId));
  await db.insert(emailEvents).values({
    id: generateId("evt"),
    emailId: ctx.emailId,
    apiKeyId: key.id,
    type: "open",
    clientKind: "unknown",
    machine: false,
    occurredAt: sql`'infinity'::timestamptz`,
  });

  /** Inserted directly: `audit_events` is append-only, so it cannot be edited after. */
  await db.insert(auditEvents).values({
    id: generateId("aud"),
    occurredAt: sql`'-infinity'::timestamptz`,
    actorType: "user",
    actorId: admin.id,
    action: "api_key.created",
    outcome: "success",
    targetType: "api_key",
    targetId: key.id,
    metadata: { isAdmin: false, allowedSenders: 0 },
  });
});

beforeEach(() => {
  exportBudgetMap.clear();
  resetExportSlots();
});

describe("Postgres infinity timestamps (#457)", () => {
  test("the driver does not hand them over as a finite Date", async () => {
    const [row] = await db
      .select({ sentAt: emails.sentAt, firstOpenedAt: emails.firstOpenedAt })
      .from(emails)
      .where(eq(emails.id, ctx.emailId));
    expect(row).toBeDefined();
    expect(finiteDate(row?.sentAt)).toBeNull();
    expect(finiteDate(row?.firstOpenedAt)).toBeNull();
  });

  test("the API serializes them as null", async () => {
    const one = await api.handle(
      new Request(`http://localhost/api/v1/emails/${ctx.emailId}`, {
        headers: { authorization: `Bearer ${ctx.rawKey}` },
      }),
    );
    expect(one.status).toBe(200);
    const body = await readJson<EmailBody>(one);
    expect(body.data?.id).toBe(ctx.emailId);
    expect(body.data?.createdAt).toBeNull();
    expect(body.data?.sentAt).toBeNull();
    expect(body.data?.firstOpenedAt).toBeNull();

    const list = await api.handle(
      new Request("http://localhost/api/v1/emails", {
        headers: { authorization: `Bearer ${ctx.rawKey}` },
      }),
    );
    expect(list.status).toBe(200);
  });

  test("the dashboard pages render them as no date", async () => {
    const detail = await get(`/dashboard/emails/${ctx.emailId}`, ctx.adminToken);
    expect(detail.status).toBe(200);
    const html = await detail.text();
    /** The timeline row and the Sent field fall back instead of throwing. */
    expect(html).toContain("Opens and clicks");
    expect(html).toContain("n/a");

    for (const path of ["/dashboard/emails", "/dashboard/audit-log"]) {
      const page = await get(path, ctx.adminToken);
      expect(page.status).toBe(200);
    }
  });

  test("the CSV export writes them as empty cells", async () => {
    const response = await get("/dashboard/emails/export.csv", ctx.adminToken);
    expect(response.status).toBe(200);
    const rows = rowObjects(parseCsv(await bodyText(response)));
    const row = rows.find((r) => r["id"] === ctx.emailId);
    expect(row?.["created_at"]).toBe("");
    expect(row?.["sent_at"]).toBe("");
    expect(row?.["first_opened_at"]).toBe("");

    const audit = await get("/dashboard/audit-log/export.csv", ctx.adminToken);
    expect(audit.status).toBe(200);
    /** The emails export above is audited too: pick the seeded event. */
    const seeded = rowObjects(parseCsv(await bodyText(audit))).find(
      (r) => r["action"] === "api_key.created",
    );
    expect(seeded?.["occurred_at"]).toBe("");
  });

  test("the trash purge tombstones the email with no dates", async () => {
    const { id } = await seed.email({ apiKeyId: ctx.apiKeyId, status: "sent" });
    await db
      .update(emails)
      .set({
        sentAt: sql`'infinity'::timestamptz`,
        deletedAt: sql`'-infinity'::timestamptz`,
      })
      .where(eq(emails.id, id));

    const purged = await runTrashPurge();
    expect(purged.emailsPurged).toBe(1);
    const [tombstone] = await db
      .select({ sentAt: emailTombstones.sentAt, deletedAt: emailTombstones.deletedAt })
      .from(emailTombstones)
      .where(eq(emailTombstones.id, id));
    expect(tombstone).toEqual({ sentAt: null, deletedAt: null });

    const page = await get("/dashboard/emails/tombstones", ctx.adminToken);
    expect(page.status).toBe(200);
  });

  test("the domain check leaves an infinite verified_at as stored", async () => {
    const { id } = await seed.domain({ name: "infinity.example.com" });
    await db
      .update(domains)
      .set({
        spfVerified: true,
        dkimVerified: true,
        dmarcVerified: true,
        verifiedAt: sql`'infinity'::timestamptz`,
      })
      .where(eq(domains.id, id));
    const pass: DomainCheckResult = {
      spf: { status: "pass", reason: "spf pass" },
      dkim: { status: "pass", reason: "dkim pass" },
      dmarc: { status: "pass", reason: "dmarc pass" },
      checkedAt: new Date().toISOString(),
    };

    const applied = await applyDomainCheck(id, pass);
    expect(applied?.transition.event).toBeNull();
    const [row] = await db
      .select({ infinite: sql<boolean>`${domains.verifiedAt} = 'infinity'::timestamptz` })
      .from(domains)
      .where(eq(domains.id, id));
    expect(row?.infinite).toBe(true);
  });
});
