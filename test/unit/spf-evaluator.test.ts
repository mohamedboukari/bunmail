import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  clientAddress,
  inNetwork,
  parseIp,
  reverseName,
  type IpAddress,
} from "../../src/modules/domains/services/spf-address.ts";
import { checkHost } from "../../src/modules/domains/services/spf-evaluator.ts";
import {
  SpfError,
  expandMacros,
  parseDomainSpec,
  parseSpfRecord,
  targetName,
  type MacroValues,
} from "../../src/modules/domains/services/spf-syntax.ts";
import type { SpfDnsResolver } from "../../src/modules/domains/types/spf.types.ts";
import {
  checkHostInput,
  loadSpfTests,
  zoneResolver,
  type SpfTestCase,
} from "../spf-zone.ts";

/**
 * The built-in SPF evaluator (#373), RFC 7208 strict mode.
 *
 * - The OpenSPF RFC 7208 test suite (`rfc7208-tests.yml`, release
 *   2014.04, BSD-3-Clause, vendored unchanged with its license from pyspf
 *   commit 4bf96ea `test/`) and BunMail's own cases
 *   (`bunmail-spf-tests.yml`), each case against its fake DNS zone.
 * - A differential check: every case gives the result mailauth 7.1.1
 *   gave (`mailauth-results.json`, recorded before mailauth
 *   was removed in #373; the recording script went with it), except the
 *   differences listed in `INTENDED_DIFFERENCES`.
 * - Macro expansion (the examples of RFC 7208 7.4), syntax, addresses,
 *   DNS error mapping and the deadline, with injected resolvers.
 */

const FIXTURES = join(import.meta.dir, "../fixtures/spf");
const FILES = ["rfc7208-tests.yml", "bunmail-spf-tests.yml"];

const cases = new Map<string, SpfTestCase[]>();
for (const file of FILES) cases.set(file, await loadSpfTests(join(FIXTURES, file)));

/** mailauth's recorded results, `file -> test id -> result`. */
const recorded: unknown = await Bun.file(join(FIXTURES, "mailauth-results.json")).json();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** mailauth's result for one case, `undefined` when not recorded. */
function mailauthResult(file: string, id: string): string | undefined {
  if (!isObject(recorded) || !isObject(recorded.results)) return undefined;
  const results = recorded.results[file];
  const result = isObject(results) ? results[id] : undefined;
  return typeof result === "string" ? result : undefined;
}

/**
 * Cases where the built-in evaluator deliberately differs from mailauth,
 * as `file/id`, with why. Each still matches the case's expected result.
 */
const INTENDED_DIFFERENCES: Readonly<Record<string, string>> = {
  "bunmail-spf-tests.yml/mx-eleven-names":
    "RFC 7208 4.6.4: an mx answer of more than 10 names is a permerror. mailauth only fails on the 11th address lookup, so a match among the first ten passes.",
  "bunmail-spf-tests.yml/dot-ptr-answer":
    "mailauth keeps the trailing dot of a PTR answer and then cannot validate the name. Bun's resolver returns PTR names without the dot, so this only shows with a resolver that keeps it.",
};

/** Runs one test case against its zone. */
function evaluate(testCase: SpfTestCase): ReturnType<typeof checkHost> {
  return checkHost(checkHostInput(testCase), { resolver: zoneResolver(testCase.zone) });
}

for (const file of FILES) {
  const fileCases = cases.get(file) ?? [];

  describe(`checkHost: ${file}`, () => {
    test("loads its cases", () => {
      expect(fileCases.length).toBeGreaterThan(100);
      for (const testCase of fileCases) {
        expect(testCase.expected.length).toBeGreaterThan(0);
      }
    });

    for (const testCase of fileCases) {
      test(`${testCase.id} (RFC 7208 ${testCase.spec})`, async () => {
        const { result } = await evaluate(testCase);
        expect(testCase.expected).toContain(result);
      });
    }
  });

  describe(`checkHost agrees with mailauth: ${file}`, () => {
    for (const testCase of fileCases) {
      const key = `${file}/${testCase.id}`;
      test(testCase.id, async () => {
        const theirs = mailauthResult(file, testCase.id);
        expect(theirs).toBeDefined();
        const outcome = await evaluate(testCase);
        /** Widened to compare with the recorded string. */
        const result: string = outcome.result;
        if (key in INTENDED_DIFFERENCES) {
          expect(result).not.toBe(theirs);
          expect(testCase.expected).toContain(outcome.result);
        } else {
          expect(result).toBe(theirs ?? "");
        }
      });
    }
  });
}

test("every intended difference names an existing case", () => {
  for (const key of Object.keys(INTENDED_DIFFERENCES)) {
    const [file = "", id] = key.split("/");
    expect((cases.get(file) ?? []).some((testCase) => testCase.id === id)).toBe(true);
  }
});

/** Parses an address the tests know is valid. */
function ip(text: string): IpAddress {
  const address = clientAddress(text);
  if (!address) throw new Error(`bad test address ${text}`);
  return address;
}

describe("macro expansion: RFC 7208 7.4 examples", () => {
  const values: MacroValues = {
    sender: "strong-bad@email.example.com",
    localPart: "strong-bad",
    senderDomain: "email.example.com",
    domain: "email.example.com",
    ip: ip("192.0.2.3"),
    helo: "mx.example.org",
  };
  const expand = (spec: string, overrides: Partial<MacroValues> = {}): string =>
    expandMacros(parseDomainSpec(spec), { ...values, ...overrides });

  test.each([
    ["%{s}", "strong-bad@email.example.com"],
    ["%{o}", "email.example.com"],
    ["%{d}", "email.example.com"],
    ["%{d4}", "email.example.com"],
    ["%{d3}", "email.example.com"],
    ["%{d2}", "example.com"],
    ["%{d1}", "com"],
    ["%{dr}", "com.example.email"],
    ["%{d2r}", "example.email"],
    ["%{l}", "strong-bad"],
    ["%{l-}", "strong.bad"],
    ["%{lr}", "strong-bad"],
    ["%{lr-}", "bad.strong"],
    ["%{l1r-}", "strong"],
    ["%{ir}.%{v}._spf.%{d2}", "3.2.0.192.in-addr._spf.example.com"],
    ["%{lr-}.lp._spf.%{d2}", "bad.strong.lp._spf.example.com"],
    [
      "%{lr-}.lp.%{ir}.%{v}._spf.%{d2}",
      "bad.strong.lp.3.2.0.192.in-addr._spf.example.com",
    ],
    ["%{ir}.%{v}.%{l1r-}.lp._spf.%{d2}", "3.2.0.192.in-addr.strong.lp._spf.example.com"],
    ["%{d2}.trusted-domains.example.net", "example.com.trusted-domains.example.net"],
  ])("%s expands to %s", (spec, expected) => {
    expect(expand(spec)).toBe(expected);
  });

  test("the IPv6 example uses the reversed nibbles and ip6", () => {
    expect(expand("%{ir}.%{v}._spf.%{d2}", { ip: ip("2001:db8::cb01") })).toBe(
      "1.0.b.c.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6._spf.example.com",
    );
  });

  test("an uppercase letter URL-escapes everything outside unreserved", () => {
    expect(expand("%{L}.example.com", { localPart: "~jack&jill=up-a_b3.c" })).toBe(
      "~jack%26jill%3Dup-a_b3.c.example.com",
    );
    expect(expand("%{S}.example.com")).toBe("strong-bad%40email.example.com.example.com");
  });

  test("%%, %_ and %- expand to %, a space and %20", () => {
    expect(expand("a%%b%_c%-d.example.com")).toBe("a%b c%20d.example.com");
  });

  test("%{p} is the given name, or unknown", () => {
    expect(expand("%{p}.example.com")).toBe("unknown.example.com");
    expect(expand("%{p}.example.com", { ptrName: "mx.example.org" })).toBe(
      "mx.example.org.example.com",
    );
  });

  test("%{h} is the HELO name and several delimiters split on each", () => {
    expect(expand("%{h}.example.com")).toBe("mx.example.org.example.com");
    /** Split on + and -, reversed (quux zip bar foo), the right-hand two kept. */
    expect(expand("%{l2r+-}.example.com", { localPart: "foo-bar+zip+quux" })).toBe(
      "bar.foo.example.com",
    );
  });
});

describe("domain-spec syntax (RFC 7208 7.1)", () => {
  test.each([
    "",
    "example",
    "example.123",
    "example.-com",
    "%{d",
    "%x.example.com",
    "%{c}.example.com",
    "%{r}.example.com",
    "%{t}.example.com",
    "%{d0}.example.com",
    "%{z}.example.com",
    "exa mple.com",
    "example.com/24",
  ])("refuses %p", (spec) => {
    expect(() => parseDomainSpec(spec)).toThrow(SpfError);
  });

  test.each([
    "example.com",
    "example.com.",
    "%{d}",
    "%{d2}.example.com",
    "foo:bar/baz.example.com",
    "foo.example.xn--zckzah",
    "%{ir}.%{v}.%{d}%%",
  ])("accepts %p", (spec) => {
    expect(() => parseDomainSpec(spec)).not.toThrow();
  });
});

describe("targetName (RFC 7208 7.3)", () => {
  test("drops one trailing dot", () => {
    expect(targetName("example.com.")).toBe("example.com");
  });

  test("truncates from the left, whole labels, to 253 characters", () => {
    const label = "a".repeat(60);
    const name = targetName(`${label}.${label}.${label}.${label}.${label}.example.com`);
    expect(name).toBe(`${label}.${label}.${label}.example.com`);
    expect((name ?? "").length).toBeLessThanOrEqual(253);
  });

  test.each([
    "example..com",
    `${"a".repeat(64)}.example.com`,
    "localhost",
    "example.123",
    "",
  ])("refuses %p", (name) => {
    expect(targetName(name)).toBeNull();
  });
});

describe("parseSpfRecord", () => {
  test("reads dual CIDR lengths of a and mx", () => {
    const [a, mx] = parseSpfRecord(
      "v=spf1 a:foo.example.com/24//64 mx//0 -all",
    ).mechanisms;
    expect(a).toMatchObject({ kind: "a", cidr4: 24, cidr6: 64 });
    expect(mx).toMatchObject({ kind: "mx", domainSpec: null, cidr4: 32, cidr6: 0 });
  });

  test("keeps the redirect, ignores exp and unknown modifiers", () => {
    const record = parseSpfRecord(
      "v=spf1 exp=why.example.com note=x redirect=_spf.example.com",
    );
    expect(record.mechanisms).toHaveLength(0);
    expect(record.redirect).not.toBeNull();
  });

  test("qualifiers and case", () => {
    const qualifiers = parseSpfRecord("v=spf1 +A -MX ~Ptr ?ALL").mechanisms.map(
      (mechanism) => `${mechanism.qualifier}${mechanism.kind}`,
    );
    expect(qualifiers).toEqual(["+a", "-mx", "~ptr", "?all"]);
  });

  test.each([
    "v=spf1 ip4:192.0.2.1 foo",
    "v=spf1 ip4:192.0.2.1/33",
    "v=spf1 ip4:192.0.2.1/032",
    "v=spf1 ip6:2001:db8::/129",
    "v=spf1 ip6:192.0.2.1",
    "v=spf1 ip4:2001:db8::1",
    "v=spf1 a:example.com:8080",
    "v=spf1 redirect=a.example.com redirect=b.example.com",
    "v=spf1 exp=a.example.com exp=b.example.com",
    "v=spf1 exp=",
    "v=spf1 1foo=bar",
    "v=spf1 =all",
    "v=spf1 -allé",
    "v=spf1 include",
    "v=spf1 exists",
    "v=spf1 ptr/24",
  ])("refuses %p", (record) => {
    expect(() => parseSpfRecord(record)).toThrow(SpfError);
  });
});

describe("addresses", () => {
  test("IPv4-mapped clients become IPv4, other IPv6 stays IPv6", () => {
    expect(ip("::ffff:192.0.2.1")).toEqual(ip("192.0.2.1"));
    expect(ip("::FFFF:c000:0201")).toEqual(ip("192.0.2.1"));
    expect(ip("::192.0.2.1").family).toBe(6);
    expect(ip("::ffff:0:192.0.2.1").family).toBe(6);
    expect(ip("64:ff9b::192.0.2.1").family).toBe(6);
  });

  test("parseIp refuses a zone index and garbage", () => {
    expect(parseIp("fe80::1%eth0")).toBeNull();
    expect(parseIp("192.0.2")).toBeNull();
    expect(parseIp("example.com")).toBeNull();
    expect(clientAddress("")).toBeNull();
  });

  test("inNetwork at /0, /32, /128 and inside a byte", () => {
    expect(inNetwork(ip("203.0.113.9"), ip("0.0.0.0"), 0)).toBe(true);
    expect(inNetwork(ip("192.0.2.1"), ip("192.0.2.1"), 32)).toBe(true);
    expect(inNetwork(ip("192.0.2.2"), ip("192.0.2.1"), 32)).toBe(false);
    expect(inNetwork(ip("192.0.2.127"), ip("192.0.2.0"), 25)).toBe(true);
    expect(inNetwork(ip("192.0.2.128"), ip("192.0.2.0"), 25)).toBe(false);
    expect(inNetwork(ip("2001:db8::1"), ip("2001:db8::1"), 128)).toBe(true);
    expect(inNetwork(ip("2001:db8::2"), ip("2001:db8::1"), 128)).toBe(false);
    expect(inNetwork(ip("cafe:babe:8000::"), ip("cafe:babe:8000::"), 33)).toBe(true);
    expect(inNetwork(ip("cafe:babe::"), ip("cafe:babe:8000::"), 33)).toBe(false);
    expect(inNetwork(ip("2001:db8::1"), ip("::"), 0)).toBe(true);
  });

  test("inNetwork never matches across families", () => {
    expect(inNetwork(ip("192.0.2.1"), ip("::"), 0)).toBe(false);
    expect(inNetwork(ip("2001:db8::1"), ip("0.0.0.0"), 0)).toBe(false);
  });

  test("reverseName", () => {
    expect(reverseName(ip("192.0.2.3"))).toBe("3.2.0.192.in-addr.arpa");
    expect(reverseName(ip("2001:db8::cb01"))).toBe(
      "1.0.b.c.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa",
    );
  });
});

/** A DNS error with `code`, as `dns/promises` rejects. */
function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** A resolver where every name is NXDOMAIN, with some lookups replaced. */
function resolver(overrides: Partial<SpfDnsResolver>): SpfDnsResolver {
  const missing = (): Promise<never> => Promise.reject(dnsError("ENOTFOUND"));
  return {
    resolveTxt: missing,
    resolve4: missing,
    resolve6: missing,
    resolveMx: missing,
    resolvePtr: missing,
    ...overrides,
  };
}

/** A resolver whose only TXT record is `record` at example.com. */
function withRecord(
  record: string,
  overrides: Partial<SpfDnsResolver> = {},
): SpfDnsResolver {
  return resolver({
    resolveTxt: (name) =>
      name === "example.com"
        ? Promise.resolve([[record]])
        : Promise.reject(dnsError("ENOTFOUND")),
    ...overrides,
  });
}

const INPUT = {
  ip: "192.0.2.1",
  domain: "example.com",
  sender: "postmaster@example.com",
  helo: "mail.example.net",
};

describe("checkHost: DNS errors", () => {
  test("ENODATA and an empty answer are void, not errors", async () => {
    const dns = withRecord(
      "v=spf1 a:one.example.com a:two.example.com ip4:192.0.2.1 -all",
      {
        resolve4: (name) =>
          name === "one.example.com"
            ? Promise.reject(dnsError("ENODATA"))
            : Promise.resolve([]),
      },
    );
    expect((await checkHost(INPUT, { resolver: dns })).result).toBe("pass");
  });

  test("void answers count toward the limit of two", async () => {
    const dns = withRecord(
      "v=spf1 a:one.example.com a:two.example.com a:three.example.com ip4:192.0.2.1 -all",
      { resolve4: () => Promise.reject(dnsError("ENODATA")) },
    );
    const { result, reason } = await checkHost(INPUT, { resolver: dns });
    expect(result).toBe("permerror");
    expect(reason).toContain("void");
  });

  test.each(["ESERVFAIL", "ETIMEOUT", "ECONNREFUSED", "EREFUSED", "EBADRESP"])(
    "%s on an a lookup is a temperror",
    async (code) => {
      const dns = withRecord("v=spf1 a:host.example.com -all", {
        resolve4: () => Promise.reject(dnsError(code)),
      });
      const { result, reason } = await checkHost(INPUT, { resolver: dns });
      expect(result).toBe("temperror");
      expect(reason).toContain(code);
    },
  );

  test("an error without a code is a temperror", async () => {
    const plain = withRecord("v=spf1 a:host.example.com -all", {
      resolve4: () => Promise.reject(new Error("socket closed")),
    });
    expect((await checkHost(INPUT, { resolver: plain })).result).toBe("temperror");
  });

  test("a failed TXT lookup of the domain is a temperror, NXDOMAIN is none", async () => {
    const failed = resolver({ resolveTxt: () => Promise.reject(dnsError("ESERVFAIL")) });
    expect((await checkHost(INPUT, { resolver: failed })).result).toBe("temperror");
    expect((await checkHost(INPUT, { resolver: resolver({}) })).result).toBe("none");
  });

  test("a temperror inside an include propagates past a later +all", async () => {
    const dns = resolver({
      resolveTxt: (name) =>
        name === "example.com"
          ? Promise.resolve([["v=spf1 include:inc.example.org +all"]])
          : Promise.reject(dnsError("ETIMEOUT")),
    });
    expect((await checkHost(INPUT, { resolver: dns })).result).toBe("temperror");
  });
});

describe("checkHost: the deadline", () => {
  const never = (): Promise<never> => new Promise<never>(() => undefined);

  test("a lookup that never answers is a temperror at the deadline", async () => {
    const started = Date.now();
    const { result, reason } = await checkHost(INPUT, {
      resolver: resolver({ resolveTxt: never }),
      timeoutMs: 50,
    });
    expect(result).toBe("temperror");
    expect(reason).toContain("time limit");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("the deadline covers includes too", async () => {
    const dns = resolver({
      resolveTxt: (name) =>
        name === "example.com"
          ? Promise.resolve([["v=spf1 include:slow.example.org -all"]])
          : never(),
    });
    expect((await checkHost(INPUT, { resolver: dns, timeoutMs: 50 })).result).toBe(
      "temperror",
    );
  });

  test("no query starts after the deadline", async () => {
    let queries = 0;
    const slow = (): Promise<string[]> => {
      queries++;
      return new Promise((resolve) => setTimeout(() => resolve(["198.51.100.1"]), 30));
    };
    const dns = withRecord(
      "v=spf1 a:h1.example.com a:h2.example.com a:h3.example.com a:h4.example.com -all",
      { resolve4: slow },
    );
    const { result } = await checkHost(INPUT, { resolver: dns, timeoutMs: 45 });
    expect(result).toBe("temperror");
    expect(queries).toBeLessThanOrEqual(2);
  });
});

describe("checkHost: inputs", () => {
  test("an invalid IP is a temperror, an invalid domain none", async () => {
    const dns = withRecord("v=spf1 +all");
    expect(
      (await checkHost({ ...INPUT, ip: "not-an-ip" }, { resolver: dns })).result,
    ).toBe("temperror");
    expect(
      (await checkHost({ ...INPUT, domain: "localhost" }, { resolver: dns })).result,
    ).toBe("none");
    expect(
      (await checkHost({ ...INPUT, domain: "a..example.com" }, { resolver: dns })).result,
    ).toBe("none");
  });

  test("a trailing dot on the domain is ignored", async () => {
    const dns = withRecord("v=spf1 ip4:192.0.2.1 -all");
    expect(
      (await checkHost({ ...INPUT, domain: "example.com." }, { resolver: dns })).result,
    ).toBe("pass");
  });

  test("a sender without a local-part is postmaster", async () => {
    const queried: string[] = [];
    const dns = withRecord("v=spf1 exists:%{l}.%{o}.example.net -all", {
      resolve4: (name) => {
        queried.push(name);
        return Promise.resolve(["127.0.0.2"]);
      },
    });
    expect(
      (await checkHost({ ...INPUT, sender: "@example.com" }, { resolver: dns })).result,
    ).toBe("pass");
    expect(queried).toEqual(["postmaster.example.com.example.net"]);
  });

  test("ip4, ip6 and all make no DNS query", async () => {
    let queries = 0;
    const count = (): Promise<never> => {
      queries++;
      return Promise.reject(dnsError("ENOTFOUND"));
    };
    const dns = withRecord("v=spf1 ip6:2001:db8::/32 ip4:198.51.100.0/24 ~all", {
      resolve4: count,
      resolve6: count,
      resolveMx: count,
      resolvePtr: count,
    });
    expect((await checkHost(INPUT, { resolver: dns })).result).toBe("softfail");
    expect(queries).toBe(0);
  });

  test("limits are per evaluation, not shared between calls", async () => {
    const dns = withRecord("v=spf1 a a a a a a a a a a ip4:192.0.2.1 -all", {
      resolve4: () => Promise.resolve(["198.51.100.1"]),
    });
    expect((await checkHost(INPUT, { resolver: dns })).result).toBe("pass");
    expect((await checkHost(INPUT, { resolver: dns })).result).toBe("pass");
  });

  test("the reason names the matching term", async () => {
    const dns = withRecord("v=spf1 ip4:192.0.2.0/24 -all");
    expect(await checkHost(INPUT, { resolver: dns })).toEqual({
      result: "pass",
      reason: "ip4:192.0.2.0/24 matched at example.com",
    });
  });
});
