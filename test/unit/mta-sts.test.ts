import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  MTA_STS_MAX_AGE_CAP_SECONDS,
  MTA_STS_POLICY_MAX_BYTES,
  MtaStsFetchError,
  MtaStsPolicyCache,
  discoverMtaStsPolicy,
  fetchMtaStsPolicy,
  matchingMxHosts,
  mxMatchesPattern,
  parseMtaStsPolicy,
  parseMtaStsTxt,
  type MtaStsDeps,
} from "../../src/modules/emails/services/mta-sts.ts";

/**
 * Outbound MTA-STS (#250): the TXT and policy parsers, MX matching, the
 * cache rules, and the policy fetch (SSRF check, pinning, redirects, size,
 * content type). Lookups and the fetch are injected stubs; the fetch tests
 * that need real TLS run a local HTTPS server whose certificate the
 * test-only CA (`test/fixtures/tls/test-ca.cert.pem`) signed, trusted only
 * through the `ca` seam. No real DNS, no real HTTPS.
 */

const TLS_DIR = new URL("../fixtures/tls/", import.meta.url);
const CA = await Bun.file(new URL("test-ca.cert.pem", TLS_DIR)).text();

const ENFORCE = "version: STSv1\nmode: enforce\nmx: mx1.example.org\nmax_age: 86400\n";

/** A DNS error with its `code`, as `dns/promises` rejects. */
function dnsError(code: string): Error {
  return Object.assign(new Error(`queryTxt ${code}`), { code });
}

/** A policy response: 200, `text/plain`, unless overridden. */
function policyResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain" },
    ...init,
  });
}

/** Deps announcing policy `one` with an enforce policy, overridden per test. */
function stubDeps(overrides: Partial<MtaStsDeps> = {}): MtaStsDeps {
  return {
    resolveTxt: async () => [["v=STSv1; id=one;"]],
    lookup: async () => [{ address: "203.0.113.7" }],
    fetch: async () => policyResponse(ENFORCE),
    httpsPort: 443,
    fetchTimeoutMs: 1_000,
    dnsTimeoutMs: 1_000,
    now: () => 0,
    ...overrides,
  };
}

/** The error `promise` rejects with; fails the test when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("rejected with a non-Error", { cause: error });
  }
  throw new Error("expected a rejection");
}

describe("parseMtaStsTxt", () => {
  test("one valid record: its id", () => {
    expect(parseMtaStsTxt([["v=STSv1; id=20261019T000000;"]])).toBe("20261019T000000");
    expect(parseMtaStsTxt([["v=STSv1;id=abc"]])).toBe("abc");
  });

  test("a record split into several strings is joined", () => {
    expect(parseMtaStsTxt([["v=STSv1; ", "id=abc123;"]])).toBe("abc123");
  });

  test("records not starting with v=STSv1 are ignored", () => {
    expect(parseMtaStsTxt([["v=spf1 -all"], ["v=STSv1; id=abc;"]])).toBe("abc");
  });

  test("several v=STSv1 records: no policy", () => {
    expect(parseMtaStsTxt([["v=STSv1; id=abc;"], ["v=STSv1; id=def;"]])).toBeNull();
  });

  test("no record: no policy", () => {
    expect(parseMtaStsTxt([])).toBeNull();
  });

  test("a malformed or missing id: no policy", () => {
    expect(parseMtaStsTxt([["v=STSv1; id=bad-id;"]])).toBeNull();
    expect(parseMtaStsTxt([[`v=STSv1; id=${"a".repeat(33)};`]])).toBeNull();
    expect(parseMtaStsTxt([["v=STSv1; id=;"]])).toBeNull();
    expect(parseMtaStsTxt([["v=STSv1;"]])).toBeNull();
    expect(parseMtaStsTxt([["v=STSv1; id=a; id=b;"]])).toBeNull();
  });

  test("a wrong version or malformed field: no policy", () => {
    expect(parseMtaStsTxt([["v=STSv10; id=abc;"]])).toBeNull();
    expect(parseMtaStsTxt([["v=STSv1; id=abc;; x=y"]])).toBeNull();
    expect(parseMtaStsTxt([["v=STSv1; id=abc; junk"]])).toBeNull();
  });

  test("a valid extension field is allowed", () => {
    expect(parseMtaStsTxt([["v=STSv1; id=abc; ext=value1;"]])).toBe("abc");
  });
});

describe("parseMtaStsPolicy", () => {
  test("a valid enforce policy, LF line ends", () => {
    expect(
      parseMtaStsPolicy(
        "version: STSv1\nmode: enforce\nmx: mx1.example.com\nmx: *.example.net\nmax_age: 604800\n",
      ),
    ).toEqual({
      mode: "enforce",
      mx: ["mx1.example.com", "*.example.net"],
      maxAge: 604800,
    });
  });

  test("CRLF line ends", () => {
    expect(
      parseMtaStsPolicy(
        "version: STSv1\r\nmode: testing\r\nmx: mx.example.com\r\nmax_age: 60\r\n",
      ),
    ).toEqual({ mode: "testing", mx: ["mx.example.com"], maxAge: 60 });
  });

  test("patterns are lowercased, without a trailing dot, kept once", () => {
    expect(
      parseMtaStsPolicy(
        "version: STSv1\nmode: enforce\nmx: MX.Example.COM.\nmx: mx.example.com\nmax_age: 60",
      )?.mx,
    ).toEqual(["mx.example.com"]);
  });

  test("a missing or invalid mode: invalid", () => {
    expect(
      parseMtaStsPolicy("version: STSv1\nmx: mx.example.com\nmax_age: 60"),
    ).toBeNull();
    expect(
      parseMtaStsPolicy("version: STSv1\nmode: Enforce\nmx: mx.example.com\nmax_age: 60"),
    ).toBeNull();
    expect(
      parseMtaStsPolicy("version: STSv1\nmode: strict\nmx: mx.example.com\nmax_age: 60"),
    ).toBeNull();
  });

  test("a missing or wrong version: invalid", () => {
    expect(
      parseMtaStsPolicy("mode: enforce\nmx: mx.example.com\nmax_age: 60"),
    ).toBeNull();
    expect(
      parseMtaStsPolicy("version: STSv2\nmode: enforce\nmx: mx.example.com\nmax_age: 60"),
    ).toBeNull();
  });

  test("a bad max_age: invalid", () => {
    const withAge = (age: string): string =>
      `version: STSv1\nmode: enforce\nmx: mx.example.com\nmax_age: ${age}`;
    expect(parseMtaStsPolicy(withAge("abc"))).toBeNull();
    expect(parseMtaStsPolicy(withAge("-1"))).toBeNull();
    expect(parseMtaStsPolicy(withAge("1.5"))).toBeNull();
    expect(parseMtaStsPolicy(withAge("12345678901"))).toBeNull();
    expect(
      parseMtaStsPolicy("version: STSv1\nmode: enforce\nmx: mx.example.com"),
    ).toBeNull();
  });

  test("max_age is capped at a year", () => {
    expect(
      parseMtaStsPolicy(
        "version: STSv1\nmode: enforce\nmx: mx.example.com\nmax_age: 9999999999",
      )?.maxAge,
    ).toBe(MTA_STS_MAX_AGE_CAP_SECONDS);
  });

  test("a repeated single field: invalid", () => {
    expect(
      parseMtaStsPolicy(
        "version: STSv1\nmode: enforce\nmode: none\nmx: mx.example.com\nmax_age: 60",
      ),
    ).toBeNull();
  });

  test("wildcard patterns: one leading *. label only", () => {
    const withMx = (mx: string): string =>
      `version: STSv1\nmode: enforce\nmx: ${mx}\nmax_age: 60`;
    expect(parseMtaStsPolicy(withMx("*.example.com"))?.mx).toEqual(["*.example.com"]);
    expect(parseMtaStsPolicy(withMx("*.*.example.com"))).toBeNull();
    expect(parseMtaStsPolicy(withMx("mx*.example.com"))).toBeNull();
    expect(parseMtaStsPolicy(withMx("a.*.example.com"))).toBeNull();
    expect(parseMtaStsPolicy(withMx("*"))).toBeNull();
    expect(parseMtaStsPolicy(withMx("mx_1.example.com"))).toBeNull();
    expect(parseMtaStsPolicy(withMx(""))).toBeNull();
  });

  test("enforce and testing need an mx pattern; none does not", () => {
    expect(parseMtaStsPolicy("version: STSv1\nmode: enforce\nmax_age: 60")).toBeNull();
    expect(parseMtaStsPolicy("version: STSv1\nmode: testing\nmax_age: 60")).toBeNull();
    expect(parseMtaStsPolicy("version: STSv1\nmode: none\nmax_age: 60")).toEqual({
      mode: "none",
      mx: [],
      maxAge: 60,
    });
  });

  test("junk lines and unknown keys are ignored", () => {
    expect(
      parseMtaStsPolicy(
        "# a comment\nversion: STSv1\nthis is not a field\nmode: enforce\nextension: 1\n\nmx: mx.example.com\nmax_age: 60\n\n",
      ),
    ).toEqual({ mode: "enforce", mx: ["mx.example.com"], maxAge: 60 });
  });

  test("a body over 64 KB: invalid", () => {
    const padding = `${"x".repeat(100)}\n`.repeat(
      Math.ceil(MTA_STS_POLICY_MAX_BYTES / 101) + 1,
    );
    expect(parseMtaStsPolicy(`${ENFORCE}${padding}`)).toBeNull();
  });
});

describe("MX matching", () => {
  test("a *. wildcard matches exactly one leftmost label", () => {
    expect(mxMatchesPattern("mx1.example.com", "*.example.com")).toBe(true);
    expect(mxMatchesPattern("a.b.example.com", "*.example.com")).toBe(false);
    expect(mxMatchesPattern("example.com", "*.example.com")).toBe(false);
    expect(mxMatchesPattern("mx1.example.com.evil", "*.example.com")).toBe(false);
    expect(mxMatchesPattern("mx1example.com", "*.example.com")).toBe(false);
  });

  test("an exact pattern, ignoring case and a trailing dot", () => {
    expect(mxMatchesPattern("MX.Example.com.", "mx.example.com")).toBe(true);
    expect(mxMatchesPattern("mx2.example.com", "mx.example.com")).toBe(false);
    expect(mxMatchesPattern("sub.mx.example.com", "mx.example.com")).toBe(false);
  });

  test("matchingMxHosts keeps the hosts' order", () => {
    expect(
      matchingMxHosts(["b.example.com", "evil.test", "a.example.com"], {
        mode: "enforce",
        mx: ["*.example.com"],
        maxAge: 60,
      }),
    ).toEqual(["b.example.com", "a.example.com"]);
  });
});

describe("discoverMtaStsPolicy: cache rules", () => {
  /** A clock, a cache and deps whose TXT `id` and fetch outcome each test sets. */
  function harness() {
    const state = {
      now: 1_000_000,
      txt: (): Promise<string[][]> => Promise.resolve([["v=STSv1; id=one;"]]),
      fetchFails: false,
      body: ENFORCE,
      fetches: 0,
    };
    const deps = stubDeps({
      resolveTxt: () => state.txt(),
      now: () => state.now,
      fetch: async () => {
        state.fetches += 1;
        if (state.fetchFails) throw new Error("connection refused");
        return policyResponse(state.body);
      },
    });
    const cache = new MtaStsPolicyCache();
    const discover = () =>
      discoverMtaStsPolicy("example.org", { allowPrivate: false, deps, cache });
    return { state, discover, cache };
  }

  test("an unchanged id within max_age reuses the cached policy without a fetch", async () => {
    const { state, discover } = harness();
    expect((await discover())?.policy.mode).toBe("enforce");
    state.now += 3_600_000;
    expect((await discover())?.id).toBe("one");
    expect(state.fetches).toBe(1);
  });

  test("a changed id fetches again", async () => {
    const { state, discover } = harness();
    await discover();
    state.txt = () => Promise.resolve([["v=STSv1; id=two;"]]);
    state.body = ENFORCE.replace("enforce", "testing");
    const active = await discover();
    expect(state.fetches).toBe(2);
    expect(active).toEqual({
      id: "two",
      policy: { mode: "testing", mx: ["mx1.example.org"], maxAge: 86400 },
    });
  });

  test("a failed fetch keeps the cached, unexpired policy", async () => {
    const { state, discover } = harness();
    await discover();
    state.txt = () => Promise.resolve([["v=STSv1; id=two;"]]);
    state.fetchFails = true;
    expect(await discover()).toMatchObject({ id: "one", policy: { mode: "enforce" } });
    expect(state.fetches).toBe(2);
  });

  test("an expired policy is fetched again; with the fetch failing, there is none", async () => {
    const { state, discover } = harness();
    await discover();
    state.now += 86_400_000;
    await discover();
    expect(state.fetches).toBe(2);
    state.now += 86_400_000;
    state.fetchFails = true;
    expect(await discover()).toBeNull();
  });

  test("a TXT record that disappears keeps the policy until max_age", async () => {
    const { state, discover } = harness();
    await discover();
    state.txt = () => Promise.reject(dnsError("ENOTFOUND"));
    state.now += 86_399_000;
    expect((await discover())?.id).toBe("one");
    state.now += 1_000;
    expect(await discover()).toBeNull();
    expect(state.fetches).toBe(1);
  });

  test("a TXT lookup error keeps the cached policy, and means none without one", async () => {
    const { state, discover } = harness();
    state.txt = () => Promise.reject(dnsError("ESERVFAIL"));
    expect(await discover()).toBeNull();
    expect(state.fetches).toBe(0);
    state.txt = () => Promise.resolve([["v=STSv1; id=one;"]]);
    await discover();
    state.txt = () => Promise.reject(dnsError("ETIMEOUT"));
    expect((await discover())?.id).toBe("one");
  });

  test("no TXT record and nothing cached: no policy, no fetch", async () => {
    const { state, discover } = harness();
    state.txt = () => Promise.reject(dnsError("ENODATA"));
    expect(await discover()).toBeNull();
    state.txt = () => Promise.resolve([["v=STSv1; id=a;"], ["v=STSv1; id=b;"]]);
    expect(await discover()).toBeNull();
    expect(state.fetches).toBe(0);
  });

  test("an invalid policy is a failed fetch", async () => {
    const { state, discover } = harness();
    state.body = "version: STSv1\nmode: enforce\nmax_age: 60";
    expect(await discover()).toBeNull();
    expect(state.fetches).toBe(1);
  });

  test("a failed fetch is not retried for the same id for a while", async () => {
    const { state, discover } = harness();
    state.fetchFails = true;
    expect(await discover()).toBeNull();
    state.fetchFails = false;
    state.now += 60_000;
    expect(await discover()).toBeNull();
    expect(state.fetches).toBe(1);
    state.now += 5 * 60_000;
    expect((await discover())?.id).toBe("one");
    expect(state.fetches).toBe(2);
  });

  test("the cache is bounded: the oldest domain is evicted", () => {
    const cache = new MtaStsPolicyCache(2);
    const policy = { mode: "enforce" as const, mx: ["mx.example.com"], maxAge: 60 };
    cache.set("a.example", "1", policy, 0);
    cache.set("b.example", "1", policy, 0);
    cache.set("a.example", "2", policy, 0);
    cache.set("c.example", "1", policy, 0);
    expect(cache.size).toBe(2);
    expect(cache.get("b.example", 0)).toBeUndefined();
    expect(cache.get("a.example", 0)?.id).toBe("2");
    expect(cache.get("c.example", 0)?.id).toBe("1");
  });

  test("a testing warning is reported once per domain and policy id", () => {
    const cache = new MtaStsPolicyCache();
    const policy = { mode: "testing" as const, mx: ["mx.example.com"], maxAge: 60 };
    cache.set("a.example", "1", policy, 0);
    expect(cache.firstWarning("a.example", "1")).toBe(true);
    expect(cache.firstWarning("a.example", "1")).toBe(false);
    cache.set("a.example", "2", policy, 0);
    expect(cache.firstWarning("a.example", "2")).toBe(true);
  });
});

describe("fetchMtaStsPolicy: request and response checks", () => {
  test("a policy host resolving to a non-public address is refused without connecting", async () => {
    for (const address of [
      "10.0.0.5",
      "127.0.0.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
    ]) {
      let fetched = false;
      const deps = stubDeps({
        lookup: async () => [{ address: "203.0.113.7" }, { address }],
        fetch: async () => {
          fetched = true;
          return policyResponse(ENFORCE);
        },
      });
      expect(
        (await rejection(fetchMtaStsPolicy("example.org", { allowPrivate: false }, deps)))
          .message,
      ).toContain("resolves to a non-public address");
      expect(fetched).toBe(false);
    }
  });

  test("the request is pinned to the checked address, with the host name for TLS", async () => {
    let seenUrl = "";
    let seenInit: BunFetchRequestInit | undefined;
    const deps = stubDeps({
      fetch: async (url, init) => {
        seenUrl = url;
        seenInit = init;
        return policyResponse(ENFORCE);
      },
    });
    await fetchMtaStsPolicy("example.org", { allowPrivate: false }, deps);
    expect(seenUrl).toBe("https://203.0.113.7/.well-known/mta-sts.txt");
    expect(seenInit?.redirect).toBe("manual");
    expect(seenInit?.tls?.serverName).toBe("mta-sts.example.org");
    expect(seenInit?.tls?.rejectUnauthorized).toBe(true);
    expect(new Headers(seenInit?.headers).get("host")).toBe("mta-sts.example.org");
  });

  test("anything but 200 fails, a redirect included", async () => {
    for (const status of [301, 302, 404, 500]) {
      const deps = stubDeps({
        fetch: async () =>
          policyResponse("", {
            status,
            headers: { location: "https://elsewhere.example/" },
          }),
      });
      expect(
        (await rejection(fetchMtaStsPolicy("example.org", { allowPrivate: false }, deps)))
          .message,
      ).toContain(`HTTP ${status}`);
    }
  });

  test("Content-Type must be text/plain, parameters allowed", async () => {
    const withType = (type: string) =>
      stubDeps({
        fetch: async () => policyResponse(ENFORCE, { headers: { "content-type": type } }),
      });
    expect(
      (
        await fetchMtaStsPolicy(
          "example.org",
          { allowPrivate: false },
          withType("text/plain; charset=utf-8"),
        )
      ).mode,
    ).toBe("enforce");
    expect(
      await rejection(
        fetchMtaStsPolicy("example.org", { allowPrivate: false }, withType("text/html")),
      ),
    ).toBeInstanceOf(MtaStsFetchError);
  });

  test("a body over 64 KB fails", async () => {
    const big = `${ENFORCE}${"#".repeat(MTA_STS_POLICY_MAX_BYTES)}`;
    const deps = stubDeps({ fetch: async () => policyResponse(big) });
    expect(
      (await rejection(fetchMtaStsPolicy("example.org", { allowPrivate: false }, deps)))
        .message,
    ).toContain("policy larger than");
  });

  test("an encoded body fails", async () => {
    const deps = stubDeps({
      fetch: async () =>
        policyResponse(ENFORCE, {
          headers: { "content-type": "text/plain", "content-encoding": "gzip" },
        }),
    });
    expect(
      (await rejection(fetchMtaStsPolicy("example.org", { allowPrivate: false }, deps)))
        .message,
    ).toContain("encoded");
  });
});

describe("fetchMtaStsPolicy against a local HTTPS server", () => {
  /** What the server got: the paths requested, in order. */
  const requested: string[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  let wrongName: ReturnType<typeof Bun.serve> | undefined;

  /** Serves the policy with the certificate of `certName`. */
  function serve(certName: string): ReturnType<typeof Bun.serve> {
    return Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: {
        key: Bun.file(new URL(`${certName}.key.pem`, TLS_DIR)),
        cert: Bun.file(new URL(`${certName}.cert.pem`, TLS_DIR)),
      },
      fetch(request) {
        requested.push(new URL(request.url).pathname);
        return policyResponse(ENFORCE);
      },
    });
  }

  beforeAll(() => {
    server = serve("mta-sts.example.org");
    wrongName = serve("mx1.example.test");
  });

  afterAll(() => {
    void server?.stop(true);
    void wrongName?.stop(true);
  });

  /** Deps aimed at a local server, trusting only the test CA. */
  function localDeps(port: number, overrides: Partial<MtaStsDeps> = {}): MtaStsDeps {
    return stubDeps({
      lookup: async () => [{ address: "127.0.0.1" }],
      fetch: (url, init) => fetch(url, init),
      httpsPort: port,
      ca: CA,
      ...overrides,
    });
  }

  test("a valid certificate for mta-sts.<domain>: the policy", async () => {
    const policy = await fetchMtaStsPolicy(
      "example.org",
      { allowPrivate: true },
      localDeps(server?.port ?? 0),
    );
    expect(policy).toEqual({ mode: "enforce", mx: ["mx1.example.org"], maxAge: 86400 });
  });

  test("a certificate for another name fails", async () => {
    expect(
      (
        await rejection(
          fetchMtaStsPolicy(
            "example.org",
            { allowPrivate: true },
            localDeps(wrongName?.port ?? 0),
          ),
        )
      ).message,
    ).toContain("policy fetch failed");
  });

  test("a certificate the trust store does not know fails", async () => {
    expect(
      (
        await rejection(
          fetchMtaStsPolicy(
            "example.org",
            { allowPrivate: true },
            localDeps(server?.port ?? 0, { ca: undefined }),
          ),
        )
      ).message,
    ).toContain("policy fetch failed");
  });

  test("a redirect is not followed", async () => {
    const redirecting = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: {
        key: Bun.file(new URL("mta-sts.example.org.key.pem", TLS_DIR)),
        cert: Bun.file(new URL("mta-sts.example.org.cert.pem", TLS_DIR)),
      },
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: {
            location: `https://127.0.0.1:${server?.port ?? 0}/.well-known/mta-sts.txt`,
          },
        }),
    });
    try {
      requested.length = 0;
      expect(
        (
          await rejection(
            fetchMtaStsPolicy(
              "example.org",
              { allowPrivate: true },
              localDeps(redirecting.port ?? 0),
            ),
          )
        ).message,
      ).toContain("HTTP 302");
      await Bun.sleep(50);
      expect(requested).toEqual([]);
    } finally {
      void redirecting.stop(true);
    }
  });
});
