import { describe, test, expect } from "bun:test";
import { queryTcp, resolveTxtRecords } from "../../src/utils/dns-txt.ts";
import { encodeQuery } from "../../src/utils/dns-wire.ts";
import {
  CLASS_IN,
  TYPE_CNAME,
  buildResponse,
  encodeName,
  optRecord,
  startFakeDns,
  txt,
  txtRdata,
  useFakeDns,
  zoneHandler,
  type FakeDnsQuery,
} from "../fake-dns.ts";

/**
 * The TXT resolver (`src/utils/dns-txt.ts`) against a fake DNS server on
 * 127.0.0.1 (`test/fake-dns.ts`): record boundaries (the Bun bug it works
 * around, oven-sh/bun#44692), the query, `node:dns` error codes, server
 * failover and budgets, replies without a question and the FORMERR retry
 * without EDNS0. TCP, spoofing and malformed answers are in
 * `dns-txt-hardening.test.ts`, the parser alone in `dns-wire.test.ts`. No
 * real DNS.
 */

const fake = useFakeDns();
const { options, serve, lookupError } = fake;

describe("resolveTxtRecords: record boundaries", () => {
  test("one record of one string", async () => {
    serve(zoneHandler({ "example.com": [["v=spf1 -all"]] }));
    expect(await resolveTxtRecords("example.com", options())).toEqual([["v=spf1 -all"]]);
  });

  test("one record of two strings stays one record (the Bun bug)", async () => {
    serve(zoneHandler({ "example.com": [["s1", "s2"]] }));
    expect(await resolveTxtRecords("example.com", options())).toEqual([["s1", "s2"]]);
  });

  test("a 2048-bit DKIM key published as 255 + 155 characters", async () => {
    const first = "a".repeat(255);
    const second = "b".repeat(155);
    serve(zoneHandler({ "bunmail._domainkey.example.com": [[first, second]] }));
    const records = await resolveTxtRecords("bunmail._domainkey.example.com", options());
    expect(records.map((strings) => strings.map((text) => text.length))).toEqual([
      [255, 155],
    ]);
  });

  test("several records keep their order and their own strings", async () => {
    serve(
      zoneHandler({
        "example.com": [
          ["v=spf1 ", "-all"],
          ["google-site-verification=x"],
          ["a", "b", "c"],
        ],
      }),
    );
    expect(await resolveTxtRecords("example.com", options())).toEqual([
      ["v=spf1 ", "-all"],
      ["google-site-verification=x"],
      ["a", "b", "c"],
    ]);
  });

  test("an empty string is a record of one empty string", async () => {
    serve(zoneHandler({ "example.com": [[""], ["", "x"]] }));
    expect(await resolveTxtRecords("example.com", options())).toEqual([[""], ["", "x"]]);
  });

  test("bytes are decoded as latin1, one character per byte, like Node", async () => {
    serve(zoneHandler({ "example.com": [["café ÿ"]] }));
    expect(await resolveTxtRecords("example.com", options())).toEqual([["café ÿ"]]);
  });

  test("a CNAME in the answer leads to the TXT records of its target", async () => {
    serve((query) => [
      buildResponse(query, {
        answers: [
          { name: null, type: TYPE_CNAME, rdata: encodeName("target.example.net") },
          { name: "target.example.net", rdata: txtRdata("v=DMARC1; ", "p=reject") },
        ],
      }),
    ]);
    expect(await resolveTxtRecords("_dmarc.example.com", options())).toEqual([
      ["v=DMARC1; ", "p=reject"],
    ]);
  });

  test("TXT records of an unrelated owner are ignored", async () => {
    serve((query) => [
      buildResponse(query, {
        answers: [
          { name: "other.example.net", rdata: txtRdata("injected") },
          txt("ours"),
        ],
      }),
    ]);
    expect(await resolveTxtRecords("example.com", options())).toEqual([["ours"]]);
  });

  test("a trailing dot and any letter case ask the same name", async () => {
    serve(zoneHandler({ "example.com": [["x"]] }));
    expect(await resolveTxtRecords("Example.COM.", options())).toEqual([["x"]]);
  });

  test("an echo of the question in another letter case is accepted", async () => {
    serve((query) => [
      buildResponse(query, {
        question: { name: query.name.toUpperCase() },
        answers: [txt("x")],
      }),
    ]);
    expect(await resolveTxtRecords("example.com", options())).toEqual([["x"]]);
  });

  test("concurrent lookups each get their own answer", async () => {
    const zone = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`n${i}.example.com`, [[`value-${i}`]]]),
    );
    serve(zoneHandler(zone));
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        resolveTxtRecords(`n${i}.example.com`, options()),
      ),
    );
    expect(answers).toEqual(Array.from({ length: 20 }, (_, i) => [[`value-${i}`]]));
  });
});

describe("resolveTxtRecords: the query", () => {
  test("TXT IN with RD, EDNS0 advertising 1232 bytes, and a fresh ID each time", async () => {
    serve(zoneHandler({ "example.com": [["x"]] }));
    for (let i = 0; i < 8; i++) await resolveTxtRecords("example.com", options());
    const [first] = fake.dns.queries;
    expect(first?.qtype).toBe(16);
    expect(first?.qclass).toBe(CLASS_IN);
    expect((first?.flags ?? 0) & 0x0100).toBe(0x0100);
    expect(first?.additionalCount).toBe(1);
    expect(first?.ednsPayload).toBe(1232);
    expect(new Set(fake.dns.queries.map((query) => query.id)).size).toBeGreaterThan(1);
    expect(
      new Set(fake.dns.queries.map((query) => query.clientPort)).size,
    ).toBeGreaterThan(1);
  });

  test("names that cannot exist are ENOTFOUND, with no query sent", async () => {
    serve(zoneHandler({}));
    const invalid = [
      "",
      ".",
      "a..example.com",
      ".example.com",
      `${"a".repeat(64)}.com`,
      `${"a".repeat(60)}.`.repeat(4) + "a".repeat(10),
      "ex ample.com",
      "é.example.com",
      "a\\b.example.com",
      "tab\t.example.com",
    ];
    for (const name of invalid) {
      const error = await lookupError(name);
      expect(error.code).toBe("ENOTFOUND");
    }
    expect(fake.dns.queries).toHaveLength(0);
  });

  test("a 253-character name with 63-character labels is asked", async () => {
    const name = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(
      ".",
    );
    expect(name).toHaveLength(253);
    serve(zoneHandler({ [name]: [["ok"]] }));
    expect(await resolveTxtRecords(name, options())).toEqual([["ok"]]);
  });
});

describe("resolveTxtRecords: errors carry node:dns codes", () => {
  test("NXDOMAIN is ENOTFOUND, shaped like a node:dns error", async () => {
    serve(zoneHandler({}));
    const error = await lookupError("missing.example.com");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("ENOTFOUND");
    expect(error.syscall).toBe("queryTxt");
    expect(error.hostname).toBe("missing.example.com");
    expect(error.message).toBe("queryTxt ENOTFOUND missing.example.com");
  });

  test("NOERROR without a TXT record is ENODATA", async () => {
    serve((query) => [buildResponse(query, { additional: [optRecord()] })]);
    expect((await lookupError("example.com")).code).toBe("ENODATA");
  });

  test("NOERROR with only a CNAME is ENODATA", async () => {
    serve((query) => [
      buildResponse(query, {
        answers: [{ name: null, type: TYPE_CNAME, rdata: encodeName("t.example.net") }],
      }),
    ]);
    expect((await lookupError("example.com")).code).toBe("ENODATA");
  });

  test.each([
    [1, "EFORMERR"],
    [2, "ESERVFAIL"],
    [4, "ENOTIMP"],
    [5, "EREFUSED"],
    [9, "EBADRESP"],
  ])("RCODE %d is %s; a server that answered is not asked again", async (rcode, code) => {
    serve((query) => [buildResponse(query, { rcode })]);
    expect<string>((await lookupError("example.com")).code).toBe(code);
    /**
     * Two queries for EBADRESP (retried like a transport failure) and for
     * EFORMERR (asked once more without EDNS0), one for the others.
     */
    expect(fake.dns.queries).toHaveLength(
      code === "EBADRESP" || code === "EFORMERR" ? 2 : 1,
    );
  });

  test("an extended RCODE in the OPT record (BADVERS) is EBADRESP", async () => {
    serve((query) => [buildResponse(query, { additional: [optRecord(1)] })]);
    expect((await lookupError("example.com")).code).toBe("EBADRESP");
  });

  test("no answer is ETIMEOUT, after one retry, within the overall cap", async () => {
    serve(() => []);
    const started = Date.now();
    const error = await lookupError("example.com", {
      attemptTimeoutMs: 100,
      timeoutMs: 1_000,
    });
    expect(error.code).toBe("ETIMEOUT");
    expect(fake.dns.queries).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("the overall cap ends the lookup even with long attempts", async () => {
    serve(() => []);
    const started = Date.now();
    const error = await lookupError("example.com", {
      attemptTimeoutMs: 5_000,
      timeoutMs: 150,
    });
    expect(error.code).toBe("ETIMEOUT");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("no usable server is ECONNREFUSED", async () => {
    expect((await lookupError("example.com", { servers: [] })).code).toBe("ECONNREFUSED");
    expect((await lookupError("example.com", { servers: ["not a server"] })).code).toBe(
      "ECONNREFUSED",
    );
  });

  test("a server that answers SERVFAIL is skipped for the next one", async () => {
    const second = await startFakeDns(zoneHandler({ "example.com": [["second"]] }));
    try {
      serve((query) => [buildResponse(query, { rcode: 2 })]);
      expect(
        await resolveTxtRecords(
          "example.com",
          options({ servers: [fake.dns.server, second.server] }),
        ),
      ).toEqual([["second"]]);
    } finally {
      second.stop();
    }
  });

  test("an answered error is reported over a later timeout", async () => {
    const silent = await startFakeDns(() => []);
    try {
      serve((query) => [buildResponse(query, { rcode: 5 })]);
      const error = await lookupError("example.com", {
        servers: [fake.dns.server, silent.server],
        attemptTimeoutMs: 100,
      });
      expect(error.code).toBe("EREFUSED");
    } finally {
      silent.stop();
    }
  });

  test("a silent server is passed over for the next one", async () => {
    const second = await startFakeDns(zoneHandler({ "example.com": [["second"]] }));
    try {
      serve(() => []);
      expect(
        await resolveTxtRecords(
          "example.com",
          options({ servers: [fake.dns.server, second.server], attemptTimeoutMs: 100 }),
        ),
      ).toEqual([["second"]]);
    } finally {
      second.stop();
    }
  });
});

describe("resolveTxtRecords: unreachable servers and budgets", () => {
  test("a server with no route is skipped at once for the next one", async () => {
    /** Bun throws synchronously when it cannot connect a UDP socket (EHOSTUNREACH, EINVAL). */
    const second = await startFakeDns(zoneHandler({ "example.com": [["second"]] }));
    try {
      const started = Date.now();
      const records = await resolveTxtRecords(
        "example.com",
        options({ servers: ["fe80::1", second.server], attemptTimeoutMs: 300 }),
      );
      expect(records).toEqual([["second"]]);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      second.stop();
    }
  });

  test("the TCP retry gets only what is left of the attempt's budget", async () => {
    /**
     * UDP answers TC after 300 ms, TCP never answers, two rounds of one
     * attempt each: 2 x 400 ms. A fresh TCP budget would make it 2 x 700 ms.
     */
    serve((query) =>
      query.transport === "udp"
        ? [{ raw: buildResponse(query, { tc: true }), delayMs: 300 }]
        : [],
    );
    const started = Date.now();
    const error = await lookupError("example.com", {
      attemptTimeoutMs: 400,
      timeoutMs: 3_000,
    });
    expect(error.code).toBe("ETIMEOUT");
    expect(fake.dns.queries.filter((query) => query.transport === "tcp")).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(1_100);
  });

  test("a stalled TCP connect is abandoned at the attempt timeout", async () => {
    /** A non-routable address: the SYN goes unanswered (or the route is refused at once). */
    const question = { id: 1, labels: ["example", "com"] };
    const started = Date.now();
    const outcome = await queryTcp(
      { address: "10.255.255.1", port: 53, family: 4 },
      encodeQuery(question),
      question,
      150,
    );
    expect(
      outcome.kind === "error" &&
        (outcome.code === "ETIMEOUT" || outcome.code === "ECONNREFUSED"),
    ).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("resolveTxtRecords: replies without a question, and FORMERR", () => {
  /** A reply with our ID, QR set, QDCOUNT 0 and `rcode`, nothing else. */
  function questionless(query: FakeDnsQuery, rcode: number): Uint8Array {
    const bytes = new Uint8Array(12);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, query.id);
    view.setUint16(2, 0x8180 | rcode);
    return bytes;
  }

  test.each([
    [2, "ESERVFAIL"],
    [4, "ENOTIMP"],
    [5, "EREFUSED"],
  ])("RCODE %d without a question is %s at once", async (rcode, code) => {
    serve((query) => [questionless(query, rcode)]);
    const started = Date.now();
    expect<string>((await lookupError("example.com")).code).toBe(code);
    expect(Date.now() - started).toBeLessThan(300);
  });

  test("NOERROR or NXDOMAIN without a question is ignored", async () => {
    serve((query) => [questionless(query, 0), questionless(query, 3)]);
    expect((await lookupError("example.com", { attemptTimeoutMs: 100 })).code).toBe(
      "ETIMEOUT",
    );
  });

  test("FORMERR to a query with EDNS0: asked again without it, once", async () => {
    serve((query) =>
      query.ednsPayload === null
        ? [buildResponse(query, { answers: [txt("plain")] })]
        : [questionless(query, 1)],
    );
    expect(await resolveTxtRecords("example.com", options())).toEqual([["plain"]]);
    expect(fake.dns.queries.map((query) => query.ednsPayload)).toEqual([1232, null]);
    expect(fake.dns.queries[1]?.additionalCount).toBe(0);
  });

  test("FORMERR again without EDNS0 is EFORMERR", async () => {
    serve((query) => [buildResponse(query, { rcode: 1 })]);
    expect((await lookupError("example.com")).code).toBe("EFORMERR");
    expect(fake.dns.queries.map((query) => query.ednsPayload)).toEqual([1232, null]);
  });
});
