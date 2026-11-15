import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_MTA_STS_MAX_AGE,
  MIN_MTA_STS_MAX_AGE,
  readMtaStsMaxAge,
  readMtaStsMx,
} from "../../src/config.ts";
import {
  mtaStsDomainFromHost,
  mtaStsPolicyUrl,
  mtaStsTxtValue,
  servedMtaStsPolicy,
  type MtaStsPolicySettings,
} from "../../src/modules/domains/services/mta-sts-served-policy.ts";
import {
  checkMtaSts,
  type MtaStsCheckDeps,
} from "../../src/modules/domains/services/mta-sts-check.service.ts";
import { mtaStsDnsRecords } from "../../src/modules/domains/services/required-dns-records.ts";
import {
  forgetMtaStsHosts,
  MTA_STS_HOSTS_TTL_MS,
  servedMtaStsMode,
  setMtaStsHostsDeps,
} from "../../src/modules/domains/services/mta-sts-hosts.service.ts";
import { mtaStsPlugin } from "../../src/modules/domains/mta-sts.plugin.ts";
import { runDnsChecks } from "../../src/modules/domains/services/dns-verification.service.ts";
import {
  MtaStsFetchError,
  parseMtaStsPolicy,
  parseMtaStsTxt,
  type MtaStsPolicy,
} from "../../src/modules/emails/services/mta-sts.ts";
import type { ServedMtaStsMode } from "../../src/modules/domains/types/domain.types.ts";

/**
 * Inbound MTA-STS (#472), the pure parts and the seams: the served policy
 * text and its id, the `Host` parsing, the config readers and their
 * bounds, the DNS records shown, the Verify check with stubbed DNS and
 * fetch, the served-domains cache with a stubbed load, and the route with
 * a stubbed lookup. Serving from a real database is in
 * `test/integration/inbound-mta-sts.integration.test.ts`.
 */

const SETTINGS: MtaStsPolicySettings = { mx: ["mail.example.com"], maxAgeSeconds: null };

describe("servedMtaStsPolicy", () => {
  test("RFC 8461 text: version, mode, one mx line each, max_age, CRLF", () => {
    const policy = servedMtaStsPolicy("enforce", {
      mx: ["mx1.example.com", "*.example.net"],
      maxAgeSeconds: null,
    });
    expect(policy.text).toBe(
      "version: STSv1\r\nmode: enforce\r\nmx: mx1.example.com\r\nmx: *.example.net\r\nmax_age: 604800\r\n",
    );
    expect(policy.maxAge).toBe(604_800);
  });

  test("max_age: one day for testing, one week for enforce, the configured one for both", () => {
    expect(servedMtaStsPolicy("testing", SETTINGS).maxAge).toBe(86_400);
    expect(servedMtaStsPolicy("enforce", SETTINGS).maxAge).toBe(604_800);
    const fixed = { ...SETTINGS, maxAgeSeconds: 1_209_600 };
    expect(servedMtaStsPolicy("testing", fixed).maxAge).toBe(1_209_600);
    expect(servedMtaStsPolicy("enforce", fixed).maxAge).toBe(1_209_600);
  });

  test("the outbound parser (what senders do) reads it back exactly", () => {
    const policy = servedMtaStsPolicy("testing", {
      mx: ["mx1.example.com", "*.example.net"],
      maxAgeSeconds: 172_800,
    });
    expect(parseMtaStsPolicy(policy.text)).toEqual({
      mode: "testing",
      mx: ["mx1.example.com", "*.example.net"],
      maxAge: 172_800,
    });
  });

  test("the id is stable for one policy and changes with mode, mx or max_age", () => {
    const base = servedMtaStsPolicy("testing", SETTINGS).id;
    expect(servedMtaStsPolicy("testing", { ...SETTINGS }).id).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{32}$/);
    const others = [
      servedMtaStsPolicy("enforce", SETTINGS).id,
      servedMtaStsPolicy("testing", { ...SETTINGS, mx: ["mx2.example.com"] }).id,
      servedMtaStsPolicy("testing", { ...SETTINGS, maxAgeSeconds: 90_000 }).id,
    ];
    expect(new Set([base, ...others]).size).toBe(4);
  });

  test("the TXT value is one the outbound parser accepts, with the id", () => {
    const policy = servedMtaStsPolicy("enforce", SETTINGS);
    expect(mtaStsTxtValue(policy)).toBe(`v=STSv1; id=${policy.id}`);
    expect(parseMtaStsTxt([[mtaStsTxtValue(policy)]])).toBe(policy.id);
    expect(mtaStsPolicyUrl("example.com")).toBe(
      "https://mta-sts.example.com/.well-known/mta-sts.txt",
    );
  });
});

describe("mtaStsDomainFromHost", () => {
  test.each([
    ["mta-sts.example.com", "example.com"],
    ["MTA-STS.Example.COM", "example.com"],
    ["mta-sts.example.com:443", "example.com"],
    ["mta-sts.example.com.", "example.com"],
    ["mta-sts.sub.example.co.uk", "sub.example.co.uk"],
  ])("%s -> %s", (host, domain) => {
    expect(mtaStsDomainFromHost(host)).toBe(domain);
  });

  test.each([
    [null],
    [""],
    ["example.com"],
    ["mail.example.com"],
    ["mta-sts.com"],
    ["mta-sts."],
    ["xmta-sts.example.com"],
    ["mta-sts.exa mple.com"],
    ["mta-sts.-bad.com"],
    ["mta-sts.example.com:443:1"],
    ["127.0.0.1"],
    ["[::1]:443"],
    [`mta-sts.${"a".repeat(64)}.com`],
  ])("%p is no policy host", (host) => {
    expect(mtaStsDomainFromHost(host)).toBeNull();
  });
});

describe("config", () => {
  test("MTA_STS_MX: unset is MAIL_HOSTNAME; a list is lowercased, deduplicated, wildcards kept", () => {
    expect(readMtaStsMx("mail.example.com", "")).toEqual(["mail.example.com"]);
    expect(readMtaStsMx("mail.example.com", "  ")).toEqual(["mail.example.com"]);
    expect(
      readMtaStsMx("x", " MX1.example.com. , *.example.net,mx1.example.com"),
    ).toEqual(["mx1.example.com", "*.example.net"]);
  });

  test.each([
    ["mx1.example.com,"],
    ["192.0.2.1"],
    ["localhost"],
    ["mx_1.example.com"],
    ["a.*.example.com"],
    ["https://mx.example.com"],
  ])("MTA_STS_MX=%p refuses to boot", (raw) => {
    expect(() => readMtaStsMx("mail.example.com", raw)).toThrow(/MTA_STS_MX/);
  });

  test("MTA_STS_MAX_AGE: unset is null (per-mode default), bounds enforced", () => {
    expect(readMtaStsMaxAge(undefined)).toBeNull();
    expect(readMtaStsMaxAge(" ")).toBeNull();
    expect(readMtaStsMaxAge(String(MIN_MTA_STS_MAX_AGE))).toBe(86_400);
    expect(readMtaStsMaxAge(String(MAX_MTA_STS_MAX_AGE))).toBe(31_557_600);
    expect(() => readMtaStsMaxAge(String(MIN_MTA_STS_MAX_AGE - 1))).toThrow(
      /MTA_STS_MAX_AGE/,
    );
    expect(() => readMtaStsMaxAge(String(MAX_MTA_STS_MAX_AGE + 1))).toThrow(
      /MTA_STS_MAX_AGE/,
    );
    expect(() => readMtaStsMaxAge("1w")).toThrow(/MTA_STS_MAX_AGE/);
  });
});

describe("mtaStsDnsRecords", () => {
  test("none for mode none", () => {
    expect(mtaStsDnsRecords({ name: "example.com", mtaStsMode: "none" })).toEqual([]);
    expect(mtaStsDnsRecords({ name: "example.com" })).toEqual([]);
  });

  test("the TXT record with the current id and the mta-sts host at the APP_BASE_URL host", () => {
    const records = mtaStsDnsRecords(
      { name: "example.com", mtaStsMode: "enforce" },
      { mtaSts: SETTINGS, appBaseUrl: "https://mail.example.com" },
    );
    const id = servedMtaStsPolicy("enforce", SETTINGS).id;
    expect(
      records.map(({ type, host, value, optional }) => ({ type, host, value, optional })),
    ).toEqual([
      {
        type: "TXT",
        host: "_mta-sts.example.com",
        value: `v=STSv1; id=${id}`,
        optional: true,
      },
      {
        type: "CNAME",
        host: "mta-sts.example.com",
        value: "mail.example.com",
        optional: true,
      },
    ]);
  });

  test("without APP_BASE_URL the host target is described", () => {
    const records = mtaStsDnsRecords(
      { name: "example.com", mtaStsMode: "testing" },
      { mtaSts: SETTINGS, appBaseUrl: "" },
    );
    expect(records[1]?.value).toBe("your reverse proxy's host name");
  });
});

describe("checkMtaSts (Verify)", () => {
  const domain = {
    name: "example.com",
    mtaStsMode: "enforce" as const,
    verifiedAt: new Date(),
  };
  const expected = servedMtaStsPolicy("enforce", SETTINGS);
  const served: MtaStsPolicy = {
    mode: "enforce",
    mx: [...SETTINGS.mx],
    maxAge: expected.maxAge,
  };

  function deps(overrides: Partial<MtaStsCheckDeps> = {}): MtaStsCheckDeps {
    return {
      resolveTxt: (host) =>
        host === "_mta-sts.example.com"
          ? Promise.resolve([[`v=STSv1; id=${expected.id}`]])
          : Promise.reject(new Error("unexpected")),
      fetchPolicy: () => Promise.resolve(served),
      ...overrides,
    };
  }

  function dnsError(code: string): Error {
    return Object.assign(new Error(code), { code });
  }

  test("mode none: nothing to check, no lookup", async () => {
    let looked = false;
    const result = await checkMtaSts(
      { name: "example.com", mtaStsMode: "none" },
      deps({
        resolveTxt: () => {
          looked = true;
          return Promise.resolve([]);
        },
      }),
      SETTINGS,
    );
    expect(result).toBeNull();
    expect(looked).toBe(false);
  });

  test("pass: the current id announced and the same policy served", async () => {
    const result = await checkMtaSts(domain, deps(), SETTINGS);
    expect(result?.status).toBe("pass");
  });

  test("pass: mx compared as a set", async () => {
    const two = { mx: ["mx1.example.com", "mx2.example.com"], maxAgeSeconds: null };
    const id = servedMtaStsPolicy("enforce", two).id;
    const result = await checkMtaSts(
      domain,
      deps({
        resolveTxt: () => Promise.resolve([[`v=STSv1; id=${id}`]]),
        fetchPolicy: () =>
          Promise.resolve({ ...served, mx: ["mx2.example.com", "mx1.example.com"] }),
      }),
      two,
    );
    expect(result?.status).toBe("pass");
  });

  test("fail: no record, or an old id", async () => {
    const none = await checkMtaSts(
      domain,
      deps({ resolveTxt: () => Promise.reject(dnsError("ENODATA")) }),
      SETTINGS,
    );
    expect(none).toMatchObject({ status: "fail" });
    expect(none?.reason).toContain(`id=${expected.id}`);

    const old = await checkMtaSts(
      domain,
      deps({ resolveTxt: () => Promise.resolve([["v=STSv1; id=old1"]]) }),
      SETTINGS,
    );
    expect(old).toMatchObject({ status: "fail" });
    expect(old?.reason).toContain("another policy id");
  });

  test("unknown: the TXT lookup failed", async () => {
    const result = await checkMtaSts(
      domain,
      deps({ resolveTxt: () => Promise.reject(dnsError("ESERVFAIL")) }),
      SETTINGS,
    );
    expect(result?.status).toBe("unknown");
  });

  test("fail: a certificate error, an HTTP error, another policy", async () => {
    const cert = await checkMtaSts(
      domain,
      deps({
        fetchPolicy: () =>
          Promise.reject(
            new MtaStsFetchError("policy fetch failed: x", "webpki-invalid"),
          ),
      }),
      SETTINGS,
    );
    expect(cert?.status).toBe("fail");
    expect(cert?.reason).toContain("certificate is not valid for mta-sts.example.com");

    const http = await checkMtaSts(
      { ...domain, verifiedAt: null },
      deps({
        fetchPolicy: () =>
          Promise.reject(new MtaStsFetchError("policy fetch answered HTTP 404")),
      }),
      SETTINGS,
    );
    expect(http?.reason).toContain("HTTP 404");
    expect(http?.reason).toContain("only while the domain is verified");

    const other = await checkMtaSts(
      domain,
      deps({ fetchPolicy: () => Promise.resolve({ ...served, mode: "testing" }) }),
      SETTINGS,
    );
    expect(other?.status).toBe("fail");
    expect(other?.reason).toContain("serves another policy");
  });
});

describe("servedMtaStsMode (the served-domains cache)", () => {
  afterEach(() => setMtaStsHostsDeps(null));

  test("one load serves every lookup within the TTL; names compared lowercase", async () => {
    let loads = 0;
    let clock = 1_000;
    setMtaStsHostsDeps({
      load: () => {
        loads++;
        return Promise.resolve([
          { name: "Example.com", mode: "enforce" as ServedMtaStsMode },
          { name: "other.org.", mode: "testing" as ServedMtaStsMode },
        ]);
      },
      now: () => clock,
    });
    expect(await servedMtaStsMode("example.com")).toBe("enforce");
    expect(await servedMtaStsMode("OTHER.org")).toBe("testing");
    expect(await servedMtaStsMode("unknown.com")).toBeNull();
    expect(loads).toBe(1);

    clock += MTA_STS_HOSTS_TTL_MS;
    await servedMtaStsMode("example.com");
    expect(loads).toBe(2);

    forgetMtaStsHosts();
    await servedMtaStsMode("example.com");
    expect(loads).toBe(3);
  });

  test("concurrent misses share one load", async () => {
    let loads = 0;
    setMtaStsHostsDeps({
      load: async () => {
        loads++;
        await Bun.sleep(5);
        const mode: ServedMtaStsMode = "testing";
        return [{ name: "example.com", mode }];
      },
    });
    const modes = await Promise.all([
      servedMtaStsMode("example.com"),
      servedMtaStsMode("example.com"),
      servedMtaStsMode("x.com"),
    ]);
    expect(modes).toEqual(["testing", "testing", null]);
    expect(loads).toBe(1);
  });

  test("a failed load keeps the previous set, and rejects when there is none", async () => {
    let fail = false;
    let clock = 0;
    setMtaStsHostsDeps({
      load: () =>
        fail
          ? Promise.reject(new Error("db down"))
          : Promise.resolve([
              { name: "example.com", mode: "enforce" as ServedMtaStsMode },
            ]),
      now: () => clock,
    });
    expect(await servedMtaStsMode("example.com")).toBe("enforce");
    fail = true;
    clock += MTA_STS_HOSTS_TTL_MS;
    expect(await servedMtaStsMode("example.com")).toBe("enforce");

    forgetMtaStsHosts();
    const failed = await servedMtaStsMode("example.com").then(
      () => null,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(Error);
  });
});

describe("GET /.well-known/mta-sts.txt (stubbed lookup)", () => {
  const modes = new Map<string, ServedMtaStsMode>([
    ["enforced.com", "enforce"],
    ["tested.com", "testing"],
  ]);
  const app = mtaStsPlugin({
    lookup: (name) => Promise.resolve(modes.get(name) ?? null),
    settings: SETTINGS,
  });

  function get(host: string | null): Promise<Response> {
    const headers = new Headers();
    if (host !== null) headers.set("host", host);
    return app.handle(
      new Request("http://localhost/.well-known/mta-sts.txt", { headers }),
    );
  }

  test("an opted-in domain gets its policy as text/plain, cached for max_age, no cookie", async () => {
    const res = await get("mta-sts.enforced.com");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=3600");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toBe(servedMtaStsPolicy("enforce", SETTINGS).text);

    const testing = await get("MTA-STS.tested.com:443");
    expect(testing.headers.get("cache-control")).toBe("max-age=3600");
    expect(await testing.text()).toContain("mode: testing\r\n");
  });

  test("Cache-Control is the policy's max_age when shorter than the hour cap", async () => {
    const short = mtaStsPlugin({
      lookup: () => Promise.resolve("testing"),
      settings: { ...SETTINGS, maxAgeSeconds: 600 },
    });
    const res = await short.handle(
      new Request("http://localhost/.well-known/mta-sts.txt", {
        headers: { host: "mta-sts.enforced.com" },
      }),
    );
    expect(res.headers.get("cache-control")).toBe("max-age=600");
    expect(await res.text()).toContain("max_age: 600\r\n");
  });

  test("every other request gets the same 404", async () => {
    const bodies = new Set<string>();
    for (const host of ["mta-sts.unknown.com", "enforced.com", "localhost", null]) {
      const res = await get(host);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
  });

  test("a failed lookup is a 503, never a policy or a 404", async () => {
    const failing = mtaStsPlugin({
      lookup: () => Promise.reject(new Error("db down")),
      settings: SETTINGS,
    });
    const res = await failing.handle(
      new Request("http://localhost/.well-known/mta-sts.txt", {
        headers: { host: "mta-sts.enforced.com" },
      }),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
  });
});

describe("runDnsChecks: the MTA-STS check is its own status", () => {
  const verificationDeps = (fetchPolicy: () => Promise<MtaStsPolicy>) => ({
    resolveTxt: () => Promise.resolve([] as string[][]),
    evaluateSpf: () => Promise.resolve("fail"),
    sendingIps: () =>
      Promise.resolve({ ips: ["192.0.2.1"], source: "MAIL_PUBLIC_IP" as const }),
    fetchMtaStsPolicy: fetchPolicy,
  });
  const domain = { name: "example.com", dkimSelector: "bunmail", dkimPublicKey: null };

  test("absent while the mode is none: no fetch", async () => {
    let fetched = false;
    const result = await runDnsChecks(
      { ...domain, mtaStsMode: "none" },
      verificationDeps(() => {
        fetched = true;
        return Promise.reject(new Error("no"));
      }),
    );
    expect(result.mtaSts).toBeUndefined();
    expect(fetched).toBe(false);
  });

  test("skipMtaSts: no fetch, the stored outcome carried over (or none)", async () => {
    let fetched = false;
    const deps = verificationDeps(() => {
      fetched = true;
      return Promise.reject(new Error("no"));
    });
    const stored = { status: "pass" as const, reason: "stored" };
    const kept = await runDnsChecks(
      {
        ...domain,
        mtaStsMode: "enforce",
        lastCheckResult: {
          spf: stored,
          dkim: stored,
          dmarc: stored,
          mtaSts: stored,
          checkedAt: "2026-11-01T00:00:00.000Z",
        },
      },
      deps,
      { skipMtaSts: true },
    );
    expect(kept.mtaSts).toEqual(stored);
    const none = await runDnsChecks({ ...domain, mtaStsMode: "enforce" }, deps, {
      skipMtaSts: true,
    });
    expect(none.mtaSts).toBeUndefined();
    expect(fetched).toBe(false);
  });

  test("present for testing or enforce, next to the other checks", async () => {
    const result = await runDnsChecks(
      { ...domain, mtaStsMode: "testing", verifiedAt: null },
      verificationDeps(() => Promise.reject(new MtaStsFetchError("x"))),
    );
    expect(result.mtaSts?.status).toBe("fail");
    expect(result.spf.status).toBe("fail");
  });
});
