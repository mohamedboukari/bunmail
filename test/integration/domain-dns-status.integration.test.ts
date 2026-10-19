/**
 * The domain API and page with the DMARC check, the DNS records to publish
 * and the MX status (#250), over HTTP against real Postgres, with DNS
 * stubbed through `setDomainDnsDeps`. DNS content is attacker-controlled
 * and must render escaped.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { config } from "../../src/config.ts";
import { domainsPlugin } from "../../src/modules/domains/domains.plugin.ts";
import { setDomainDnsDeps } from "../../src/modules/domains/services/domain-dns-status.service.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { truncateAll, seed } from "./_helpers.ts";
import { readJson } from "../read-json.ts";
import { installHermeticDomainDns } from "./_dns-stub.ts";

interface DomainData {
  id: string;
  dnsRecords: Array<{ type: string; host: string; value: string; optional: boolean }>;
  dmarc: {
    status: string;
    ok: boolean;
    policy: string | null;
    subdomainPolicy: string | null;
    effectivePolicy: string | null;
    inherited: boolean;
    rua: string[];
    problems: string[];
  } | null;
  mx: { status: string; hosts: string[] } | null;
}

const XSS = "<svg/onload=alert(1)>";

/** TXT answers by name; anything else is NXDOMAIN. */
let txt: Record<string, string[][]> = {};
/** The MX hosts of every domain. */
let mxHosts: string[] = [];
let mxError: string | null = null;

const pages = new Elysia().use(pagesPlugin);
let adminKey = "";
let restrictedKey = "";

function api(
  method: string,
  path: string,
  key: string,
  body?: unknown,
): Promise<Response> {
  return domainsPlugin.handle(
    new Request(`http://localhost/api/v1/domains${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function createDomain(name: string): Promise<DomainData> {
  const res = await api("POST", "", adminKey, { name });
  expect(res.status).toBe(200);
  return (await readJson<{ data: DomainData }>(res)).data;
}

beforeEach(async () => {
  await truncateAll();
  txt = {};
  mxHosts = [];
  mxError = null;
  setDomainDnsDeps({
    resolveTxt: (name) => {
      const answer = txt[name];
      if (answer) return Promise.resolve(answer);
      return Promise.reject(Object.assign(new Error("nx"), { code: "ENOTFOUND" }));
    },
    resolveMx: () =>
      mxError === null
        ? Promise.resolve(mxHosts.map((exchange) => ({ exchange })))
        : Promise.reject(Object.assign(new Error("dns"), { code: mxError })),
    timeoutMs: 1000,
  });
  adminKey = (await seed.apiKey({ isAdmin: true })).rawKey;
  restrictedKey = (await seed.apiKey({ isAdmin: false })).rawKey;
});

/** Back to the run-wide hermetic stub, never to real DNS. */
afterAll(() => {
  installHermeticDomainDns();
});

describe("domain API: dmarc, dnsRecords and mx (#250)", () => {
  test("the response carries the parsed DMARC check, the records and the MX status", async () => {
    txt["_dmarc.acme.io"] = [
      ["v=DMARC1; p=quarantine; sp=reject; ", "rua=mailto:d@acme.io"],
    ];
    mxHosts = [`${config.mail.hostname}.`];
    const { id } = await createDomain("acme.io");

    const res = await api("GET", `/${id}`, adminKey);
    expect(res.status).toBe(200);
    const { data } = await readJson<{ data: DomainData }>(res);
    expect(data.dmarc).toMatchObject({
      status: "pass",
      ok: true,
      policy: "quarantine",
      subdomainPolicy: "reject",
      effectivePolicy: "quarantine",
      inherited: false,
      rua: ["mailto:d@acme.io"],
    });
    expect(data.mx).toEqual({ status: "here", hosts: [config.mail.hostname] });
    const types = data.dnsRecords.map((r) => r.type);
    expect(types.slice(0, 3)).toEqual(["TXT", "TXT", "TXT"]);
    expect(types).toContain("PTR");
    expect(data.dnsRecords.at(-1)).toMatchObject({ type: "MX", optional: true });
    const dkim = data.dnsRecords.find((r) => r.host === "bunmail._domainkey.acme.io");
    for (const part of dkim!.value.split('" "')) {
      expect(part.replace(/"/g, "").length).toBeLessThanOrEqual(255);
    }

    /** The list carries the same fields. */
    const list = await readJson<{ data: DomainData[] }>(await api("GET", "", adminKey));
    expect(list.data[0]?.dmarc?.status).toBe("pass");
    expect(list.data[0]?.mx?.status).toBe("here");
  });

  test("two DMARC records and an MX elsewhere are reported, not errors", async () => {
    txt["_dmarc.acme.io"] = [["v=DMARC1; p=reject"], ["v=DMARC1; p=none"]];
    mxHosts = ["aspmx.l.google.com"];
    const { id } = await createDomain("acme.io");
    const { data } = await readJson<{ data: DomainData }>(
      await api("GET", `/${id}`, adminKey),
    );
    expect(data.dmarc?.status).toBe("multiple");
    expect(data.mx).toEqual({ status: "elsewhere", hosts: ["aspmx.l.google.com"] });
  });

  test("DNS failures give error statuses with a 200", async () => {
    mxError = "ESERVFAIL";
    setDomainDnsDeps({
      resolveTxt: () =>
        Promise.reject(Object.assign(new Error("dns"), { code: "ESERVFAIL" })),
      resolveMx: () =>
        Promise.reject(Object.assign(new Error("dns"), { code: "ESERVFAIL" })),
      timeoutMs: 1000,
    });
    const { id } = await createDomain("acme.io");
    const res = await api("GET", `/${id}`, adminKey);
    expect(res.status).toBe(200);
    const { data } = await readJson<{ data: DomainData }>(res);
    expect(data.dmarc?.status).toBe("error");
    expect(data.mx?.status).toBe("error");
  });

  test("create never waits on DNS: dmarc and mx are null even when DNS hangs", async () => {
    const hang = (): Promise<never> => new Promise<never>(() => {});
    setDomainDnsDeps({ resolveTxt: hang, resolveMx: hang, timeoutMs: 60_000 });
    const started = performance.now();
    const res = await api("POST", "", adminKey, { name: "slow-dns.example" });
    expect(res.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(2_000);
    const { data } = await readJson<{ data: DomainData }>(res);
    expect(data.dmarc).toBeNull();
    expect(data.mx).toBeNull();
    /** The records to publish need no DNS and are there. */
    expect(data.dnsRecords.length).toBeGreaterThan(0);

    /** A settings change does not wait either. */
    const patched = await api("PATCH", `/${data.id}`, adminKey, { unsubscribeUrl: null });
    expect(patched.status).toBe(200);
    expect((await readJson<{ data: DomainData }>(patched)).data.mx).toBeNull();
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("a single GET waits at most one overall deadline, then reports errors", async () => {
    const hang = (): Promise<never> => new Promise<never>(() => {});
    setDomainDnsDeps({ resolveTxt: hang, resolveMx: hang, timeoutMs: 300 });
    const { id } = await createDomain("mail.slow-dns.example");
    const started = performance.now();
    const res = await api("GET", `/${id}`, adminKey);
    expect(res.status).toBe(200);
    /** One budget for DMARC (own record plus fallback) and MX together. */
    expect(performance.now() - started).toBeLessThan(1_000);
    const { data } = await readJson<{ data: DomainData }>(res);
    expect(data.dmarc?.status).toBe("error");
    expect(data.mx?.status).toBe("error");
  });

  test("authz unchanged: a restricted key gets 403", async () => {
    const { id } = await createDomain("acme.io");
    expect((await api("GET", `/${id}`, restrictedKey)).status).toBe(403);
    expect((await api("GET", "", restrictedKey)).status).toBe(403);
  });
});

describe("domain page: DNS panels (#250)", () => {
  test("renders the DMARC panel, records and MX status, escaping DNS content", async () => {
    txt["_dmarc.acme.io"] = [
      [`v=DMARC1; p=none; rua=mailto:${XSS}@acme.io; adkim=${XSS}`],
    ];
    mxHosts = [`${XSS}.example`];
    const { id } = await createDomain("acme.io");
    const member = await seed.user({ email: "member@example.org", role: "member" });
    const { token } = await seed.session({ userId: member.id });

    const res = await pages.handle(
      new Request(`http://localhost/dashboard/domains/${id}`, {
        headers: { cookie: `bm_session=${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("DMARC Policy");
    expect(html).toContain("Required DNS Records");
    expect(html).toContain("MX and Mail Flow");
    expect(html).toContain("v=DMARC1; p=none; rua=mailto:dmarc@acme.io");
    expect(html).not.toContain("<svg/onload");
    expect(html).toContain("mailto:&lt;svg/onload=alert(1)&gt;@acme.io");
    expect(html).toContain("&lt;svg/onload=alert(1)&gt;.example");
  });
});
