/**
 * The domain page's BIMI check (#415) through the real `pagesPlugin` over
 * HTTP against real Postgres, with DNS stubbed through `setDomainDnsDeps`
 * and the logo fetch through `setBimiLogoDeps`: admins only, same-origin,
 * a banner by code, the result shown on the page after the redirect, and
 * nothing fetched on page load.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { setDomainDnsDeps } from "../../src/modules/domains/services/domain-dns-status.service.ts";
import { setBimiLogoDeps } from "../../src/modules/domains/services/bimi-logo.ts";
import * as domainService from "../../src/modules/domains/services/domain.service.ts";
import { dnsVerifyMap } from "../../src/pages/lib/dns-verify-throttle.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { truncateAll, seed } from "./_helpers.ts";
import { installHermeticDomainDns } from "./_dns-stub.ts";

const pages = new Elysia().use(pagesPlugin);

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 10 10"><title>Acme</title></svg>`;

/** TXT answers by name; anything else is NXDOMAIN. */
let txt: Record<string, string> = {};
/** Logo requests made. */
let fetches = 0;

/** The logo fetch refuses everything: no real HTTPS in integration tests. */
function hermeticLogo(): void {
  setBimiLogoDeps({
    fetch: () => Promise.reject(new Error("no real HTTPS in integration tests")),
    resolver: () => Promise.reject(new Error("no real DNS in integration tests")),
  });
}

beforeEach(async () => {
  await truncateAll();
  dnsVerifyMap.clear();
  txt = {};
  fetches = 0;
  setDomainDnsDeps({
    resolveTxt: (name) => {
      const answer = txt[name];
      if (answer !== undefined) return Promise.resolve([[answer]]);
      return Promise.reject(Object.assign(new Error("nx"), { code: "ENOTFOUND" }));
    },
    resolveMx: () =>
      Promise.reject(Object.assign(new Error("nx"), { code: "ENOTFOUND" })),
    timeoutMs: 1000,
  });
  setBimiLogoDeps({
    fetch: () => {
      fetches++;
      return Promise.resolve(
        new Response(LOGO, { status: 200, headers: { "content-type": "image/svg+xml" } }),
      );
    },
    resolver: () => Promise.resolve([{ address: "93.184.216.34" }]),
    timeoutMs: 1000,
  });
});

afterAll(() => {
  installHermeticDomainDns();
  hermeticLogo();
});

/** A signed-in account of `role`, as its session token. */
async function signIn(role: "admin" | "member"): Promise<string> {
  const user = await seed.user({ email: `${role}@example.org`, role });
  return (await seed.session({ userId: user.id })).token;
}

function checkBimi(
  id: string,
  token: string,
  origin = "http://localhost",
): Promise<Response> {
  return pages.handle(
    new Request(`http://localhost/dashboard/domains/${id}/bimi`, {
      method: "POST",
      headers: { cookie: `bm_session=${token}`, origin },
    }),
  );
}

function page(path: string, token: string): Promise<Response> {
  return pages.handle(
    new Request(`http://localhost${path}`, {
      headers: { cookie: `bm_session=${token}` },
    }),
  );
}

describe("POST /dashboard/domains/:id/bimi (#415)", () => {
  test("an admin's check redirects with its banner; the page then shows the result", async () => {
    txt["default._bimi.acme.io"] =
      "v=BIMI1; l=https://acme.io/logo.svg; a=https://acme.io/vmc.pem";
    txt["_dmarc.acme.io"] = "v=DMARC1; p=reject";
    const domain = await domainService.createDomain({ name: "acme.io" });
    const admin = await signIn("admin");

    /** Page load checks nothing. */
    const before = await page(`/dashboard/domains/${domain.id}`, admin);
    expect(before.status).toBe(200);
    expect(await before.text()).toContain("Not checked in the last 30 minutes.");
    expect(fetches).toBe(0);

    const res = await checkBimi(domain.id, admin);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toBe(`/dashboard/domains/${domain.id}?flash=bimi_ready`);
    expect(fetches).toBe(1);

    const after = await page(location, admin);
    const html = await after.text();
    expect(html).toContain("BIMI check done: the domain is BIMI-ready");
    expect(html).toContain("The logo is an SVG Tiny PS document");
    expect(html).toContain("a= names a certificate at https://acme.io/vmc.pem");
    expect(fetches).toBe(1);
  });

  test("a member is refused and nothing is checked; a member still sees the result", async () => {
    txt["default._bimi.acme.io"] = "v=BIMI1; l=https://acme.io/logo.svg";
    const domain = await domainService.createDomain({ name: "acme.io" });
    const member = await signIn("member");
    expect((await checkBimi(domain.id, member)).status).toBe(403);
    expect(fetches).toBe(0);

    /** The result is per domain: an admin's check shows to a member. */
    const admin = await signIn("admin");
    const res = await checkBimi(domain.id, admin);
    expect(res.headers.get("location")).toContain("flash=bimi_not_ready");
    const html = await (await page(`/dashboard/domains/${domain.id}`, member)).text();
    expect(html).toContain("Not ready");
    /** The button is for admins only. */
    expect(html).not.toContain(`/dashboard/domains/${domain.id}/bimi`);
    const adminHtml = await (await page(`/dashboard/domains/${domain.id}`, admin)).text();
    expect(adminHtml).toContain(`action="/dashboard/domains/${domain.id}/bimi"`);
    expect(html).toContain("No DMARC record at _dmarc.acme.io");
  });

  test("a cross-origin POST is refused", async () => {
    const domain = await domainService.createDomain({ name: "acme.io" });
    const admin = await signIn("admin");
    expect((await checkBimi(domain.id, admin, "https://evil.example")).status).toBe(403);
  });

  test("no record, an unknown domain, and the throttle", async () => {
    const domain = await domainService.createDomain({ name: "acme.io" });
    const admin = await signIn("admin");
    const missing = await checkBimi(domain.id, admin);
    expect(missing.headers.get("location")).toBe(
      `/dashboard/domains/${domain.id}?flash=bimi_missing`,
    );
    expect(fetches).toBe(0);

    const unknown = await checkBimi("dom_missing", admin);
    expect(unknown.headers.get("location")).toBe(
      "/dashboard/domains?flash=domain_not_found",
    );

    /** Shares the Verify budget: 5 DNS checks per domain a minute. */
    for (let i = 0; i < 4; i++) await checkBimi(domain.id, admin);
    const throttled = await checkBimi(domain.id, admin);
    expect(throttled.headers.get("location")).toBe(
      `/dashboard/domains/${domain.id}?flash=bimi_throttled`,
    );
  });
});
