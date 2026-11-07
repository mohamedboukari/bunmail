import { describe, test, expect } from "bun:test";
import {
  decideDaneHost,
  resolveDaneRoute,
} from "../../src/modules/emails/services/dane.ts";
import type { SecureMx } from "../../src/modules/emails/types/dane.types.ts";
import { parseServer } from "../../src/utils/dns-transport.ts";
import type { SecureLookupOptions } from "../../src/utils/dns-secure.ts";
import {
  aRecord,
  cnameRecord,
  mxRecord,
  secureZoneHandler,
  tlsaRecord,
  useFakeDns,
  type SecureZoneAnswer,
} from "../fake-dns.ts";

/**
 * Where DANE applies (#345, RFC 7672 section 2, `dane.ts`), against a fake
 * validating resolver: the domain's MX lookup (secure, insecure, failed,
 * implicit, aliased) and each MX host's decision (addresses first, then
 * TLSA at the candidate base domains; denials, insecure answers, lookup
 * failures, unusable records, CNAME base domains). No real DNS.
 */

const fake = useFakeDns();

/** Options aimed at the fake resolver, with short timeouts. */
function options(): SecureLookupOptions {
  const resolver = parseServer(fake.dns.server);
  if (resolver === null) throw new Error("bad fake server address");
  return { resolver, attemptTimeoutMs: 300, timeoutMs: 1_500 };
}

/** Serves `zone` (keys `"<name> <TYPE>"`); anything else a signed NXDOMAIN. */
function serve(zone: Record<string, SecureZoneAnswer>): void {
  fake.serve(secureZoneHandler(zone));
}

const SHA256 = new Uint8Array(32).fill(7);

/** The names queried, as `"<name> <qtype>"`. */
function asked(): string[] {
  return fake.dns.queries.map((q) => `${q.name} ${q.qtype}`);
}

describe("resolveDaneRoute: the MX lookup (RFC 7672 2.2.1)", () => {
  test("a secure MX RRset: DANE applies, hosts in preference order", async () => {
    serve({
      "example.org MX": {
        answers: [mxRecord(20, "mx2.example.org"), mxRecord(10, "mx1.example.org")],
      },
    });
    expect(await resolveDaneRoute("Example.ORG.", options())).toEqual({
      route: {
        kind: "hosts",
        hosts: ["mx1.example.org", "mx2.example.org"],
        implicit: false,
      },
      secureMx: {
        nextHop: "example.org",
        expandedNextHop: "example.org",
        implicit: false,
      },
    });
  });

  test("an insecure MX RRset: same route, no DANE", async () => {
    serve({ "example.org MX": { answers: [mxRecord(10, "mx.example.org")], ad: false } });
    expect(await resolveDaneRoute("example.org", options())).toEqual({
      route: { kind: "hosts", hosts: ["mx.example.org"], implicit: false },
      secureMx: null,
    });
  });

  test("an aliased next-hop domain: the expanded name is kept", async () => {
    serve({
      "example.org MX": {
        answers: [
          cnameRecord("mail.example.net"),
          mxRecord(10, "mx.example.net", "mail.example.net"),
        ],
      },
    });
    const route = await resolveDaneRoute("example.org", options());
    expect(route.secureMx).toEqual({
      nextHop: "example.org",
      expandedNextHop: "mail.example.net",
      implicit: false,
    });
  });

  test("a failed MX lookup delays delivery, never another source", async () => {
    serve({ "example.org MX": { rcode: 2, ad: false } });
    expect(await resolveDaneRoute("example.org", options())).toEqual({
      route: {
        kind: "retry",
        error: "example.org: DANE: MX lookup failed (ESERVFAIL); will retry",
      },
      secureMx: null,
    });
  });

  test("NXDOMAIN and a null MX are terminal", async () => {
    serve({ "nullmx.example MX": { answers: [mxRecord(0, ".")] } });
    expect((await resolveDaneRoute("nowhere.example", options())).route.kind).toBe(
      "failed",
    );
    expect((await resolveDaneRoute("nullmx.example", options())).route).toEqual({
      kind: "failed",
      error: "nullmx.example: domain does not accept mail (null MX)",
    });
  });

  test("no MX records, securely denied: the implicit MX, under DANE", async () => {
    serve({
      "example.org MX": { answers: [] },
      "example.org A": { answers: [aRecord("192.0.2.1")] },
      "example.org AAAA": { answers: [] },
    });
    expect(await resolveDaneRoute("example.org", options())).toEqual({
      route: { kind: "hosts", hosts: ["example.org"], implicit: true },
      secureMx: {
        nextHop: "example.org",
        expandedNextHop: "example.org",
        implicit: true,
      },
    });
  });

  test("no MX records, insecurely: the implicit MX, no DANE", async () => {
    serve({
      "example.org MX": { answers: [], ad: false },
      "example.org A": { answers: [aRecord("192.0.2.1")], ad: false },
      "example.org AAAA": { answers: [], ad: false },
    });
    expect((await resolveDaneRoute("example.org", options())).secureMx).toBeNull();
  });

  test("implicit MX, insecure: one family answering is enough, as without DANE", async () => {
    serve({
      "example.org MX": { answers: [], ad: false },
      "example.org A": { answers: [aRecord("192.0.2.1")], ad: false },
      "example.org AAAA": { rcode: 2, ad: false },
    });
    expect(await resolveDaneRoute("example.org", options())).toEqual({
      route: { kind: "hosts", hosts: ["example.org"], implicit: true },
      secureMx: null,
    });
  });

  test("implicit MX, insecure: a failure with no address at all is retried", async () => {
    serve({
      "example.org MX": { answers: [], ad: false },
      "example.org A": { rcode: 2, ad: false },
      "example.org AAAA": { answers: [], ad: false },
    });
    expect((await resolveDaneRoute("example.org", options())).route.kind).toBe("retry");
  });

  test("implicit MX, secure denial: any failed address lookup is retried (RFC 7672 2.1.2)", async () => {
    serve({
      "example.org MX": { answers: [] },
      "example.org A": { answers: [aRecord("192.0.2.1")] },
      "example.org AAAA": { rcode: 2, ad: false },
    });
    expect(await resolveDaneRoute("example.org", options())).toEqual({
      route: {
        kind: "retry",
        error: "example.org: address lookup failed temporarily (ESERVFAIL); will retry",
      },
      secureMx: null,
    });
  });

  test("no MX and no address records: terminal", async () => {
    serve({
      "example.org MX": { answers: [] },
      "example.org A": { answers: [] },
      "example.org AAAA": { answers: [] },
    });
    expect((await resolveDaneRoute("example.org", options())).route.kind).toBe("failed");
  });
});

const SECURE_MX: SecureMx = {
  nextHop: "example.org",
  expandedNextHop: "example.org",
  implicit: false,
};

describe("decideDaneHost: one MX host (RFC 7672 2.2.2, 2.2.3)", () => {
  test("secure addresses and secure TLSA records: DANE, base domain the host", async () => {
    serve({
      "mx.example.org A": { answers: [aRecord("192.0.2.1")] },
      "mx.example.org AAAA": { answers: [] },
      "_25._tcp.mx.example.org TLSA": { answers: [tlsaRecord(3, 1, 1, SHA256)] },
    });
    const decision = await decideDaneHost("mx.example.org", SECURE_MX, 25, options());
    expect(decision).toEqual({
      kind: "dane",
      addresses: ["192.0.2.1"],
      host: {
        mxHost: "mx.example.org",
        baseDomain: "mx.example.org",
        referenceIds: ["mx.example.org", "example.org"],
        records: [{ usage: 3, selector: 1, matchingType: 1, data: SHA256 }],
        usable: [{ usage: 3, selector: 1, matchingType: 1, data: SHA256 }],
      },
    });
    /** Addresses before TLSA (2.2.2). */
    expect(asked().at(-1)).toBe("_25._tcp.mx.example.org 52");
  });

  test("the TLSA name carries the port connected to", async () => {
    serve({
      "mx.example.org A": { answers: [aRecord("192.0.2.1")] },
      "mx.example.org AAAA": { answers: [] },
      "_2525._tcp.mx.example.org TLSA": { answers: [tlsaRecord(3, 1, 1, SHA256)] },
    });
    expect(
      (await decideDaneHost("mx.example.org", SECURE_MX, 2525, options())).kind,
    ).toBe("dane");
  });

  test("a secure denial of TLSA, or an insecure TLSA RRset: no DANE for the host", async () => {
    serve({
      "mx.example.org A": { answers: [aRecord("192.0.2.1")] },
      "mx.example.org AAAA": { answers: [] },
      "_25._tcp.mx.example.org TLSA": { answers: [] },
    });
    expect(await decideDaneHost("mx.example.org", SECURE_MX, 25, options())).toEqual({
      kind: "none",
      addresses: ["192.0.2.1"],
    });
    serve({
      "mx.example.org A": { answers: [aRecord("192.0.2.1")] },
      "mx.example.org AAAA": { answers: [] },
      "_25._tcp.mx.example.org TLSA": {
        answers: [tlsaRecord(3, 1, 1, SHA256)],
        ad: false,
      },
    });
    expect((await decideDaneHost("mx.example.org", SECURE_MX, 25, options())).kind).toBe(
      "none",
    );
  });

  test("insecure addresses: no DANE, and no TLSA query at all", async () => {
    serve({
      "mx.example.org A": { answers: [aRecord("192.0.2.1")], ad: false },
      "mx.example.org AAAA": { answers: [] },
    });
    expect((await decideDaneHost("mx.example.org", SECURE_MX, 25, options())).kind).toBe(
      "none",
    );
    expect(asked().some((q) => q.endsWith(" 52"))).toBe(false);
  });

  test("a failed address or TLSA lookup makes the host unusable, never 'no DANE'", async () => {
    serve({
      "mx.example.org A": { rcode: 2, ad: false },
      "mx.example.org AAAA": { answers: [] },
    });
    expect(await decideDaneHost("mx.example.org", SECURE_MX, 25, options())).toEqual({
      kind: "skip",
      reason: "address lookup failed (ESERVFAIL)",
      lookupFailed: true,
    });
    serve({
      "mx.example.org A": { answers: [aRecord("192.0.2.1")] },
      "mx.example.org AAAA": { answers: [] },
      "_25._tcp.mx.example.org TLSA": { rcode: 2, ad: false },
    });
    expect(await decideDaneHost("mx.example.org", SECURE_MX, 25, options())).toEqual({
      kind: "skip",
      reason: "TLSA lookup failed (ESERVFAIL)",
      lookupFailed: true,
    });
  });

  test("no address records: unreachable, not a lookup failure", async () => {
    serve({
      "mx.example.org A": { answers: [] },
      "mx.example.org AAAA": { answers: [] },
    });
    expect(await decideDaneHost("mx.example.org", SECURE_MX, 25, options())).toEqual({
      kind: "skip",
      reason: "no address records",
      lookupFailed: false,
    });
  });

  test("records present but none usable: DANE with no usable record (TLS required)", async () => {
    serve({
      "mx.example.org A": { answers: [aRecord("192.0.2.1")] },
      "mx.example.org AAAA": { answers: [] },
      "_25._tcp.mx.example.org TLSA": {
        answers: [
          tlsaRecord(1, 1, 1, SHA256),
          tlsaRecord(3, 1, 1, SHA256.subarray(0, 20)),
        ],
      },
    });
    const decision = await decideDaneHost("mx.example.org", SECURE_MX, 25, options());
    expect(decision.kind === "dane" && decision.host.records.length).toBe(2);
    expect(decision.kind === "dane" && decision.host.usable).toEqual([]);
  });

  describe("an aliased MX host (the RFC 7672 3.2.2 example)", () => {
    test("secure expansion: the expanded name first", async () => {
      serve({
        "mx20.example.com A": {
          answers: [
            cnameRecord("mxbackup.example.net"),
            aRecord("198.51.100.20", "mxbackup.example.net"),
          ],
        },
        "mx20.example.com AAAA": { answers: [cnameRecord("mxbackup.example.net")] },
        "mxbackup.example.net AAAA": { answers: [] },
        "_25._tcp.mxbackup.example.net TLSA": { answers: [tlsaRecord(2, 0, 1, SHA256)] },
      });
      const decision = await decideDaneHost("mx20.example.com", SECURE_MX, 25, options());
      expect(decision.kind === "dane" && decision.host.baseDomain).toBe(
        "mxbackup.example.net",
      );
      expect(decision.kind === "dane" && decision.host.referenceIds).toEqual([
        "mxbackup.example.net",
        "example.org",
      ]);
    });

    test("secure expansion without TLSA there: the host name is tried next", async () => {
      serve({
        "mx15.example.com A": {
          answers: [
            cnameRecord("mxbackup.example.com"),
            aRecord("192.0.2.15", "mxbackup.example.com"),
          ],
        },
        "mx15.example.com AAAA": { answers: [cnameRecord("mxbackup.example.com")] },
        "mxbackup.example.com AAAA": { answers: [] },
        "_25._tcp.mx15.example.com TLSA": { answers: [tlsaRecord(2, 0, 1, SHA256)] },
      });
      const decision = await decideDaneHost("mx15.example.com", SECURE_MX, 25, options());
      expect(decision.kind === "dane" && decision.host.baseDomain).toBe(
        "mx15.example.com",
      );
    });

    test("insecure expansion, secure CNAME: only the host name is a candidate", async () => {
      serve({
        "mx.example.org A": {
          answers: [
            cnameRecord("host.provider.example"),
            aRecord("192.0.2.9", "host.provider.example"),
          ],
          ad: false,
        },
        "mx.example.org AAAA": { answers: [], ad: false },
        "mx.example.org CNAME": { answers: [cnameRecord("host.provider.example")] },
        "_25._tcp.mx.example.org TLSA": { answers: [tlsaRecord(3, 1, 1, SHA256)] },
      });
      const decision = await decideDaneHost("mx.example.org", SECURE_MX, 25, options());
      expect(decision.kind === "dane" && decision.host.baseDomain).toBe("mx.example.org");
      expect(asked()).not.toContain("_25._tcp.host.provider.example 52");
    });

    test("insecure expansion and insecure CNAME: no DANE", async () => {
      serve({
        "mx.example.org A": {
          answers: [
            cnameRecord("host.provider.example"),
            aRecord("192.0.2.9", "host.provider.example"),
          ],
          ad: false,
        },
        "mx.example.org AAAA": { answers: [], ad: false },
        "mx.example.org CNAME": {
          answers: [cnameRecord("host.provider.example")],
          ad: false,
        },
      });
      expect(
        (await decideDaneHost("mx.example.org", SECURE_MX, 25, options())).kind,
      ).toBe("none");
    });
  });

  test("reference identifiers: base domain, next hop and the expanded next hop", async () => {
    serve({
      "mx.example.net A": { answers: [aRecord("192.0.2.1")] },
      "mx.example.net AAAA": { answers: [] },
      "_25._tcp.mx.example.net TLSA": { answers: [tlsaRecord(2, 0, 1, SHA256)] },
    });
    const aliased: SecureMx = {
      nextHop: "exchange.example.org",
      expandedNextHop: "example.com",
      implicit: false,
    };
    const decision = await decideDaneHost("mx.example.net", aliased, 25, options());
    expect(decision.kind === "dane" && decision.host.referenceIds).toEqual([
      "mx.example.net",
      "exchange.example.org",
      "example.com",
    ]);
  });
});
