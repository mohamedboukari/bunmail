/**
 * DNSBL self-check of the sending IPs (#250), against the real `config`
 * and the real dashboard route, with stubbed DNS (no real lookup):
 *
 * - a run stores its result, logs one outcome line in its own log context
 *   and the home page shows it to admins, one state per zone, escaped;
 * - members never see the card; before the first run it says so;
 * - `SENDING_IP_DNSBL_CHECK=false` skips the loop and the run, and the
 *   card says the check is off.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Elysia } from "elysia";
import { seed, truncateAll } from "./_helpers.ts";
import { installHermeticDnsbl } from "./_dns-stub.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { withRequestContext } from "../../src/middleware/request-context.ts";
import { config } from "../../src/config.ts";
import { logger } from "../../src/utils/logger.ts";
import { getLogContext, type LogContext } from "../../src/utils/log-context.ts";
import {
  isRunning,
  resetDnsblState,
  runDnsblSelfCheck,
  setDnsblDeps,
  start,
  stop,
  type DnsblDeps,
} from "../../src/modules/domains/services/sending-ip-dnsbl.service.ts";

const dashboard = new Elysia().wrap(withRequestContext).use(pagesPlugin);

const HOSTILE_ANSWER = "<img src=x onerror=alert(1)>";

/** Answers per query name; anything else is NXDOMAIN. Records every query. */
function stubbed(ips: string[]): { deps: DnsblDeps; queries: string[] } {
  const queries: string[] = [];
  const answers: Record<string, string[]> = {
    "10.113.0.203.zen.spamhaus.org": ["127.0.0.2"],
    "10.113.0.203.b.barracudacentral.org": ["127.255.255.254"],
    "10.113.0.203.bl.spamcop.net": [HOSTILE_ANSWER],
  };
  return {
    queries,
    deps: {
      resolve4: async (name) => {
        queries.push(name);
        const hit = answers[name];
        if (hit) return hit;
        throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: "ENOTFOUND" });
      },
      sendingIps: async () => ({ ips, source: "MAIL_PUBLIC_IP" }),
      timeoutMs: 1_000,
    },
  };
}

const originalEnabled = config.sendingIpDnsbl.enabled;
let adminToken = "";
let memberToken = "";

beforeEach(async () => {
  await truncateAll();
  resetDnsblState();
  Object.assign(config.sendingIpDnsbl, { enabled: true });
  const { id: adminId } = await seed.user({ email: "admin@example.com", role: "admin" });
  adminToken = (await seed.session({ userId: adminId })).token;
  const { id: memberId } = await seed.user({
    email: "member@example.com",
    role: "member",
  });
  memberToken = (await seed.session({ userId: memberId })).token;
});

afterEach(() => {
  stop();
  resetDnsblState();
  installHermeticDnsbl();
  Object.assign(config.sendingIpDnsbl, { enabled: originalEnabled });
});

async function homeHtml(token: string): Promise<string> {
  const res = await dashboard.handle(
    new Request("http://localhost/dashboard", {
      headers: { cookie: `bm_session=${token}` },
    }),
  );
  expect(res.status).toBe(200);
  return await res.text();
}

describe("runDnsblSelfCheck (#250)", () => {
  test("stores the result and logs one outcome line in its own context", async () => {
    const lines: Array<{ message: string; context: LogContext | undefined }> = [];
    const info = spyOn(logger, "info").mockImplementation((message: string) => {
      lines.push({ message, context: getLogContext() });
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { deps, queries } = stubbed(["203.0.113.10", "2001:db8::10"]);
      const summary = await runDnsblSelfCheck(deps, new Map());
      expect(summary).toEqual(
        expect.objectContaining({
          addresses: 2,
          listed: 1,
          notListed: 1,
          unavailable: 1,
          unknown: 1,
          newlyListed: 1,
          delisted: 0,
        }),
      );
      /** IPv6 went to ZEN only. */
      expect(queries.filter((q) => !q.startsWith("10.113.0.203."))).toHaveLength(1);
      const outcome = lines.filter((l) => l.message === "DNSBL self-check completed");
      expect(outcome).toHaveLength(1);
      expect(outcome[0]?.context?.job).toBe("dnsbl-self-check");
      expect(String(outcome[0]?.context?.jobId)).toStartWith("dbl_");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  test("the hermetic default finds no sending IP and queries nothing real", async () => {
    const summary = await runDnsblSelfCheck();
    expect(summary?.addresses).toBe(0);
  });
});

describe("GET /dashboard: Blocklists card (#250)", () => {
  test("admins see each state, escaped, with the removal link", async () => {
    const { deps } = stubbed(["203.0.113.10", "2001:db8::10"]);
    setDnsblDeps(deps);
    await runDnsblSelfCheck();
    const html = await homeHtml(adminToken);
    expect(html).toContain("Blocklists");
    expect(html).toContain(">listed<");
    expect(html).toContain("SBL: a known spam source");
    expect(html).toContain("https://check.spamhaus.org/");
    expect(html).toContain(">unavailable<");
    expect(html).toContain("public resolvers");
    expect(html).toContain(">unknown<");
    expect(html).toContain(">not listed<");
    expect(html).toContain("2001:db8::10");
    expect(html).not.toContain(HOSTILE_ANSWER);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("not checked yet before the first run", async () => {
    expect(await homeHtml(adminToken)).toContain("Not checked yet");
  });

  test("members never see the card", async () => {
    const { deps } = stubbed(["203.0.113.10"]);
    await runDnsblSelfCheck(deps, new Map());
    expect(await homeHtml(memberToken)).not.toContain("Blocklists");
  });
});

describe("SENDING_IP_DNSBL_CHECK=false (#250)", () => {
  test("the loop does not start, a run does nothing, the card says it is off", async () => {
    Object.assign(config.sendingIpDnsbl, { enabled: false });
    start();
    expect(isRunning()).toBe(false);
    const { deps, queries } = stubbed(["203.0.113.10"]);
    expect(await runDnsblSelfCheck(deps, new Map())).toBeNull();
    expect(queries).toEqual([]);
    expect(await homeHtml(adminToken)).toContain("SENDING_IP_DNSBL_CHECK=false");
  });

  test("enabled, the loop starts and stops", () => {
    start();
    expect(isRunning()).toBe(true);
    stop();
    expect(isRunning()).toBe(false);
  });
});
