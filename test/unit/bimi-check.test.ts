import { describe, expect, test } from "bun:test";
import {
  checkBimi,
  lastBimiCheck,
  rememberBimiCheck,
} from "../../src/modules/domains/services/bimi-check.service.ts";
import type { BimiLogoDeps } from "../../src/modules/domains/services/bimi-logo.ts";
import { BimiPanel } from "../../src/pages/routes/domain-detail-bimi.tsx";

/**
 * The BIMI readiness check (#415): record, DMARC prerequisite, logo and
 * certificate together, the verdict, the in-memory last result, and the
 * domain page's BIMI section, which must escape everything that comes from
 * DNS or the logo.
 */

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 10 10"><title>Acme</title></svg>`;

/** A TXT lookup answering from `answers`, NXDOMAIN otherwise. */
function txt(answers: Record<string, string>) {
  return (name: string): Promise<string[][]> => {
    const answer = answers[name];
    if (answer !== undefined) return Promise.resolve([[answer]]);
    return Promise.reject(Object.assign(new Error("nx"), { code: "ENOTFOUND" }));
  };
}

/** A logo fetch serving `body` from a public address; counts its requests. */
function logo(body: string, status = 200): { deps: BimiLogoDeps; fetches: () => number } {
  let fetches = 0;
  return {
    fetches: () => fetches,
    deps: {
      fetch: () => {
        fetches++;
        return Promise.resolve(
          new Response(body, { status, headers: { "content-type": "image/svg+xml" } }),
        );
      },
      resolver: () => Promise.resolve([{ address: "93.184.216.34" }]),
      timeoutMs: 1_000,
    },
  };
}

const READY = {
  "default._bimi.acme.io":
    "v=BIMI1; l=https://acme.io/logo.svg; a=https://acme.io/vmc.pem",
  "_dmarc.acme.io": "v=DMARC1; p=reject; rua=mailto:d@acme.io",
};

const now = () => new Date("2026-11-15T00:00:00Z");

describe("checkBimi", () => {
  test("ready: record, DMARC, logo and certificate all pass", async () => {
    const served = logo(LOGO);
    const check = await checkBimi("acme.io", {
      resolveTxt: txt(READY),
      logo: served.deps,
      now,
    });
    expect(check.status).toBe("ready");
    expect(check.checkedAt).toBe("2026-11-15T00:00:00.000Z");
    expect(check.findings.filter((f) => f.severity === "fail")).toEqual([]);
    expect(check.findings.map((f) => f.area)).toEqual([
      "record",
      "record",
      "dmarc",
      "dmarc",
      "logo",
      "certificate",
      "certificate",
    ]);
    expect(served.fetches()).toBe(1);
  });

  test("ready without a= warns that Gmail and Apple need a certificate", async () => {
    const check = await checkBimi("acme.io", {
      resolveTxt: txt({
        ...READY,
        "default._bimi.acme.io": "v=BIMI1; l=https://acme.io/l.svg",
      }),
      logo: logo(LOGO).deps,
    });
    expect(check.status).toBe("ready");
    expect(check.summary).toContain("VMC or CMC");
    expect(
      check.findings.find((f) => f.area === "certificate" && f.severity === "warn"),
    ).toBeDefined();
  });

  test("a DMARC policy that does not enforce: not ready, the logo still checked", async () => {
    const served = logo(LOGO);
    const check = await checkBimi("acme.io", {
      resolveTxt: txt({ ...READY, "_dmarc.acme.io": "v=DMARC1; p=none" }),
      logo: served.deps,
    });
    expect(check.status).toBe("not-ready");
    expect(served.fetches()).toBe(1);
  });

  test("a logo that breaks a rule: not ready", async () => {
    const check = await checkBimi("acme.io", {
      resolveTxt: txt(READY),
      logo: logo(LOGO.replace("<title>Acme</title>", "<script/>")).deps,
    });
    expect(check.status).toBe("not-ready");
    expect(check.findings.filter((f) => f.area === "logo").map((f) => f.text)).toEqual([
      "No <title> in the root <svg>: add one with the brand name",
      "The logo contains a <script> element",
    ]);
  });

  test("a temporary logo failure, with nothing else failing, is error", async () => {
    const check = await checkBimi("acme.io", {
      resolveTxt: txt(READY),
      logo: logo("", 503).deps,
    });
    expect(check.status).toBe("error");
  });

  test("no record, a declined one or an invalid one: no logo fetch", async () => {
    for (const [record, status] of [
      [undefined, "missing"],
      ["v=BIMI1; l=;", "declined"],
      ["v=BIMI1; l=http://acme.io/l.svg", "not-ready"],
    ] as const) {
      const served = logo(LOGO);
      const answers: Record<string, string> = {
        "_dmarc.acme.io": READY["_dmarc.acme.io"],
      };
      if (record !== undefined) answers["default._bimi.acme.io"] = record;
      const check = await checkBimi("acme.io", {
        resolveTxt: txt(answers),
        logo: served.deps,
      });
      expect(check.status).toBe(status);
      expect(served.fetches()).toBe(0);
    }
  });

  test("a failed record lookup is error", async () => {
    const check = await checkBimi("acme.io", {
      resolveTxt: () =>
        Promise.reject(Object.assign(new Error("dns"), { code: "ESERVFAIL" })),
      logo: logo(LOGO).deps,
    });
    expect(check.status).toBe("error");
  });
});

describe("the last check per domain", () => {
  test("kept for 30 minutes, then gone", async () => {
    const check = await checkBimi("acme.io", {
      resolveTxt: txt({}),
      logo: logo(LOGO).deps,
    });
    rememberBimiCheck("dom_ttl", check, 1_000);
    expect(lastBimiCheck("dom_ttl", 1_000 + 29 * 60_000)).toBe(check);
    expect(lastBimiCheck("dom_ttl", 1_000 + 30 * 60_000)).toBeNull();
    expect(lastBimiCheck("dom_ttl", 1_000)).toBeNull();
    expect(lastBimiCheck("dom_never")).toBeNull();
  });
});

describe("BimiPanel", () => {
  const XSS = "<img src=x onerror=alert(1)>";

  test("without a check: the explanation, the record to publish and the button", async () => {
    const html = await BimiPanel({
      domain: { id: "dom_1", name: "acme.io" },
      check: null,
    });
    expect(html).toContain("BIMI");
    expect(html).toContain("default._bimi.acme.io");
    expect(html).toContain("v=BIMI1; l=https://acme.io/bimi/logo.svg");
    expect(html).toContain('action="/dashboard/domains/dom_1/bimi"');
    expect(html).toContain("Not checked in the last 30 minutes.");
  });

  test("hostile DNS and logo content renders escaped, the logo never", async () => {
    const check = await checkBimi("acme.io", {
      resolveTxt: txt({
        ...READY,
        "default._bimi.acme.io": `v=BIMI1; l=https://acme.io/${XSS}`,
      }),
      logo: logo(
        LOGO.replace('version="1.2"', `version="${XSS.replace(/"/g, "")}"`).replace(
          "<title>Acme</title>",
          "<title>Acme</title><script>alert(1)</script>",
        ),
      ).deps,
    });
    const html = await BimiPanel({ domain: { id: "dom_1", name: "acme.io" }, check });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<svg");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt; element");
  });
});
