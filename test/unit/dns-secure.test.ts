import { describe, test, expect } from "bun:test";
import { parseServer } from "../../src/utils/dns-transport.ts";
import { lookupSecure, type SecureLookupOptions } from "../../src/utils/dns-secure.ts";
import {
  aRecord,
  buildResponse,
  cnameRecord,
  mxRecord,
  secureZoneHandler,
  tlsaRecord,
  useFakeDns,
} from "../fake-dns.ts";

/**
 * DNSSEC-aware lookups against the one trusted resolver (#345, DANE,
 * `src/utils/dns-secure.ts`), against a fake resolver on 127.0.0.1: the AD
 * bit read back, denials told apart from failures, spoofed answers
 * dropped, TCP after TC, SERVFAIL and timeouts as failures, and CNAME
 * chains the resolver did not finish followed. No real DNS.
 */

const fake = useFakeDns();

/** Options aimed at the fake resolver, with short timeouts. */
function options(): SecureLookupOptions {
  const resolver = parseServer(fake.dns.server);
  if (resolver === null) throw new Error("bad fake server address");
  return { resolver, attemptTimeoutMs: 300, timeoutMs: 1_200 };
}

describe("lookupSecure: the AD bit", () => {
  test("a validated answer is secure, and the query asked for AD", async () => {
    fake.serve(
      secureZoneHandler({
        "example.org MX": { answers: [mxRecord(10, "mx.example.org")] },
      }),
    );
    const answer = await lookupSecure("example.org", "MX", options());
    expect(answer).toEqual({
      kind: "records",
      secure: true,
      records: [{ type: "MX", preference: 10, exchange: ["mx", "example", "org"] }],
      name: "example.org",
      aliased: false,
    });
    expect(fake.dns.queries[0]?.flags).toBe(0x0120);
  });

  test("an unvalidated answer is insecure", async () => {
    fake.serve(
      secureZoneHandler({
        "mx.example.org A": { answers: [aRecord("192.0.2.1")], ad: false },
      }),
    );
    const answer = await lookupSecure("mx.example.org", "A", options());
    expect(answer.kind === "records" && answer.secure).toBe(false);
  });

  test("secure and insecure denials are answers, not failures", async () => {
    fake.serve(
      secureZoneHandler({
        "_25._tcp.mx.example.org TLSA": { answers: [] },
        "_25._tcp.mx.example.net TLSA": { answers: [], ad: false },
        "gone.example.org TLSA": { rcode: 3, ad: true },
      }),
    );
    expect(await lookupSecure("_25._tcp.mx.example.org", "TLSA", options())).toEqual({
      kind: "nodata",
      secure: true,
      name: "_25._tcp.mx.example.org",
      aliased: false,
    });
    expect((await lookupSecure("_25._tcp.mx.example.net", "TLSA", options())).kind).toBe(
      "nodata",
    );
    expect(await lookupSecure("gone.example.org", "TLSA", options())).toEqual({
      kind: "nxdomain",
      secure: true,
    });
  });
});

describe("lookupSecure: failures", () => {
  test("SERVFAIL (a bogus answer) is a failure, asked once", async () => {
    fake.serve(secureZoneHandler({ "example.org MX": { rcode: 2, ad: false } }));
    expect(await lookupSecure("example.org", "MX", options())).toEqual({
      kind: "failure",
      code: "ESERVFAIL",
    });
    expect(fake.dns.queries).toHaveLength(1);
  });

  test("no answer at all is a timeout, after a second attempt", async () => {
    fake.serve(secureZoneHandler({ "example.org MX": { silent: true } }));
    expect(await lookupSecure("example.org", "MX", options())).toEqual({
      kind: "failure",
      code: "ETIMEOUT",
    });
    expect(fake.dns.queries).toHaveLength(2);
  });

  test("a name that cannot be queried is an insecure NXDOMAIN, no query sent", async () => {
    fake.serve(() => []);
    expect(await lookupSecure("bad..name", "A", options())).toEqual({
      kind: "nxdomain",
      secure: false,
    });
    expect(fake.dns.queries).toHaveLength(0);
  });
});

describe("lookupSecure: spoof resistance and transport", () => {
  test("a forged answer with another ID is dropped, the real one taken", async () => {
    fake.serve((query) => [
      buildResponse(query, {
        id: (query.id + 1) & 0xffff,
        ad: true,
        answers: [aRecord("6.6.6.6")],
      }),
      buildResponse(query, { ad: false, answers: [aRecord("192.0.2.1")] }),
    ]);
    const answer = await lookupSecure("mx.example.org", "A", options());
    expect(answer).toMatchObject({
      kind: "records",
      secure: false,
      records: [{ type: "A", address: "192.0.2.1" }],
    });
  });

  test("an answer from another source port is ignored", async () => {
    const spoofer = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      socket: { error() {} },
    });
    try {
      fake.serve((query) => {
        spoofer.send(
          buildResponse(query, { ad: true, answers: [aRecord("6.6.6.6")] }),
          query.clientPort,
          "127.0.0.1",
        );
        return [];
      });
      expect(await lookupSecure("mx.example.org", "A", options())).toEqual({
        kind: "failure",
        code: "ETIMEOUT",
      });
    } finally {
      spoofer.close();
    }
  });

  test("TC set: the same question over TCP, AD read from the TCP answer", async () => {
    fake.serve((query) =>
      query.transport === "udp"
        ? [buildResponse(query, { tc: true })]
        : [
            buildResponse(query, {
              ad: true,
              answers: [tlsaRecord(3, 1, 1, new Uint8Array(32))],
            }),
          ],
    );
    const answer = await lookupSecure("_25._tcp.mx.example.org", "TLSA", options());
    expect(answer.kind === "records" && answer.secure).toBe(true);
    expect(fake.dns.queries.map((q) => q.transport)).toEqual(["udp", "tcp"]);
  });
});

describe("lookupSecure: CNAME chains (RFC 7672 2.1.3)", () => {
  test("a chain the resolver followed: the target's records, the expanded name", async () => {
    fake.serve(
      secureZoneHandler({
        "mx.example.org A": {
          answers: [
            cnameRecord("host.example.net"),
            aRecord("192.0.2.5", "host.example.net"),
          ],
        },
      }),
    );
    expect(await lookupSecure("mx.example.org", "A", options())).toEqual({
      kind: "records",
      secure: true,
      records: [{ type: "A", address: "192.0.2.5" }],
      name: "host.example.net",
      aliased: true,
    });
  });

  test("a chain cut short is asked again at its end; one insecure step makes it insecure", async () => {
    fake.serve(
      secureZoneHandler({
        "mx.example.org A": { answers: [cnameRecord("host.example.net")] },
        "host.example.net A": { answers: [aRecord("192.0.2.6")], ad: false },
      }),
    );
    const answer = await lookupSecure("mx.example.org", "A", options());
    expect(answer).toEqual({
      kind: "records",
      secure: false,
      records: [{ type: "A", address: "192.0.2.6" }],
      name: "host.example.net",
      aliased: true,
    });
    expect(fake.dns.queries.map((q) => q.name)).toEqual([
      "mx.example.org",
      "host.example.net",
    ]);
  });

  test("a CNAME query returns the name's own alias", async () => {
    fake.serve(
      secureZoneHandler({
        "mx.example.org CNAME": { answers: [cnameRecord("host.example.net")] },
      }),
    );
    const answer = await lookupSecure("mx.example.org", "CNAME", options());
    expect(answer).toMatchObject({
      kind: "records",
      secure: true,
      records: [{ type: "CNAME", target: ["host", "example", "net"] }],
    });
  });
});
