import { describe, test, expect } from "bun:test";
import {
  dottedName,
  ipv6,
  parseDnsResponse,
  tlsaPresentation,
} from "../../src/utils/dns-rdata.ts";
import {
  TYPE_A,
  TYPE_AAAA,
  TYPE_CNAME,
  TYPE_MX,
  TYPE_TLSA,
  encodeQuery,
  type DnsQuestion,
} from "../../src/utils/dns-wire.ts";
import {
  aRecord,
  aaaaRecord,
  buildResponse,
  cnameRecord,
  encodeName,
  mxRecord,
  optRecord,
  seededRandom,
  tlsaRecord,
  type FakeDnsQuery,
} from "../fake-dns.ts";

/**
 * The DNSSEC-aware side of the DNS wire format (#345, DANE): the AD bit in
 * the query (RFC 6840 section 5.7) and in the answer, and the RDATA of A,
 * AAAA, MX, CNAME and TLSA, parsed strictly (`src/utils/dns-rdata.ts` on
 * top of `dns-wire.ts`). No sockets.
 */

/** A question of `qtype` for `name`. */
function question(name: string, qtype: number, id = 0x4242): DnsQuestion {
  return { id, labels: name.split("."), qtype };
}

/** The fake-server view of `q`, to build responses with. */
function fakeQuery(q: DnsQuestion): FakeDnsQuery {
  return {
    id: q.id,
    name: q.labels.join("."),
    qtype: q.qtype,
    qclass: 1,
    flags: 0x0120,
    additionalCount: 1,
    ednsPayload: 1232,
    transport: "udp",
    clientPort: 0,
    raw: new Uint8Array(0),
  };
}

describe("encodeQuery: DNSSEC-aware questions", () => {
  test("a typed question sets RD and AD, never CD, and carries its QTYPE", () => {
    const q = question("_25._tcp.mx.example.org", TYPE_TLSA);
    const bytes = encodeQuery(q);
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(2)).toBe(0x0120);
    expect(view.getUint16(2) & 0x0010).toBe(0);
    /** QTYPE right after the name: 12 header bytes + the encoded name. */
    const nameEnd = 12 + encodeName("_25._tcp.mx.example.org").length;
    expect(view.getUint16(nameEnd)).toBe(TYPE_TLSA);
    expect(view.getUint16(nameEnd + 2)).toBe(1);
  });

  test("a TXT question keeps RD only", () => {
    const bytes = encodeQuery({ id: 1, labels: ["example", "com"] });
    expect(new DataView(bytes.buffer).getUint16(2)).toBe(0x0100);
  });
});

describe("parseDnsResponse: records and the AD bit", () => {
  test("A records, AD set", () => {
    const q = question("mx.example.org", TYPE_A);
    const outcome = parseDnsResponse(
      buildResponse(fakeQuery(q), {
        ad: true,
        answers: [aRecord("192.0.2.1"), aRecord("192.0.2.2")],
        additional: [optRecord()],
      }),
      q,
    );
    expect(outcome).toEqual({
      kind: "answer",
      nxdomain: false,
      authenticated: true,
      records: [
        { type: "A", address: "192.0.2.1" },
        { type: "A", address: "192.0.2.2" },
      ],
      chain: [["mx", "example", "org"]],
    });
  });

  test("AAAA records in RFC 5952 form, AD clear", () => {
    const q = question("mx.example.org", TYPE_AAAA);
    const bytes = new Uint8Array(16);
    bytes.set([0x20, 0x01, 0x0d, 0xb8], 0);
    bytes[15] = 1;
    const outcome = parseDnsResponse(
      buildResponse(fakeQuery(q), { answers: [aaaaRecord(bytes)] }),
      q,
    );
    expect(outcome.kind === "answer" && outcome.authenticated).toBe(false);
    expect(outcome.kind === "answer" && outcome.records).toEqual([
      { type: "AAAA", address: "2001:db8::1" },
    ]);
  });

  test("MX records with compressed exchanges", () => {
    const q = question("example.org", TYPE_MX);
    const response = buildResponse(fakeQuery(q), {
      ad: true,
      answers: [mxRecord(10, "mx1.example.org"), mxRecord(20, "mx2.example.org")],
    });
    /** Rewrite the second exchange's "example.org" as a pointer to the question's (offset 12 + 0). */
    const outcome = parseDnsResponse(response, q);
    expect(outcome.kind === "answer" && outcome.records).toEqual([
      { type: "MX", preference: 10, exchange: ["mx1", "example", "org"] },
      { type: "MX", preference: 20, exchange: ["mx2", "example", "org"] },
    ]);
    /** A pointer inside the MX RDATA to the question name is followed. */
    const compressed = buildResponse(fakeQuery(q), {
      answers: [{ name: null, type: TYPE_MX, rdata: Uint8Array.from([0, 5, 0xc0, 12]) }],
    });
    const parsed = parseDnsResponse(compressed, q);
    expect(parsed.kind === "answer" && parsed.records).toEqual([
      { type: "MX", preference: 5, exchange: ["example", "org"] },
    ]);
  });

  test("a null MX has an empty exchange", () => {
    const q = question("example.org", TYPE_MX);
    const outcome = parseDnsResponse(
      buildResponse(fakeQuery(q), { answers: [mxRecord(0, ".")] }),
      q,
    );
    expect(outcome.kind === "answer" && outcome.records).toEqual([
      { type: "MX", preference: 0, exchange: [] },
    ]);
  });

  test("TLSA records keep usage, selector, matching type and data", () => {
    const q = question("_25._tcp.mx.example.org", TYPE_TLSA);
    const data = Uint8Array.from({ length: 32 }, (_v, i) => i);
    const outcome = parseDnsResponse(
      buildResponse(fakeQuery(q), { ad: true, answers: [tlsaRecord(3, 1, 1, data)] }),
      q,
    );
    expect(outcome.kind === "answer" && outcome.records).toEqual([
      { type: "TLSA", usage: 3, selector: 1, matchingType: 1, data },
    ]);
  });

  test("a CNAME chain: the target's records, the chain in order", () => {
    const q = question("mx.example.org", TYPE_A);
    const outcome = parseDnsResponse(
      buildResponse(fakeQuery(q), {
        ad: true,
        answers: [
          cnameRecord("mid.example.net"),
          cnameRecord("end.example.com", "mid.example.net"),
          aRecord("198.51.100.7", "end.example.com"),
        ],
      }),
      q,
    );
    expect(outcome.kind === "answer" && outcome.chain).toEqual([
      ["mx", "example", "org"],
      ["mid", "example", "net"],
      ["end", "example", "com"],
    ]);
    expect(outcome.kind === "answer" && outcome.records).toEqual([
      { type: "A", address: "198.51.100.7" },
    ]);
  });

  test("a CNAME query keeps only the name's own CNAME", () => {
    const q = question("mx.example.org", TYPE_CNAME);
    const outcome = parseDnsResponse(
      buildResponse(fakeQuery(q), {
        ad: true,
        answers: [
          cnameRecord("mid.example.net"),
          cnameRecord("end.example.com", "mid.example.net"),
        ],
      }),
      q,
    );
    expect(outcome.kind === "answer" && outcome.records).toEqual([
      { type: "CNAME", target: ["mid", "example", "net"] },
    ]);
  });

  test("records of another owner or type are not ours", () => {
    const q = question("mx.example.org", TYPE_A);
    const outcome = parseDnsResponse(
      buildResponse(fakeQuery(q), {
        answers: [aRecord("192.0.2.9", "other.example.org"), mxRecord(1, "x.example")],
      }),
      q,
    );
    expect(outcome.kind === "answer" && outcome.records).toEqual([]);
  });
});

describe("parseDnsResponse: denials and errors", () => {
  test("NXDOMAIN with AD is an authenticated denial, not an error", () => {
    const q = question("nope.example.org", TYPE_A);
    expect(
      parseDnsResponse(buildResponse(fakeQuery(q), { rcode: 3, ad: true }), q),
    ).toEqual({
      kind: "answer",
      nxdomain: true,
      authenticated: true,
      records: [],
      chain: [["nope", "example", "org"]],
    });
  });

  test("NODATA keeps its AD bit", () => {
    const q = question("_25._tcp.mx.example.org", TYPE_TLSA);
    const outcome = parseDnsResponse(buildResponse(fakeQuery(q), { ad: false }), q);
    expect(outcome).toMatchObject({
      kind: "answer",
      nxdomain: false,
      authenticated: false,
      records: [],
    });
  });

  test("SERVFAIL is ESERVFAIL whatever the AD bit", () => {
    const q = question("mx.example.org", TYPE_A);
    expect(
      parseDnsResponse(buildResponse(fakeQuery(q), { rcode: 2, ad: true }), q),
    ).toEqual({ kind: "error", code: "ESERVFAIL" });
  });

  test("an answer to another type is not ours", () => {
    const q = question("mx.example.org", TYPE_A);
    const response = buildResponse(fakeQuery(q), {
      question: { name: "mx.example.org", type: TYPE_AAAA },
    });
    expect(parseDnsResponse(response, q)).toEqual({ kind: "mismatch" });
  });

  test("TC set asks for TCP", () => {
    const q = question("mx.example.org", TYPE_A);
    expect(parseDnsResponse(buildResponse(fakeQuery(q), { tc: true }), q)).toEqual({
      kind: "truncated",
    });
  });
});

describe("parseDnsResponse: malformed RDATA rejects the response", () => {
  const cases: [string, number, Uint8Array][] = [
    ["A of 3 bytes", TYPE_A, Uint8Array.from([1, 2, 3])],
    ["A of 5 bytes", TYPE_A, Uint8Array.from([1, 2, 3, 4, 5])],
    ["AAAA of 4 bytes", TYPE_AAAA, Uint8Array.from([1, 2, 3, 4])],
    ["MX without a name", TYPE_MX, Uint8Array.from([0, 10])],
    ["MX with bytes past the name", TYPE_MX, Uint8Array.from([0, 10, 0, 9])],
    ["MX name running past RDATA", TYPE_MX, Uint8Array.from([0, 10, 5, 0x61])],
    ["TLSA of 2 bytes", TYPE_TLSA, Uint8Array.from([3, 1])],
    ["MX pointing forwards", TYPE_MX, Uint8Array.from([0, 10, 0xc0, 0xff])],
    ["MX pointing into the header", TYPE_MX, Uint8Array.from([0, 10, 0xc0, 2])],
  ];
  for (const [label, qtype, rdata] of cases) {
    test(label, () => {
      const q = question("example.org", qtype);
      const outcome = parseDnsResponse(
        buildResponse(fakeQuery(q), { answers: [{ name: null, type: qtype, rdata }] }),
        q,
      );
      expect(outcome).toEqual({ kind: "error", code: "EBADRESP" });
    });
  }

  test("an RDLENGTH past the end of the message", () => {
    const q = question("example.org", TYPE_A);
    const outcome = parseDnsResponse(
      buildResponse(fakeQuery(q), {
        answers: [
          {
            name: null,
            type: TYPE_A,
            rdata: Uint8Array.from([1, 2, 3, 4]),
            rdlength: 40,
          },
        ],
      }),
      q,
    );
    expect(outcome).toEqual({ kind: "error", code: "EBADRESP" });
  });

  test("every truncation of a valid answer parses without throwing", () => {
    const q = question("_25._tcp.mx.example.org", TYPE_TLSA);
    const valid = buildResponse(fakeQuery(q), {
      ad: true,
      answers: [
        cnameRecord("t.example.net"),
        tlsaRecord(2, 0, 1, new Uint8Array(32), "t.example.net"),
      ],
      additional: [optRecord()],
    });
    for (let length = 0; length < valid.length; length++) {
      const outcome = parseDnsResponse(valid.subarray(0, length), q);
      expect(["mismatch", "error"]).toContain(outcome.kind);
    }
  });

  test("random mutations never throw (fixed seed)", () => {
    const q = question("example.org", TYPE_MX);
    const valid = buildResponse(fakeQuery(q), {
      ad: true,
      answers: [mxRecord(10, "mx.example.org"), mxRecord(20, "mx2.example.org")],
    });
    const random = seededRandom(345);
    for (let i = 0; i < 2_000; i++) {
      const bytes = Uint8Array.from(valid);
      bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
      const outcome = parseDnsResponse(bytes, q);
      expect(["mismatch", "truncated", "answer", "error"]).toContain(outcome.kind);
    }
  });
});

describe("helpers", () => {
  test("ipv6 follows RFC 5952", () => {
    const from = (groups: number[]): Uint8Array => {
      const bytes = new Uint8Array(16);
      groups.forEach((group, i) => {
        bytes[i * 2] = group >> 8;
        bytes[i * 2 + 1] = group & 0xff;
      });
      return bytes;
    };
    expect(ipv6(from([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]))).toBe("2001:db8::1");
    expect(ipv6(from([0x2001, 0xdb8, 0, 1, 0, 0, 0, 1]))).toBe("2001:db8:0:1::1");
    expect(ipv6(from([0x2001, 0, 0, 1, 0, 0, 1, 1]))).toBe("2001::1:0:0:1:1");
    expect(ipv6(from([0, 0, 0, 0, 0, 0, 0, 0]))).toBe("::");
    expect(ipv6(from([0x2001, 0xdb8, 1, 2, 3, 4, 5, 0]))).toBe("2001:db8:1:2:3:4:5:0");
    expect(ipv6(from([0, 0, 0, 0, 0, 0xffff, 0xc000, 0x201]))).toBe("::ffff:c000:201");
  });

  test("dottedName refuses labels a host name cannot hold", () => {
    expect(dottedName(["mx", "example", "org"])).toBe("mx.example.org");
    expect(dottedName([])).toBe("");
    expect(dottedName(["a.b", "example"])).toBeNull();
    expect(dottedName(["a b", "example"])).toBeNull();
    expect(dottedName(["a\\b", "example"])).toBeNull();
  });

  test("tlsaPresentation writes the RFC 6698 presentation form", () => {
    expect(
      tlsaPresentation({
        usage: 3,
        selector: 1,
        matchingType: 1,
        data: Uint8Array.from([0xab, 0x01]),
      }),
    ).toBe("3 1 1 AB01");
  });
});
