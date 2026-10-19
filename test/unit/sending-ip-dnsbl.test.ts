import { describe, test, expect, spyOn, afterEach } from "bun:test";
import {
  DNSBL_ZONES,
  checkAddress,
  checkSendingIpsDnsbl,
  classifyAnswers,
  classifyError,
  dnsblQueryName,
  logListingTransitions,
  reverseIpv4,
  reverseIpv6Nibbles,
  type DnsblDeps,
  type DnsblSnapshot,
  type DnsblZone,
  type ListingMemory,
  type ZoneResult,
} from "../../src/modules/domains/services/sending-ip-dnsbl.service.ts";
import { readSendingIpDnsblCheck } from "../../src/config.ts";
import { logger } from "../../src/utils/logger.ts";

/**
 * DNSBL self-check of the sending IPs (#250), with stubbed DNS: query
 * names, the answer table, which zones IPv6 goes to, and the transition
 * logging. The scheduled run reads `config` and is covered by the
 * integration tier.
 */

function zone(name: string): DnsblZone {
  const found = DNSBL_ZONES.find((z) => z.zone === name);
  if (!found) throw new Error(`no zone ${name}`);
  return found;
}

const ZEN = zone("zen.spamhaus.org");
const BARRACUDA = zone("b.barracudacentral.org");
const SPAMCOP = zone("bl.spamcop.net");

function dnsError(code: string): Error {
  return Object.assign(new Error(`${code} lookup`), { code });
}

/** Lookups answered from a table; any other name is NXDOMAIN. Records every query. */
function stubDeps(
  answers: Record<string, string[] | Error>,
  ips: string[] = [],
): { deps: DnsblDeps; queries: string[] } {
  const queries: string[] = [];
  const deps: DnsblDeps = {
    resolve4: async (name) => {
      queries.push(name);
      const hit = answers[name];
      if (hit instanceof Error) throw hit;
      if (hit) return hit;
      throw dnsError("ENOTFOUND");
    },
    sendingIps: async () => ({ ips, source: "MAIL_PUBLIC_IP" }),
    timeoutMs: 1_000,
  };
  return { deps, queries };
}

describe("query names", () => {
  test("IPv4: reversed octets", () => {
    expect(reverseIpv4("203.0.113.10")).toBe("10.113.0.203");
    expect(dnsblQueryName("203.0.113.10", ZEN)).toBe("10.113.0.203.zen.spamhaus.org");
    expect(dnsblQueryName("203.0.113.10", BARRACUDA)).toBe(
      "10.113.0.203.b.barracudacentral.org",
    );
    expect(dnsblQueryName("203.0.113.10", SPAMCOP)).toBe("10.113.0.203.bl.spamcop.net");
  });

  test("IPv6: 32 reversed nibbles, compressed or not", () => {
    const expected = "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2";
    expect(reverseIpv6Nibbles("2001:db8::1")).toBe(expected);
    expect(reverseIpv6Nibbles("2001:0DB8:0:0:0:0:0:0001")).toBe(expected);
    expect(reverseIpv6Nibbles("2a01:4f8:c17:abcd::12")).toBe(
      "2.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.d.c.b.a.7.1.c.0.8.f.4.0.1.0.a.2",
    );
    expect(reverseIpv6Nibbles("not-an-ip")).toBeNull();
  });

  test("IPv6 goes to Spamhaus ZEN only", () => {
    expect(dnsblQueryName("2001:db8::1", ZEN)).toBe(
      "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.zen.spamhaus.org",
    );
    expect(dnsblQueryName("2001:db8::1", BARRACUDA)).toBeNull();
    expect(dnsblQueryName("2001:db8::1", SPAMCOP)).toBeNull();
    /** The table says so too: only ZEN lists IPv6. */
    expect(DNSBL_ZONES.filter((z) => z.ipv6).map((z) => z.zone)).toEqual([
      "zen.spamhaus.org",
    ]);
  });

  test("an IPv4-mapped IPv6 address is queried as its IPv4, on every zone", () => {
    expect(dnsblQueryName("::ffff:203.0.113.10", BARRACUDA)).toBe(
      "10.113.0.203.b.barracudacentral.org",
    );
    expect(dnsblQueryName("::ffff:cb00:710a", ZEN)).toBe("10.113.0.203.zen.spamhaus.org");
  });

  test("not an IP: no query", () => {
    expect(dnsblQueryName("mail.example.com", ZEN)).toBeNull();
  });
});

describe("classifyAnswers: only 127.0.0.2 to 127.0.0.11 mean listed", () => {
  test.each([
    ["127.0.0.2", "SBL", false],
    ["127.0.0.3", "SBL CSS", false],
    ["127.0.0.4", "XBL", false],
    ["127.0.0.5", "XBL", false],
    ["127.0.0.6", "XBL", false],
    ["127.0.0.7", "XBL", false],
    ["127.0.0.8", "code 127.0.0.8", false],
    ["127.0.0.9", "DROP", false],
    ["127.0.0.10", "PBL", true],
    ["127.0.0.11", "PBL", true],
  ])("ZEN %s: listed, %s", (answer, meaning, policy) => {
    const result = classifyAnswers(ZEN, [answer]);
    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.codes).toHaveLength(1);
    expect(result.codes[0]?.code).toBe(answer);
    expect(result.codes[0]?.meaning).toContain(meaning);
    expect(result.codes[0]?.policy).toBe(policy);
  });

  test("several codes are all kept", () => {
    const result = classifyAnswers(ZEN, ["127.0.0.3", "127.0.0.11"]);
    expect(result.status === "listed" ? result.codes.map((c) => c.code) : []).toEqual([
      "127.0.0.3",
      "127.0.0.11",
    ]);
  });

  test("Barracuda and SpamCop codes are listed without a ZEN meaning", () => {
    for (const z of [BARRACUDA, SPAMCOP]) {
      const result = classifyAnswers(z, ["127.0.0.2"]);
      expect(result).toEqual({
        status: "listed",
        codes: [{ code: "127.0.0.2", meaning: "listed", policy: false }],
      });
    }
  });

  test.each(["127.255.255.254", "127.255.255.252", "127.255.255.255"])(
    "%s: the query was refused, unavailable (never listed)",
    (answer) => {
      expect(classifyAnswers(ZEN, [answer])).toEqual({
        status: "unavailable",
        code: answer,
      });
    },
  );

  test("a refusal wins over a listed code in the same answer", () => {
    expect(classifyAnswers(ZEN, ["127.0.0.2", "127.255.255.254"]).status).toBe(
      "unavailable",
    );
  });

  test.each([
    "127.0.0.1",
    "127.0.0.0",
    "127.0.0.12",
    "127.0.0.255",
    "127.0.1.2",
    "127.1.0.2",
    "127.0.0.20",
    "10.0.0.1",
    "203.0.113.5",
  ])("%s: never listed", (answer) => {
    const result = classifyAnswers(ZEN, [answer]);
    expect(result.status).not.toBe("listed");
    expect(result.status).not.toBe("not-listed");
    expect(result.status).toBe("unknown");
  });

  test("no A record in the answer: not listed", () => {
    expect(classifyAnswers(ZEN, [])).toEqual({ status: "not-listed" });
  });
});

describe("classifyError", () => {
  test.each(["ENOTFOUND", "ENODATA"])("%s (NXDOMAIN, no record): not listed", (code) => {
    expect(classifyError(dnsError(code))).toEqual({ status: "not-listed" });
  });

  test.each(["ESERVFAIL", "ETIMEOUT", "ECONNREFUSED", "EREFUSED"])(
    "%s: unknown, with the code",
    (code) => {
      const result = classifyError(dnsError(code));
      expect(result.status).toBe("unknown");
      expect(result.status === "unknown" ? result.reason : "").toContain(code);
    },
  );

  test("an error without a code: unknown", () => {
    expect(classifyError(new Error("boom")).status).toBe("unknown");
  });
});

describe("checkAddress", () => {
  test("IPv4 is queried on the three zones", async () => {
    const { deps, queries } = stubDeps({
      "10.113.0.203.zen.spamhaus.org": ["127.0.0.4"],
      "10.113.0.203.b.barracudacentral.org": ["127.255.255.254"],
      "10.113.0.203.bl.spamcop.net": dnsError("ESERVFAIL"),
    });
    const check = await checkAddress("203.0.113.10", deps);
    expect(queries.toSorted()).toEqual([
      "10.113.0.203.b.barracudacentral.org",
      "10.113.0.203.bl.spamcop.net",
      "10.113.0.203.zen.spamhaus.org",
    ]);
    expect(check.skipped).toBe(false);
    expect(check.zones.map((z) => [z.zone, z.result.status])).toEqual([
      ["zen.spamhaus.org", "listed"],
      ["b.barracudacentral.org", "unavailable"],
      ["bl.spamcop.net", "unknown"],
    ]);
  });

  test("IPv6 is queried on ZEN only, never on Barracuda or SpamCop", async () => {
    const { deps, queries } = stubDeps({});
    const check = await checkAddress("2001:db8::10", deps);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.endsWith(".zen.spamhaus.org")).toBe(true);
    expect(queries.some((q) => q.includes("barracuda") || q.includes("spamcop"))).toBe(
      false,
    );
    expect(check.zones).toEqual([
      expect.objectContaining({
        zone: "zen.spamhaus.org",
        result: { status: "not-listed" },
      }),
    ]);
  });

  test("a lookup that never answers times out: unknown", async () => {
    const deps: DnsblDeps = {
      resolve4: () => new Promise<string[]>(() => {}),
      sendingIps: async () => ({ ips: [], source: "MAIL_HOSTNAME" }),
      timeoutMs: 10,
    };
    const check = await checkAddress("203.0.113.10", deps);
    for (const z of check.zones) {
      expect(z.result.status).toBe("unknown");
      expect(z.result.status === "unknown" ? z.result.reason : "").toContain("ETIMEOUT");
    }
  });

  test.each(["10.0.0.5", "192.168.1.2", "127.0.0.1", "fd00::1", "::ffff:10.0.0.5"])(
    "%s is not publicly routable: skipped, no query",
    async (ip) => {
      const { deps, queries } = stubDeps({});
      expect(await checkAddress(ip, deps)).toEqual({ ip, skipped: true, zones: [] });
      expect(queries).toEqual([]);
    },
  );
});

describe("checkSendingIpsDnsbl", () => {
  test("checks every sending address, with the source and time", async () => {
    const at = new Date("2026-10-19T08:00:00.000Z");
    const { deps } = stubDeps({}, ["203.0.113.10", "2001:db8::10"]);
    const snapshot = await checkSendingIpsDnsbl(deps, () => at);
    expect(snapshot.source).toBe("MAIL_PUBLIC_IP");
    expect(snapshot.checkedAt).toBe(at);
    expect(snapshot.addresses.map((a) => [a.ip, a.zones.length])).toEqual([
      ["203.0.113.10", 3],
      ["2001:db8::10", 1],
    ]);
  });
});

describe("logListingTransitions: only on change", () => {
  let spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies = [];
  });

  function snapshotWith(result: ZoneResult): DnsblSnapshot {
    return {
      source: "MAIL_PUBLIC_IP",
      checkedAt: new Date(),
      addresses: [
        {
          ip: "203.0.113.10",
          skipped: false,
          zones: [
            {
              zone: ZEN.zone,
              name: ZEN.name,
              removalUrl: ZEN.removalUrl,
              result,
            },
          ],
        },
      ],
    };
  }

  const LISTED: ZoneResult = {
    status: "listed",
    codes: [{ code: "127.0.0.2", meaning: "SBL", policy: false }],
  };

  test("listed warns once, delisted informs once, unknown in between logs nothing", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const info = spyOn(logger, "info").mockImplementation(() => {});
    spies = [warn, info];
    const memory: ListingMemory = new Map();

    /** First run, not listed: nothing to say. */
    expect(logListingTransitions(snapshotWith({ status: "not-listed" }), memory)).toEqual(
      { listed: 0, delisted: 0 },
    );
    expect(warn).not.toHaveBeenCalled();

    /** Becomes listed: one warn. */
    expect(logListingTransitions(snapshotWith(LISTED), memory)).toEqual({
      listed: 1,
      delisted: 0,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ ip: "203.0.113.10", zone: "zen.spamhaus.org" }),
    );

    /** Still listed, then unknown, unavailable, listed again: no new line. */
    logListingTransitions(snapshotWith(LISTED), memory);
    logListingTransitions(snapshotWith({ status: "unknown", reason: "x" }), memory);
    logListingTransitions(
      snapshotWith({ status: "unavailable", code: "127.255.255.254" }),
      memory,
    );
    logListingTransitions(snapshotWith(LISTED), memory);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();

    /** Delisted: one info, then quiet. */
    expect(logListingTransitions(snapshotWith({ status: "not-listed" }), memory)).toEqual(
      { listed: 0, delisted: 1 },
    );
    logListingTransitions(snapshotWith({ status: "not-listed" }), memory);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toContain("delisted");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("listed on the first run warns", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    spies = [warn];
    logListingTransitions(snapshotWith(LISTED), new Map());
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("readSendingIpDnsblCheck", () => {
  test("unset or blank: on", () => {
    expect(readSendingIpDnsblCheck(undefined)).toBe(true);
    expect(readSendingIpDnsblCheck("")).toBe(true);
    expect(readSendingIpDnsblCheck("  ")).toBe(true);
  });

  test("true or false", () => {
    expect(readSendingIpDnsblCheck("true")).toBe(true);
    expect(readSendingIpDnsblCheck(" false ")).toBe(false);
  });

  test.each(["1", "0", "yes", "TRUE", "off"])("%p refuses to boot", (raw) => {
    expect(() => readSendingIpDnsblCheck(raw)).toThrow(
      'SENDING_IP_DNSBL_CHECK must be "true" or "false"',
    );
  });
});
