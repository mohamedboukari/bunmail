import { describe, test, expect, afterEach } from "bun:test";
import { config } from "../../src/config.ts";
import {
  clearMxCache,
  mxPointsHere,
  resolveMxStatus,
  type MxCheckDeps,
} from "../../src/modules/bounces/services/return-path-mx.ts";
import {
  DNS_STATUS_CONCURRENCY,
  getDomainDnsStatus,
  getDomainsDnsStatus,
  mailFlowFeatures,
  rememberDmarcCheck,
  setDomainDnsDeps,
} from "../../src/modules/domains/services/domain-dns-status.service.ts";

/**
 * The informational MX status per domain and the live DNS status of the
 * domain page and API (#250), with stubbed DNS.
 */

const HOST = "mail.bunmail.test";

/** An MX resolver answering `answer` for every domain. */
function mx(
  answer: Array<{ exchange: string }> | { code: string } | "hang",
): MxCheckDeps {
  return {
    now: () => Date.now(),
    timeoutMs: 50,
    resolveMx: () => {
      if (answer === "hang") return new Promise(() => {});
      if (!Array.isArray(answer)) {
        return Promise.reject(
          Object.assign(new Error(answer.code), { code: answer.code }),
        );
      }
      return Promise.resolve(answer);
    },
  };
}

afterEach(() => {
  setDomainDnsDeps(null);
  clearMxCache();
});

describe("resolveMxStatus: the four states", () => {
  test("here: the MX set names MAIL_HOSTNAME (case and trailing dot ignored)", async () => {
    clearMxCache();
    expect(
      await resolveMxStatus(
        "acme.io",
        HOST,
        mx([{ exchange: "backup.example.net." }, { exchange: "MAIL.bunmail.test." }]),
      ),
    ).toEqual({ status: "here", hosts: ["backup.example.net", HOST] });
  });

  test("elsewhere: only other hosts", async () => {
    clearMxCache();
    expect(
      await resolveMxStatus("acme.io", HOST, mx([{ exchange: "aspmx.l.google.com" }])),
    ).toEqual({ status: "elsewhere", hosts: ["aspmx.l.google.com"] });
  });

  test("none: NXDOMAIN, NODATA, no records or a null MX", async () => {
    for (const answer of [
      { code: "ENOTFOUND" },
      { code: "ENODATA" },
      [],
      [{ exchange: "" }],
      [{ exchange: "." }],
    ]) {
      clearMxCache();
      expect(await resolveMxStatus("acme.io", HOST, mx(answer))).toEqual({
        status: "none",
        hosts: [],
      });
    }
  });

  test("error: a failed or timed out lookup", async () => {
    for (const answer of [{ code: "ESERVFAIL" }, { code: "ETIMEOUT" }, "hang" as const]) {
      clearMxCache();
      expect(await resolveMxStatus("acme.io", HOST, mx(answer))).toEqual({
        status: "error",
        hosts: [],
      });
    }
  });

  test("the return-path decision reads the same cached answer", async () => {
    clearMxCache();
    await resolveMxStatus("acme.io", HOST, mx([{ exchange: HOST }]));
    /** A resolver that would say "elsewhere" is not consulted. */
    expect(await mxPointsHere("acme.io", HOST, mx([{ exchange: "other.example" }]))).toBe(
      true,
    );
  });
});

describe("getDomainDnsStatus", () => {
  test("combines the DMARC check and the MX status, never rejecting", async () => {
    setDomainDnsDeps({
      resolveTxt: (name) =>
        name === "_dmarc.acme.io"
          ? Promise.resolve([["v=DMARC1; p=quarantine"]])
          : Promise.reject(Object.assign(new Error("x"), { code: "ENOTFOUND" })),
      resolveMx: () => Promise.resolve([{ exchange: config.mail.hostname }]),
    });
    const status = await getDomainDnsStatus("ACME.io");
    expect(status.dmarc).toMatchObject({ status: "pass", policy: "quarantine" });
    expect(status.mx.status).toBe("here");
  });

  test("DNS failures give error statuses, not exceptions", async () => {
    const fail = (): Promise<never> =>
      Promise.reject(Object.assign(new Error("x"), { code: "ESERVFAIL" }));
    setDomainDnsDeps({ resolveTxt: fail, resolveMx: fail });
    const status = await getDomainDnsStatus("acme.io");
    expect(status.dmarc.status).toBe("error");
    expect(status.mx.status).toBe("error");
  });

  test("DMARC checks are cached, and a verification replaces the cached one", async () => {
    let lookups = 0;
    setDomainDnsDeps({
      resolveTxt: () => {
        lookups++;
        return Promise.resolve([["v=DMARC1; p=none"]]);
      },
      resolveMx: () => Promise.resolve([]),
    });
    await getDomainDnsStatus("acme.io");
    await getDomainDnsStatus("acme.io");
    expect(lookups).toBe(1);

    const fresh = (await getDomainDnsStatus("acme.io")).dmarc;
    rememberDmarcCheck("acme.io", {
      ...fresh,
      policy: "reject",
      effectivePolicy: "reject",
    });
    expect((await getDomainDnsStatus("acme.io")).dmarc.policy).toBe("reject");
    expect(lookups).toBe(1);
  });
});

describe("mailFlowFeatures", () => {
  const here = { status: "here" as const, hosts: [HOST] };

  test("all four flows are active with SMTP on and the MX here", () => {
    const features = mailFlowFeatures(here, true);
    expect(features.map((f) => f.name)).toEqual([
      "Signed return paths",
      "Async bounces",
      "DMARC reports",
      "Inbound mail",
    ]);
    expect(features.every((f) => f.active)).toBe(true);
  });

  test("SMTP off turns every flow off, whatever the MX", () => {
    const features = mailFlowFeatures(here, false);
    expect(features.some((f) => f.active)).toBe(false);
    expect(features[0]?.explanation).toContain("SMTP_ENABLED=false");
  });

  test("each other MX state explains itself", () => {
    expect(
      mailFlowFeatures({ status: "elsewhere", hosts: ["aspmx.l.google.com"] }, true)[0]
        ?.explanation,
    ).toContain("aspmx.l.google.com");
    expect(
      mailFlowFeatures({ status: "none", hosts: [] }, true)[1]?.explanation,
    ).toContain("no MX record");
    expect(
      mailFlowFeatures({ status: "error", hosts: [] }, true)[2]?.explanation,
    ).toContain("lookup failed");
    for (const status of ["elsewhere", "none", "error"] as const) {
      expect(mailFlowFeatures({ status, hosts: [] }, true).some((f) => f.active)).toBe(
        false,
      );
    }
  });
});

describe("getDomainsDnsStatus: bounded lookups", () => {
  test("at most 8 domains are looked up at once, results in order", async () => {
    let inFlight = 0;
    let peak = 0;
    /** Each domain's one TXT lookup holds its slot for a tick, so concurrency is visible. */
    setDomainDnsDeps({
      resolveTxt: async (name) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return [[`v=DMARC1; p=reject; rua=mailto:d@${name.slice("_dmarc.".length)}`]];
      },
      resolveMx: () => Promise.resolve([]),
    });
    const names = Array.from({ length: 50 }, (_, i) => `d${i}.io`);
    const statuses = await getDomainsDnsStatus(names);

    expect(statuses).toHaveLength(50);
    expect(statuses.map((s) => s.dmarc.recordDomain)).toEqual(names);
    expect(DNS_STATUS_CONCURRENCY).toBe(8);
    expect(peak).toBe(8);
  });

  test("an empty list looks nothing up", async () => {
    expect(await getDomainsDnsStatus([])).toEqual([]);
  });
});
