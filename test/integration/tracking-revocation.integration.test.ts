/**
 * Revoking a domain's click tracking links (#424), over the REST API and
 * the dashboard against real Postgres: an admin bumps the domain's
 * tracking epoch (audited as `domain.tracking_links_revoked`), a
 * restricted key or a member is refused and nothing changes, an unknown
 * domain is a 404 or an error flash. What a bump does to the links
 * themselves is covered in `tracking.integration.test.ts`.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { TrackingEpochExhaustedError } from "../../src/modules/domains/errors.ts";
import { and, eq } from "drizzle-orm";
import { domainsPlugin } from "../../src/modules/domains/domains.plugin.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { auditEvents } from "../../src/modules/audit/models/audit-event.schema.ts";
import { truncateAll, seed, db, domains } from "./_helpers.ts";
import { readJson } from "../read-json.ts";
import { flashOfResponse } from "../flash-of.ts";

/** Mirrors the global onError branch for the highest epoch (`src/app.ts`). */
const api = new Elysia()
  .onError(({ error, set }) => {
    if (error instanceof TrackingEpochExhaustedError) {
      set.status = error.status;
      return { success: false, error: error.message, code: error.code };
    }
  })
  .use(domainsPlugin);
const pages = new Elysia().use(pagesPlugin);

interface ApiBody {
  success: boolean;
  data?: { id: string; trackingEpoch: number };
  error?: string;
  code?: string;
}

/** `POST /api/v1/domains/:id/tracking-revocation` with `rawKey`. */
async function revoke(id: string, rawKey: string): Promise<ApiBody & { status: number }> {
  const res = await api.handle(
    new Request(`http://localhost/api/v1/domains/${id}/tracking-revocation`, {
      method: "POST",
      headers: { authorization: `Bearer ${rawKey}` },
    }),
  );
  return { status: res.status, ...(await readJson<ApiBody>(res)) };
}

/** A same-origin dashboard request with a session cookie. */
function dash(method: "GET" | "POST", path: string, token: string): Promise<Response> {
  const headers: Record<string, string> = { cookie: `bm_session=${token}` };
  const url = `http://localhost${path}`;
  if (method === "GET") return pages.handle(new Request(url, { headers }));
  headers["origin"] = "http://localhost";
  headers["content-type"] = "application/x-www-form-urlencoded";
  return pages.handle(new Request(url, { method: "POST", headers, body: "" }));
}

async function sessionOf(
  role: "admin" | "member",
): Promise<{ id: string; token: string }> {
  const user = await seed.user({ email: `${role}@example.org`, role });
  const { token } = await seed.session({ userId: user.id });
  return { id: user.id, token };
}

async function epochOf(id: string): Promise<number | undefined> {
  const [row] = await db
    .select({ epoch: domains.trackingEpoch })
    .from(domains)
    .where(eq(domains.id, id));
  return row?.epoch;
}

/** The revocation audit events, oldest epoch first. */
async function revocations() {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "domain.tracking_links_revoked"));
  return rows.toSorted(
    (a, b) => Number(a.metadata?.["epoch"] ?? 0) - Number(b.metadata?.["epoch"] ?? 0),
  );
}

let domainId = "";

beforeEach(async () => {
  await truncateAll();
  domainId = (await seed.domain({ name: "tracked.example.com", trackClicks: true })).id;
});

describe("POST /api/v1/domains/:id/tracking-revocation (#424)", () => {
  test("an admin key bumps the epoch each time, audited with the new epoch", async () => {
    const key = await seed.apiKey({ name: "ops", isAdmin: true });
    const first = await revoke(domainId, key.rawKey);
    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({ id: domainId, trackingEpoch: 1 });
    expect((await revoke(domainId, key.rawKey)).data?.trackingEpoch).toBe(2);
    expect(await epochOf(domainId)).toBe(2);

    const rows = await revocations();
    expect(rows.map((r) => r.metadata)).toEqual([{ epoch: 1 }, { epoch: 2 }]);
    expect(rows[0]).toMatchObject({
      actorType: "api_key",
      actorId: key.id,
      targetType: "domain",
      targetId: domainId,
      targetLabel: "tracked.example.com",
    });
  });

  test("an unknown domain is 404 and audits nothing", async () => {
    const key = await seed.apiKey({ isAdmin: true });
    const res = await revoke("dom_000000000000000000000000", key.rawKey);
    expect(res.status).toBe(404);
    expect(res.error).toBe("Domain not found");
    expect(await revocations()).toEqual([]);
  });

  test("at the highest epoch: 409 TRACKING_EPOCH_EXHAUSTED, nothing changes, nothing audited", async () => {
    const key = await seed.apiKey({ isAdmin: true });
    await db
      .update(domains)
      .set({ trackingEpoch: 2_147_483_647 })
      .where(eq(domains.id, domainId));
    const res = await revoke(domainId, key.rawKey);
    expect(res.status).toBe(409);
    expect(res.code).toBe("TRACKING_EPOCH_EXHAUSTED");
    expect(await epochOf(domainId)).toBe(2_147_483_647);
    expect(await revocations()).toEqual([]);
  });

  test("a restricted key is refused and nothing changes", async () => {
    const key = await seed.apiKey({ isAdmin: false });
    expect((await revoke(domainId, key.rawKey)).status).toBe(403);
    expect(await epochOf(domainId)).toBe(0);
    expect(await revocations()).toEqual([]);
  });
});

describe("POST /dashboard/domains/:id/tracking-revoke (#424)", () => {
  test("the domain page shows the confirmed revoke button", async () => {
    const admin = await sessionOf("admin");
    const html = await (
      await dash("GET", `/dashboard/domains/${domainId}`, admin.token)
    ).text();
    expect(html).toContain(`action="/dashboard/domains/${domainId}/tracking-revoke"`);
    expect(html).toContain("Revoke tracking links");
  });

  test("an admin revokes: a success flash, the epoch bumped, audited as the user", async () => {
    const admin = await sessionOf("admin");
    const res = await dash(
      "POST",
      `/dashboard/domains/${domainId}/tracking-revoke`,
      admin.token,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toStartWith(`/dashboard/domains/${domainId}?`);
    expect(flashOfResponse(res)).toEqual({
      message:
        "Tracking links revoked: click links already sent from this domain no longer redirect",
      type: "success",
    });
    expect(await epochOf(domainId)).toBe(1);
    const rows = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorType, "user"), eq(auditEvents.actorId, admin.id)));
    expect(rows.map((r) => [r.action, r.metadata])).toEqual([
      ["domain.tracking_links_revoked", { epoch: 1 }],
    ]);
    const page = await (
      await dash("GET", `/dashboard/domains/${domainId}`, admin.token)
    ).text();
    expect(page).toContain("Revoked 1 time so far.");
  });

  test("an unknown domain: an error flash on the list", async () => {
    const admin = await sessionOf("admin");
    const res = await dash(
      "POST",
      "/dashboard/domains/dom_000000000000000000000000/tracking-revoke",
      admin.token,
    );
    expect(res.headers.get("location")).toStartWith("/dashboard/domains?");
    expect(flashOfResponse(res)).toEqual({ message: "Domain not found", type: "error" });
  });

  test("at the highest epoch: an error flash with the reason, nothing changes", async () => {
    const admin = await sessionOf("admin");
    await db
      .update(domains)
      .set({ trackingEpoch: 2_147_483_647 })
      .where(eq(domains.id, domainId));
    const res = await dash(
      "POST",
      `/dashboard/domains/${domainId}/tracking-revoke`,
      admin.token,
    );
    expect(flashOfResponse(res)?.type).toBe("error");
    expect(flashOfResponse(res)?.message).toContain("cannot be revoked again");
    expect(await epochOf(domainId)).toBe(2_147_483_647);
  });

  test("a member is refused and nothing changes", async () => {
    const member = await sessionOf("member");
    const res = await dash(
      "POST",
      `/dashboard/domains/${domainId}/tracking-revoke`,
      member.token,
    );
    expect(res.status).toBe(403);
    expect(await epochOf(domainId)).toBe(0);
    expect(await revocations()).toEqual([]);
  });
});
