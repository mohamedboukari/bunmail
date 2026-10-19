import { describe, test, expect } from "bun:test";
import {
  MAX_ADDRESSES_PER_HOST,
  MAX_MX_HOSTS_PER_ATTEMPT,
  deliverWithFailover,
  failsOver,
  orderMxHosts,
  resolveMxRoute,
  type MxRouteDeps,
  type SessionRunner,
} from "../../src/modules/emails/services/mx-route.ts";
import type { MxSessionOutcome } from "../../src/modules/emails/services/mx-transport.ts";

/**
 * MX resolution and failover (#250). Pure: every DNS lookup and the SMTP
 * session are injected stubs, so no network and no `mock.module`.
 */

/** A DNS error with its `code`, as `dns/promises` rejects. */
function dnsError(code: string): Error {
  return Object.assign(new Error(`query ${code}`), { code });
}

/** Deps whose every lookup fails as "no records", overridden per test. */
function stubDeps(overrides: Partial<MxRouteDeps> = {}): MxRouteDeps {
  return {
    resolveMx: () => Promise.reject(dnsError("ENOTFOUND")),
    resolve4: () => Promise.reject(dnsError("ENOTFOUND")),
    resolve6: () => Promise.reject(dnsError("ENOTFOUND")),
    lookup: async () => [{ address: "203.0.113.10" }],
    random: () => 0.5,
    smtpPort: () => 25,
    timeoutMs: 1_000,
    ...overrides,
  };
}

describe("resolveMxRoute", () => {
  test("MX hosts come back by preference, names normalized", async () => {
    const route = await resolveMxRoute(
      "example.org",
      stubDeps({
        resolveMx: async () => [
          { exchange: "MX2.example.org.", priority: 20 },
          { exchange: "mx1.example.org", priority: 10 },
        ],
      }),
    );
    expect(route).toEqual({
      kind: "hosts",
      hosts: ["mx1.example.org", "mx2.example.org"],
      implicit: false,
    });
  });

  test("NXDOMAIN fails: the domain does not exist", async () => {
    expect(await resolveMxRoute("nowhere.example", stubDeps())).toEqual({
      kind: "failed",
      error: "nowhere.example: domain does not exist",
    });
  });

  test.each([
    ["RFC 7505 null MX", [{ exchange: ".", priority: 0 }]],
    ["empty exchange", [{ exchange: "", priority: 0 }]],
    [
      "a null MX next to a real one",
      [
        { exchange: "mx.example.org", priority: 10 },
        { exchange: "", priority: 0 },
      ],
    ],
  ])("%s fails: the domain accepts no mail", async (_label, records) => {
    expect(
      await resolveMxRoute("example.org", stubDeps({ resolveMx: async () => records })),
    ).toEqual({
      kind: "failed",
      error: "example.org: domain does not accept mail (null MX)",
    });
  });

  test.each(["ENODATA", "ENOTFOUND"])(
    "no MX records (%s) with an A record: the implicit MX, the domain itself",
    async (code) => {
      /** Bun says ENOTFOUND for a name without MX records, Node ENODATA. */
      const route = await resolveMxRoute(
        "Example.org",
        stubDeps({
          resolveMx: () => Promise.reject(dnsError(code)),
          resolve4: async () => ["203.0.113.10"],
        }),
      );
      expect(route).toEqual({ kind: "hosts", hosts: ["example.org"], implicit: true });
    },
  );

  test("an empty MX answer with only an AAAA record is an implicit MX too", async () => {
    const route = await resolveMxRoute(
      "example.org",
      stubDeps({ resolveMx: async () => [], resolve6: async () => ["2001:db8::25"] }),
    );
    expect(route).toEqual({ kind: "hosts", hosts: ["example.org"], implicit: true });
  });

  test("no MX and no address records fails", async () => {
    const route = await resolveMxRoute(
      "example.org",
      stubDeps({
        resolveMx: () => Promise.reject(dnsError("ENODATA")),
        resolve4: () => Promise.reject(dnsError("ENODATA")),
        resolve6: async () => [],
      }),
    );
    expect(route).toEqual({
      kind: "failed",
      error: "example.org: domain has no MX or address records",
    });
  });

  test.each(["ESERVFAIL", "ETIMEOUT", "ECONNREFUSED", "EAI_AGAIN", "EREFUSED"])(
    "%s on the MX lookup is temporary: retry",
    async (code) => {
      const route = await resolveMxRoute(
        "example.org",
        stubDeps({ resolveMx: () => Promise.reject(dnsError(code)) }),
      );
      expect(route).toEqual({
        kind: "retry",
        error: `example.org: MX lookup failed temporarily (${code}); will retry`,
      });
    },
  );

  test("an error without a code is temporary too", async () => {
    const route = await resolveMxRoute(
      "example.org",
      stubDeps({ resolveMx: () => Promise.reject(new Error("boom")) }),
    );
    expect(route.kind).toBe("retry");
  });

  test("a temporary failure of the address lookup behind an implicit MX: retry", async () => {
    const route = await resolveMxRoute(
      "example.org",
      stubDeps({
        resolveMx: () => Promise.reject(dnsError("ENODATA")),
        resolve4: () => Promise.reject(dnsError("ESERVFAIL")),
      }),
    );
    expect(route).toEqual({
      kind: "retry",
      error: "example.org: address lookup failed temporarily (ESERVFAIL); will retry",
    });
  });

  test("a lookup that never answers times out as ETIMEOUT: retry", async () => {
    const route = await resolveMxRoute(
      "example.org",
      stubDeps({ resolveMx: () => new Promise(() => {}), timeoutMs: 20 }),
    );
    expect(route).toEqual({
      kind: "retry",
      error: "example.org: MX lookup failed temporarily (ETIMEOUT); will retry",
    });
  });
});

describe("orderMxHosts", () => {
  const records = [
    { exchange: "c.example.org", priority: 10 },
    { exchange: "backup.example.org", priority: 20 },
    { exchange: "a.example.org", priority: 10 },
    { exchange: "b.example.org", priority: 10 },
  ];

  /** A random source returning `values` in turn. */
  function sequence(...values: number[]): () => number {
    let i = 0;
    return () => values[i++ % values.length] ?? 0;
  }

  test("lower preference first; ties ordered by the random source", () => {
    /** One draw per record, in record order: c, backup, a, b. */
    expect(orderMxHosts(records, sequence(0.9, 0.1, 0.5, 0.2))).toEqual([
      "b.example.org",
      "a.example.org",
      "c.example.org",
      "backup.example.org",
    ]);
    expect(orderMxHosts(records, sequence(0.1, 0.9, 0.2, 0.5))).toEqual([
      "c.example.org",
      "a.example.org",
      "b.example.org",
      "backup.example.org",
    ]);
  });

  test("ties really are shuffled: every order of three tied hosts shows up", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      seen.add(orderMxHosts(records, Math.random).slice(0, 3).join(","));
    }
    expect(seen.size).toBe(6);
  });

  test("a host listed twice is tried once", () => {
    expect(
      orderMxHosts(
        [
          { exchange: "mx.example.org", priority: 10 },
          { exchange: "MX.example.org.", priority: 20 },
        ],
        () => 0,
      ),
    ).toEqual(["mx.example.org"]);
  });
});

describe("failsOver", () => {
  test("a connection-level failure (no SMTP reply) fails over", () => {
    expect(failsOver(new Error("connect ECONNREFUSED 203.0.113.10:25"))).toBe(true);
    expect(failsOver(new Error("SMTP session exceeded 1200 s and was closed"))).toBe(
      true,
    );
    expect(failsOver(new Error("STARTTLS handshake did not complete within 60 s"))).toBe(
      true,
    );
  });

  test("a 421 fails over; any other reply does not", () => {
    const reply = (code: number, text: string) =>
      Object.assign(new Error(`failed: ${text}`), { responseCode: code, response: text });
    expect(failsOver(reply(421, "421 4.3.2 Service shutting down"))).toBe(true);
    expect(failsOver(new Error("421 too busy"))).toBe(true);
    expect(failsOver(reply(450, "450 4.2.1 mailbox busy"))).toBe(false);
    expect(failsOver(reply(550, "550 5.1.1 user unknown"))).toBe(false);
    expect(failsOver(new Error("550 5.1.1 user unknown"))).toBe(false);
  });
});

/** One transaction, keyed `key`. */
function transaction(key: string) {
  return { key, mail: { from: "a@example.com", to: "b@example.org" } };
}

/** A lock that just runs `fn`, counting the hosts it was taken for. */
function recordingLock(taken: string[]) {
  return <T>(mxHost: string, fn: () => Promise<T>): Promise<T> => {
    taken.push(mxHost);
    return fn();
  };
}

describe("deliverWithFailover", () => {
  test("a refused connection on the first host: the second one delivers", async () => {
    const calls: string[] = [];
    const runSession: SessionRunner = async ({ address, mxHost, transactions }) => {
      calls.push(`${mxHost}@${address}`);
      return transactions.map((t) =>
        mxHost === "mx1.example.org"
          ? { key: t.key, error: new Error("connect ECONNREFUSED"), tls: null }
          : { key: t.key, tls: "starttls" },
      );
    };
    const taken: string[] = [];
    const outcomes = await deliverWithFailover({
      domain: "example.org",
      hosts: ["mx1.example.org", "mx2.example.org"],
      transactions: [transaction("example.org")],
      allowPrivate: false,
      runSession,
      lock: recordingLock(taken),
      routeDeps: stubDeps({ lookup: async () => [{ address: "203.0.113.10" }] }),
    });
    expect(outcomes).toEqual([
      { key: "example.org", tls: "starttls", mxHost: "mx2.example.org" },
    ]);
    expect(calls).toEqual([
      "mx1.example.org@203.0.113.10",
      "mx2.example.org@203.0.113.10",
    ]);
    /** The lock is taken per host, never across hosts. */
    expect(taken).toEqual(["mx1.example.org", "mx2.example.org"]);
  });

  test("a 550 from the first host decides the attempt: no failover", async () => {
    const calls: string[] = [];
    const rejection = Object.assign(new Error("Recipient command failed"), {
      responseCode: 550,
      response: "550 5.1.1 user unknown",
    });
    const outcomes = await deliverWithFailover({
      domain: "example.org",
      hosts: ["mx1.example.org", "mx2.example.org"],
      transactions: [transaction("example.org")],
      allowPrivate: false,
      runSession: async ({ mxHost, transactions }) => {
        calls.push(mxHost);
        return transactions.map((t) => ({ key: t.key, error: rejection, tls: null }));
      },
      lock: recordingLock([]),
      routeDeps: stubDeps(),
    });
    expect(calls).toEqual(["mx1.example.org"]);
    expect(outcomes[0]?.error).toBe(rejection);
    expect(outcomes[0]?.mxHost).toBe("mx1.example.org");
  });

  test("only the transactions that failed at connection level move on", async () => {
    const sessions: string[][] = [];
    const outcomes = await deliverWithFailover({
      domain: "example.org",
      hosts: ["mx1.example.org", "mx2.example.org"],
      transactions: [transaction("t0"), transaction("t1")],
      allowPrivate: false,
      runSession: async ({ mxHost, transactions }) => {
        sessions.push(transactions.map((t) => t.key));
        return transactions.map((t): MxSessionOutcome =>
          mxHost === "mx1.example.org" && t.key === "t1"
            ? { key: t.key, error: new Error("Connection closed"), tls: null }
            : { key: t.key, tls: "plaintext" },
        );
      },
      lock: recordingLock([]),
      routeDeps: stubDeps(),
    });
    expect(sessions).toEqual([["t0", "t1"], ["t1"]]);
    expect(outcomes.map((o) => [o.key, o.mxHost, o.error])).toEqual([
      ["t0", "mx1.example.org", undefined],
      ["t1", "mx2.example.org", undefined],
    ]);
  });

  test(`at most ${MAX_MX_HOSTS_PER_ATTEMPT} hosts and ${MAX_ADDRESSES_PER_HOST} addresses each, then the last failure`, async () => {
    const calls: string[] = [];
    const hosts = Array.from({ length: 7 }, (_, i) => `mx${i}.example.org`);
    const outcomes = await deliverWithFailover({
      domain: "example.org",
      hosts,
      transactions: [transaction("example.org")],
      allowPrivate: false,
      runSession: async ({ mxHost, address, transactions }) => {
        calls.push(`${mxHost}@${address}`);
        return transactions.map((t) => ({
          key: t.key,
          error: new Error(`connect ETIMEDOUT ${address}`),
          tls: null,
        }));
      },
      lock: recordingLock([]),
      routeDeps: stubDeps({
        lookup: async () => [
          { address: "203.0.113.1" },
          { address: "203.0.113.2" },
          { address: "203.0.113.3" },
        ],
      }),
    });
    expect(calls).toHaveLength(MAX_MX_HOSTS_PER_ATTEMPT * MAX_ADDRESSES_PER_HOST);
    expect(calls.slice(0, 3)).toEqual([
      "mx0.example.org@203.0.113.1",
      "mx0.example.org@203.0.113.2",
      "mx1.example.org@203.0.113.1",
    ]);
    expect(calls.some((c) => c.startsWith("mx5."))).toBe(false);
    expect(String(outcomes[0]?.error)).toContain("203.0.113.2");
    expect(outcomes[0]?.mxHost).toBe("mx4.example.org");
  });

  test("an implicit MX on a private address is refused, never connected to", async () => {
    let connected = false;
    const outcomes = await deliverWithFailover({
      domain: "example.org",
      hosts: ["example.org"],
      transactions: [transaction("example.org")],
      allowPrivate: false,
      runSession: async ({ transactions }) => {
        connected = true;
        return transactions.map((t) => ({ key: t.key, tls: null }));
      },
      lock: recordingLock([]),
      routeDeps: stubDeps({ lookup: async () => [{ address: "10.0.0.5" }] }),
    });
    expect(connected).toBe(false);
    expect(outcomes[0]?.mxHost).toBeNull();
    expect(String(outcomes[0]?.error)).toContain("non-public address");
  });

  test("a refused host is skipped and the next one used", async () => {
    const calls: string[] = [];
    const outcomes = await deliverWithFailover({
      domain: "example.org",
      hosts: ["internal.example.org", "mx.example.org"],
      transactions: [transaction("example.org")],
      allowPrivate: false,
      runSession: async ({ mxHost, transactions }) => {
        calls.push(mxHost);
        return transactions.map((t) => ({ key: t.key, tls: "starttls" }));
      },
      lock: recordingLock([]),
      routeDeps: stubDeps({
        lookup: async (host) => [
          { address: host === "internal.example.org" ? "127.0.0.1" : "203.0.113.10" },
        ],
      }),
    });
    expect(calls).toEqual(["mx.example.org"]);
    expect(outcomes[0]?.mxHost).toBe("mx.example.org");
  });

  test("one deadline for the whole attempt: no new session once it is spent", async () => {
    const calls: string[] = [];
    const outcomes = await deliverWithFailover({
      domain: "example.org",
      hosts: ["mx1.example.org", "mx2.example.org"],
      transactions: [transaction("example.org")],
      allowPrivate: false,
      deadlineMs: 30,
      runSession: async ({ mxHost, transactions, deadlineMs }) => {
        calls.push(mxHost);
        expect(deadlineMs).toBeLessThanOrEqual(30);
        await Bun.sleep(40);
        return transactions.map((t) => ({
          key: t.key,
          error: new Error("SMTP session exceeded 0 s and was closed"),
          tls: null,
        }));
      },
      lock: recordingLock([]),
      routeDeps: stubDeps(),
    });
    expect(calls).toEqual(["mx1.example.org"]);
    expect(outcomes[0]?.error).toBeInstanceOf(Error);
  });
});

/** Provider buckets and the rate budget in failover (#250). */
describe("deliverWithFailover: buckets and rate budget", () => {
  /** A budget stub granting `available` tokens per bucket in total, then none. */
  function stubBudget(available: Record<string, number>, waitMs = 60_000) {
    const asked: Array<[string, number]> = [];
    const admit = (bucket: string, count: number) => {
      asked.push([bucket, count]);
      const left = available[bucket] ?? 0;
      const granted = Math.min(left, count);
      available[bucket] = left - granted;
      return { granted, waitMs: granted < count ? waitMs : 0 };
    };
    return { admit, asked };
  }

  test("the lock is keyed by the host's bucket", async () => {
    const taken: string[] = [];
    await deliverWithFailover({
      domain: "example.org",
      hosts: ["mx1.example.org", "mx2.example.org"],
      transactions: [transaction("example.org")],
      allowPrivate: false,
      runSession: async ({ mxHost, transactions }) =>
        transactions.map((t) =>
          mxHost === "mx1.example.org"
            ? { key: t.key, error: new Error("connect ECONNREFUSED"), tls: null }
            : { key: t.key, tls: "starttls" },
        ),
      lock: recordingLock(taken),
      bucketOf: () => "example.org",
      routeDeps: stubDeps(),
    });
    expect(taken).toEqual(["example.org", "example.org"]);
  });

  test("transactions without a token are deferred, not attempted, and do not fail over", async () => {
    const sessions: string[][] = [];
    const { admit } = stubBudget({ google: 1 }, 42_000);
    const outcomes = await deliverWithFailover({
      domain: "example.org",
      hosts: ["mx1.example.org", "mx2.example.org"],
      transactions: [transaction("t0"), transaction("t1"), transaction("t2")],
      allowPrivate: false,
      runSession: async ({ transactions }) => {
        sessions.push(transactions.map((t) => t.key));
        return transactions.map((t) => ({ key: t.key, tls: "starttls" }));
      },
      lock: recordingLock([]),
      bucketOf: () => "google",
      admit,
      routeDeps: stubDeps(),
    });
    expect(sessions).toEqual([["t0"]]);
    expect(outcomes).toEqual([
      { key: "t0", tls: "starttls", mxHost: "mx1.example.org" },
      { key: "t1", tls: null, mxHost: "mx1.example.org", deferredMs: 42_000 },
      { key: "t2", tls: null, mxHost: "mx1.example.org", deferredMs: 42_000 },
    ]);
  });

  test("no budget left at all: no session is opened", async () => {
    let connected = false;
    const outcomes = await deliverWithFailover({
      domain: "example.org",
      hosts: ["mx1.example.org"],
      transactions: [transaction("example.org")],
      allowPrivate: false,
      runSession: async ({ transactions }) => {
        connected = true;
        return transactions.map((t) => ({ key: t.key, tls: null }));
      },
      lock: recordingLock([]),
      admit: stubBudget({}).admit,
      routeDeps: stubDeps(),
    });
    expect(connected).toBe(false);
    expect(outcomes[0]?.deferredMs).toBe(60_000);
    expect(outcomes[0]?.error).toBeUndefined();
  });

  test("failover within one bucket charges each transaction once", async () => {
    const { admit, asked } = stubBudget({ "example.org": 1 });
    const outcomes = await deliverWithFailover({
      domain: "example.org",
      hosts: ["mx1.example.org", "mx2.example.org"],
      transactions: [transaction("example.org")],
      allowPrivate: false,
      runSession: async ({ mxHost, transactions }) =>
        transactions.map((t) =>
          mxHost === "mx1.example.org"
            ? { key: t.key, error: new Error("connect ECONNREFUSED"), tls: null }
            : { key: t.key, tls: "starttls" },
        ),
      lock: recordingLock([]),
      bucketOf: () => "example.org",
      admit,
      routeDeps: stubDeps(),
    });
    expect(asked).toEqual([["example.org", 1]]);
    expect(outcomes[0]).toEqual({
      key: "example.org",
      tls: "starttls",
      mxHost: "mx2.example.org",
    });
  });

  test("failover into another bucket takes a token there", async () => {
    const { admit, asked } = stubBudget({ "example.org": 1 });
    const outcomes = await deliverWithFailover({
      domain: "example.org",
      hosts: ["mx1.example.org", "backup.example.net"],
      transactions: [transaction("example.org")],
      allowPrivate: false,
      runSession: async ({ transactions }) =>
        transactions.map((t) => ({
          key: t.key,
          error: new Error("connect ECONNREFUSED"),
          tls: null,
        })),
      lock: recordingLock([]),
      bucketOf: (host) => (host.endsWith("example.net") ? "example.net" : "example.org"),
      admit,
      routeDeps: stubDeps(),
    });
    /** Only one address per host here (the stub lookup), so two buckets, one ask each. */
    expect(asked).toEqual([
      ["example.org", 1],
      ["example.net", 1],
    ]);
    expect(outcomes[0]?.deferredMs).toBe(60_000);
    expect(outcomes[0]?.mxHost).toBe("backup.example.net");
  });

  test("the preferred family decides the address connected to", async () => {
    const addresses: string[] = [];
    await deliverWithFailover({
      domain: "example.org",
      hosts: ["mx1.example.org"],
      transactions: [transaction("example.org")],
      allowPrivate: false,
      ipFamily: 6,
      runSession: async ({ address, transactions }) => {
        addresses.push(address);
        return transactions.map((t) => ({ key: t.key, tls: "starttls" }));
      },
      lock: recordingLock([]),
      routeDeps: stubDeps({
        lookup: async () => [{ address: "203.0.113.10" }, { address: "2001:db8::25" }],
      }),
    });
    expect(addresses).toEqual(["2001:db8::25"]);
  });
});
