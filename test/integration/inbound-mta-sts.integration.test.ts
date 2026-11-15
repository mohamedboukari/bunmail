/**
 * Inbound MTA-STS (#472) against a real Postgres:
 *
 * - `GET /.well-known/mta-sts.txt` behind the app's security headers,
 *   keyed by `Host`: a verified opted-in domain gets its policy (exact
 *   text, `text/plain`, `Cache-Control: max-age` capped at an hour, no cookie); an
 *   unverified domain, mode `none`, an unknown host and a non-policy host
 *   all get the same 404;
 * - the dashboard route `POST /dashboard/domains/:id/mta-sts`: admins
 *   only, audited as `domain.updated`, served at once, with the
 *   no-STARTTLS warning for enforce;
 * - `PATCH /api/v1/domains/:id` with `mtaStsMode`, and the records it
 *   adds to `dnsRecords`;
 * - the inline check of a send never fetches the policy (it would hold
 *   the send up), while Verify does;
 * - the migration: the column defaults to `none` and its CHECK refuses
 *   any other value.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { and, eq, sql } from "drizzle-orm";
import { securityHeadersPlugin } from "../../src/middleware/security-headers.ts";
import { mtaStsPlugin } from "../../src/modules/domains/mta-sts.plugin.ts";
import { domainsPlugin } from "../../src/modules/domains/domains.plugin.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { forgetMtaStsHosts } from "../../src/modules/domains/services/mta-sts-hosts.service.ts";
import { servedMtaStsPolicy } from "../../src/modules/domains/services/mta-sts-served-policy.ts";
import { auditEvents } from "../../src/modules/audit/models/audit-event.schema.ts";
import type { DomainMtaStsMode } from "../../src/modules/domains/types/domain.types.ts";
import type { UserRole } from "../../src/modules/users/types/user.types.ts";
import { checkSenderDomain } from "../../src/modules/emails/services/sender-domain.service.ts";
import { verifyDomain } from "../../src/modules/domains/services/dns-verification.service.ts";
import { getDomainById } from "../../src/modules/domains/services/domain.service.ts";
import { config } from "../../src/config.ts";
import { truncateAll, seed, db, domains } from "./_helpers.ts";
import { installHermeticMtaSts } from "./_dns-stub.ts";
import { readJson } from "../read-json.ts";
import { flashOfResponse } from "../flash-of.ts";

const originalSmtp = { enabled: config.smtp.enabled, tls: config.smtp.tls };

const app = new Elysia()
  .use(securityHeadersPlugin({ httpsBaseUrl: true }))
  .use(mtaStsPlugin());

function fetchPolicy(host: string): Promise<Response> {
  return app.handle(
    new Request("http://localhost/.well-known/mta-sts.txt", { headers: { host } }),
  );
}

/** A domain with the given mode, verified unless `verified` is false. */
async function domainWith(
  name: string,
  mode: DomainMtaStsMode,
  verified = true,
): Promise<string> {
  const { id } = await seed.domain({ name });
  await db
    .update(domains)
    .set({ mtaStsMode: mode, verifiedAt: verified ? new Date() : null })
    .where(eq(domains.id, id));
  return id;
}

async function modeOf(id: string): Promise<string | undefined> {
  const [row] = await db
    .select({ mode: domains.mtaStsMode })
    .from(domains)
    .where(eq(domains.id, id));
  return row?.mode;
}

beforeEach(async () => {
  await truncateAll();
  forgetMtaStsHosts();
});

afterEach(() => {
  Object.assign(config.smtp, originalSmtp);
  forgetMtaStsHosts();
});

describe("GET /.well-known/mta-sts.txt by Host", () => {
  test("a verified domain in enforce gets its policy, exactly, with the headers", async () => {
    await domainWith("enforced.example.org", "enforce");
    const res = await fetchPolicy("mta-sts.enforced.example.org");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const policy = servedMtaStsPolicy("enforce");
    expect(res.headers.get("cache-control")).toBe("max-age=3600");
    expect(res.headers.get("set-cookie")).toBeNull();
    /** The app's security headers still apply. */
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(policy.text);
  });

  test("a verified domain in testing gets a testing policy; Host case and port ignored", async () => {
    await domainWith("tested.example.org", "testing");
    const res = await fetchPolicy("MTA-STS.Tested.Example.org:443");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(servedMtaStsPolicy("testing").text);
  });

  test("unverified, mode none, unknown and non-policy hosts all get the same 404", async () => {
    await domainWith("unverified.example.org", "enforce", false);
    await domainWith("off.example.org", "none");
    await domainWith("enforced.example.org", "enforce");
    const answers = await Promise.all(
      [
        "mta-sts.unverified.example.org",
        "mta-sts.off.example.org",
        "mta-sts.unknown.example.org",
        "enforced.example.org",
        "localhost",
      ].map(async (host) => {
        const res = await fetchPolicy(host);
        return `${res.status} ${res.headers.get("content-type")} ${await res.text()}`;
      }),
    );
    expect(new Set(answers)).toEqual(
      new Set(["404 text/plain; charset=utf-8 Not found\n"]),
    );
  });
});

/* ─── Dashboard ─── */

const dashboard = new Elysia().use(pagesPlugin);

async function tokenFor(role: UserRole): Promise<string> {
  const { id } = await seed.user({ email: `${role}-${Date.now()}@example.com`, role });
  return (await seed.session({ userId: id })).token;
}

function postMode(id: string, token: string, mode: string): Promise<Response> {
  return dashboard.handle(
    new Request(`http://localhost/dashboard/domains/${id}/mta-sts`, {
      method: "POST",
      headers: {
        cookie: `bm_session=${token}`,
        origin: "http://localhost",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ mode }).toString(),
    }),
  );
}

describe("POST /dashboard/domains/:id/mta-sts", () => {
  test("an admin sets testing: saved, audited, served at once", async () => {
    const id = await domainWith("dash.example.org", "none");
    /** Read once while off, so the served set is cached without it. */
    expect((await fetchPolicy("mta-sts.dash.example.org")).status).toBe(404);

    const res = await postMode(id, await tokenFor("admin"), "testing");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`/dashboard/domains/${id}?flash=`);
    expect(flashOfResponse(res)?.message).toContain("MTA-STS mode saved");
    expect(await modeOf(id)).toBe("testing");
    expect((await fetchPolicy("mta-sts.dash.example.org")).status).toBe(200);

    const audits = await db
      .select({ metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "domain.updated"), eq(auditEvents.targetId, id)));
    expect(audits.map((row) => row.metadata)).toEqual([{ fields: ["mtaStsMode"] }]);
  });

  test("enforce without inbound STARTTLS is saved with a warning", async () => {
    Object.assign(config.smtp, { enabled: true, tls: null });
    const id = await domainWith("warn.example.org", "testing");
    const res = await postMode(id, await tokenFor("owner"), "enforce");
    expect(await modeOf(id)).toBe("enforce");
    expect(flashOfResponse(res)?.type).toBe("error");
    expect(flashOfResponse(res)?.message).toContain("no inbound STARTTLS");
  });

  test("enforce with inbound STARTTLS: the plain saved banner", async () => {
    Object.assign(config.smtp, {
      enabled: true,
      tls: { certPath: "/x/cert.pem", keyPath: "/x/key.pem" },
    });
    const id = await domainWith("tls.example.org", "testing");
    const res = await postMode(id, await tokenFor("admin"), "enforce");
    expect(flashOfResponse(res)?.type).toBe("success");
  });

  test("none stops serving at once", async () => {
    const id = await domainWith("stop.example.org", "enforce");
    expect((await fetchPolicy("mta-sts.stop.example.org")).status).toBe(200);
    const res = await postMode(id, await tokenFor("admin"), "none");
    expect(flashOfResponse(res)?.message).toContain("turned off");
    expect((await fetchPolicy("mta-sts.stop.example.org")).status).toBe(404);
  });

  test("a member gets 403 and changes nothing; an invalid mode is refused", async () => {
    const id = await domainWith("member.example.org", "none");
    const res = await postMode(id, await tokenFor("member"), "enforce");
    expect(res.status).toBe(403);
    expect(await modeOf(id)).toBe("none");

    const bad = await postMode(id, await tokenFor("admin"), "strict");
    expect(bad.status).toBe(422);
    expect(await modeOf(id)).toBe("none");
  });

  test("an unknown domain lands on the list", async () => {
    const res = await postMode("dom_missing", await tokenFor("admin"), "testing");
    expect(res.headers.get("location")).toContain("/dashboard/domains?flash=");
  });
});

/* ─── REST ─── */

const api = new Elysia().use(domainsPlugin);

function patch(id: string, key: string, body: unknown): Promise<Response> {
  return api.handle(
    new Request(`http://localhost/api/v1/domains/${id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

interface DomainBody {
  data: {
    mtaStsMode: string;
    dnsRecords: { type: string; host: string; value: string }[];
  };
}

describe("PATCH /api/v1/domains/:id mtaStsMode", () => {
  test("an admin key sets it; dnsRecords gains the TXT record and host; audited", async () => {
    const { rawKey } = await seed.apiKey({ isAdmin: true });
    const id = await domainWith("rest.example.org", "none");
    const res = await patch(id, rawKey, { mtaStsMode: "enforce" });
    expect(res.status).toBe(200);
    const body = await readJson<DomainBody>(res);
    expect(body.data.mtaStsMode).toBe("enforce");
    const txt = body.data.dnsRecords.find((r) => r.host === "_mta-sts.rest.example.org");
    expect(txt?.value).toBe(`v=STSv1; id=${servedMtaStsPolicy("enforce").id}`);
    expect(body.data.dnsRecords.some((r) => r.host === "mta-sts.rest.example.org")).toBe(
      true,
    );
    expect(await modeOf(id)).toBe("enforce");
    expect((await fetchPolicy("mta-sts.rest.example.org")).status).toBe(200);

    const [audit] = await db
      .select({ metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "domain.updated"), eq(auditEvents.targetId, id)));
    expect(audit?.metadata).toEqual({ fields: ["mtaStsMode"] });
  });

  test("any other value is a 422", async () => {
    const { rawKey } = await seed.apiKey({ isAdmin: true });
    const id = await domainWith("rest-bad.example.org", "none");
    const res = await patch(id, rawKey, { mtaStsMode: "strict" });
    expect(res.status).toBe(422);
    expect(await modeOf(id)).toBe("none");
  });
});

/* ─── Send latency ─── */

describe("the inline check of a send", () => {
  const originalRequire = config.mail.requireVerifiedDomain;
  let policyHostLookups = 0;

  beforeEach(() => {
    policyHostLookups = 0;
    /** Every policy fetch starts with this lookup of `mta-sts.<domain>`. */
    installHermeticMtaSts({
      lookup: () => {
        policyHostLookups++;
        return Promise.reject(Object.assign(new Error("stub"), { code: "ENOTFOUND" }));
      },
    });
    expect(Reflect.set(config.mail, "requireVerifiedDomain", true)).toBe(true);
  });

  afterEach(() => {
    installHermeticMtaSts();
    expect(Reflect.set(config.mail, "requireVerifiedDomain", originalRequire)).toBe(true);
  });

  test("re-verifies an unverified enforce domain without fetching its policy; Verify does fetch", async () => {
    const id = await domainWith("inline.example.org", "enforce", false);
    let refused: unknown = null;
    try {
      await checkSenderDomain("inline.example.org", { id: "msg_x", apiKeyId: "key_x" });
    } catch (error) {
      refused = error;
    }
    /** DKIM fails against the NXDOMAIN stub: the send is refused after the inline check. */
    expect(refused).not.toBeNull();
    const [row] = await db
      .select({ checked: domains.lastCheckedAt })
      .from(domains)
      .where(eq(domains.id, id));
    expect(row?.checked).not.toBeNull();
    expect(policyHostLookups).toBe(0);

    const domain = await getDomainById(id);
    if (domain === undefined) throw new Error("domain missing");
    const result = await verifyDomain(domain);
    expect(policyHostLookups).toBe(1);
    expect(result.checks?.mtaSts?.status).toBe("fail");
  });
});

/* ─── Migration ─── */

describe("migration 0046", () => {
  test("the column defaults to none; the CHECK refuses other values", async () => {
    const { id } = await seed.domain({ name: "migrated.example.org" });
    expect(await modeOf(id)).toBe("none");
    let refused: unknown = null;
    try {
      await db.execute(sql`UPDATE domains SET mta_sts_mode = 'strict' WHERE id = ${id}`);
    } catch (error) {
      refused = error;
    }
    expect(refused).not.toBeNull();
    expect(await modeOf(id)).toBe("none");
  });
});
