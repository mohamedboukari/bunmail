import { describe, test, expect } from "bun:test";
import { DnsTxtError, resolveTxtRecords } from "../../src/utils/dns-txt.ts";
import {
  buildResponse,
  encodeName,
  optRecord,
  seededRandom,
  txt,
  useFakeDns,
  type FakeDnsQuery,
} from "../fake-dns.ts";

/**
 * The TXT resolver's defences (`src/utils/dns-txt.ts`) against a fake DNS
 * server on 127.0.0.1 (`test/fake-dns.ts`): TCP fallback and reassembly,
 * spoof resistance (wrong ID, question, port, size), malformed answers,
 * and random datagrams with a fixed seed, which must end in a coded error
 * and never hang. No real DNS.
 */

const fake = useFakeDns();
const { options, serve, lookupError } = fake;

describe("resolveTxtRecords: TCP fallback", () => {
  test("TC set over UDP asks again over TCP and returns the full answer", async () => {
    serve((query) =>
      query.transport === "udp"
        ? [buildResponse(query, { tc: true })]
        : [buildResponse(query, { answers: [txt("x".repeat(255), "y".repeat(200))] })],
    );
    expect(await resolveTxtRecords("example.com", options())).toEqual([
      ["x".repeat(255), "y".repeat(200)],
    ]);
    expect(fake.dns.queries.map((query) => query.transport)).toEqual(["udp", "tcp"]);
  });

  test("errors over TCP keep their codes", async () => {
    serve((query) =>
      query.transport === "udp"
        ? [buildResponse(query, { tc: true })]
        : [buildResponse(query, { rcode: 3 })],
    );
    expect((await lookupError("example.com")).code).toBe("ENOTFOUND");
  });

  test.each([
    [
      "another ID",
      (query: FakeDnsQuery) => buildResponse(query, { id: (query.id + 1) & 0xffff }),
    ],
    ["TC again", (query: FakeDnsQuery) => buildResponse(query, { tc: true })],
    [
      "another question",
      (query: FakeDnsQuery) => buildResponse(query, { question: { name: "x.example" } }),
    ],
  ])("over TCP, %s is EBADRESP", async (_label, reply) => {
    serve((query) => [
      query.transport === "udp" ? buildResponse(query, { tc: true }) : reply(query),
    ]);
    expect((await lookupError("example.com")).code).toBe("EBADRESP");
  });

  test("bytes past the TCP message are EBADRESP", async () => {
    serve((query) => {
      if (query.transport === "udp") return [buildResponse(query, { tc: true })];
      const message = buildResponse(query, { answers: [txt("x")] });
      const framedWithExtra = new Uint8Array(message.length + 3);
      new DataView(framedWithExtra.buffer).setUint16(0, message.length);
      framedWithExtra.set(message, 2);
      return [{ raw: framedWithExtra }];
    });
    expect((await lookupError("example.com")).code).toBe("EBADRESP");
  });

  test("a TCP connection closed before the whole message is EBADRESP", async () => {
    serve((query) => {
      if (query.transport === "udp") return [buildResponse(query, { tc: true })];
      const message = buildResponse(query, { answers: [txt("x")] });
      const partial = new Uint8Array(10);
      new DataView(partial.buffer).setUint16(0, message.length);
      partial.set(message.subarray(0, 8), 2);
      return [{ raw: partial }];
    });
    /** The fake keeps the connection open: the attempt times out instead. */
    const { code } = await lookupError("example.com", { attemptTimeoutMs: 150 });
    expect(code === "EBADRESP" || code === "ETIMEOUT").toBe(true);
  });
});

describe("resolveTxtRecords: spoof resistance", () => {
  test("a datagram with another ID is ignored, the right answer accepted", async () => {
    serve((query) => [
      buildResponse(query, { id: (query.id + 1) & 0xffff, answers: [txt("forged")] }),
      buildResponse(query, { answers: [txt("real")] }),
    ]);
    expect(await resolveTxtRecords("example.com", options())).toEqual([["real"]]);
  });

  test("a datagram echoing another question is ignored", async () => {
    serve((query) => [
      buildResponse(query, {
        question: { name: "evil.example" },
        answers: [txt("forged")],
      }),
      buildResponse(query, {
        question: { name: query.name, type: 1 },
        answers: [txt("forged")],
      }),
      buildResponse(query, {
        question: { name: query.name, rrClass: 3 },
        answers: [txt("forged")],
      }),
      buildResponse(query, { answers: [txt("real")] }),
    ]);
    expect(await resolveTxtRecords("example.com", options())).toEqual([["real"]]);
  });

  test("a datagram that is not a response, or not a standard query, is ignored", async () => {
    serve((query) => [
      buildResponse(query, { qr: false, answers: [txt("forged")] }),
      buildResponse(query, { opcode: 2, answers: [txt("forged")] }),
      new Uint8Array(5),
      buildResponse(query, { answers: [txt("real")] }),
    ]);
    expect(await resolveTxtRecords("example.com", options())).toEqual([["real"]]);
  });

  test("only ignored datagrams: the lookup times out", async () => {
    serve((query) => [buildResponse(query, { id: (query.id + 1) & 0xffff })]);
    expect((await lookupError("example.com", { attemptTimeoutMs: 100 })).code).toBe(
      "ETIMEOUT",
    );
  });

  test("an answer with the right ID from another port is ignored", async () => {
    /**
     * Linux drops the forged datagram at the connected socket and answers the
     * spoofer with an ICMP port unreachable, which Bun raises on the spoofer's
     * socket as ECONNREFUSED: expected here, so it is swallowed.
     */
    const spoofer = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      socket: { error() {} },
    });
    try {
      serve((query) => {
        spoofer.send(
          buildResponse(query, { answers: [txt("forged")] }),
          query.clientPort,
          "127.0.0.1",
        );
        return [];
      });
      expect((await lookupError("example.com", { attemptTimeoutMs: 150 })).code).toBe(
        "ETIMEOUT",
      );
    } finally {
      spoofer.close();
    }
  });

  test("an oversized datagram is dropped, the next one accepted", async () => {
    serve((query) => [
      buildResponse(query, {
        answers: Array.from({ length: 20 }, () => txt("z".repeat(250))),
      }),
      buildResponse(query, { answers: [txt("real")] }),
    ]);
    expect(await resolveTxtRecords("example.com", options())).toEqual([["real"]]);
  });

  test("an oversized datagram alone: the lookup times out", async () => {
    serve((query) => [
      buildResponse(query, {
        answers: Array.from({ length: 20 }, () => txt("z".repeat(250))),
      }),
    ]);
    expect((await lookupError("example.com", { attemptTimeoutMs: 100 })).code).toBe(
      "ETIMEOUT",
    );
  });
});

describe("resolveTxtRecords: malformed answers are EBADRESP", () => {
  /** A response to `query` with `body` spliced after the question, and ANCOUNT `count`. */
  function withAnswerBytes(query: FakeDnsQuery, body: number[], count = 1): Uint8Array {
    const base = buildResponse(query);
    const out = new Uint8Array(base.length + body.length);
    out.set(base);
    out.set(body, base.length);
    new DataView(out.buffer).setUint16(6, count);
    return out;
  }

  /** A TXT RR header (type, class, TTL) after an owner name, then RDLENGTH and RDATA. */
  function rr(owner: number[], rdlength: number, rdata: number[]): number[] {
    return [...owner, 0, 16, 0, 1, 0, 0, 1, 44, rdlength >> 8, rdlength & 0xff, ...rdata];
  }

  const cases: Array<[string, (query: FakeDnsQuery) => Uint8Array]> = [
    [
      "a forward compression pointer",
      (q) => withAnswerBytes(q, rr([0xc0, 0xff], 2, [1, 120])),
    ],
    [
      "a pointer to itself (a loop)",
      (q) => {
        const base = buildResponse(q);
        return withAnswerBytes(q, rr([0xc0, base.length], 2, [1, 120]));
      },
    ],
    ["a pointer into the header", (q) => withAnswerBytes(q, rr([0xc0, 2], 2, [1, 120]))],
    ["an unknown label type", (q) => withAnswerBytes(q, rr([0x40, 1], 2, [1, 120]))],
    ["RDLENGTH past the end", (q) => withAnswerBytes(q, rr([0xc0, 12], 50, [1, 120]))],
    [
      "a string longer than RDATA",
      (q) => withAnswerBytes(q, rr([0xc0, 12], 3, [5, 120, 121])),
    ],
    [
      "strings that do not fill RDLENGTH",
      (q) => withAnswerBytes(q, rr([0xc0, 12], 4, [1, 120, 9, 121])),
    ],
    ["an empty TXT RDATA", (q) => withAnswerBytes(q, rr([0xc0, 12], 0, []))],
    [
      "ANCOUNT past the records",
      (q) => withAnswerBytes(q, rr([0xc0, 12], 2, [1, 120]), 2),
    ],
    [
      "a name over 255 bytes",
      (q) => {
        const long = Array.from({ length: 5 }, () => [
          63,
          ...Array.from({ length: 63 }, () => 97),
        ]).flat();
        return withAnswerBytes(q, rr([...long, 0], 2, [1, 120]));
      },
    ],
    [
      "a bad TXT record of another owner",
      (q) => withAnswerBytes(q, rr([...encodeName("other.example")], 3, [5, 120, 121])),
    ],
    [
      "two OPT records",
      (q) =>
        buildResponse(q, { answers: [txt("x")], additional: [optRecord(), optRecord()] }),
    ],
  ];

  test.each(cases)("%s", async (_label, build) => {
    serve((query) => [build(query)]);
    expect((await lookupError("example.com")).code).toBe("EBADRESP");
  });

  test("a valid compressed answer still parses", async () => {
    serve((query) => [withAnswerBytes(query, rr([0xc0, 12], 4, [1, 120, 1, 121]))]);
    expect(await resolveTxtRecords("example.com", options())).toEqual([["x", "y"]]);
  });
});

describe("resolveTxtRecords: fuzz through the network path (fixed seed)", () => {
  test("random datagrams through the network path end in a coded error, never a hang", async () => {
    const random = seededRandom(7);
    const codes = new Set([
      "ETIMEOUT",
      "EBADRESP",
      "ENOTFOUND",
      "ENODATA",
      "ESERVFAIL",
      "EREFUSED",
      "ENOTIMP",
      "EFORMERR",
    ]);
    for (let i = 0; i < 25; i++) {
      serve((query) => {
        const prefix = buildResponse(query, { rcode: Math.floor(random() * 6) });
        const body = Uint8Array.from({ length: Math.floor(random() * 200) }, () =>
          Math.floor(random() * 256),
        );
        const bytes = new Uint8Array(prefix.length + body.length);
        bytes.set(prefix);
        bytes.set(body, prefix.length);
        new DataView(bytes.buffer).setUint16(6, 1 + Math.floor(random() * 3));
        return [bytes];
      });
      try {
        await resolveTxtRecords(
          "example.com",
          options({ attemptTimeoutMs: 100, timeoutMs: 300 }),
        );
      } catch (error) {
        expect(error).toBeInstanceOf(DnsTxtError);
        if (error instanceof DnsTxtError) expect(codes.has(error.code)).toBe(true);
      }
    }
  });
});

describe("resolveTxtRecords: TCP reassembly", () => {
  test("an answer dribbled a few bytes at a time is read whole", async () => {
    const long = ["x".repeat(255), "y".repeat(255), "z".repeat(100)];
    serve((query) => {
      if (query.transport === "udp") return [buildResponse(query, { tc: true })];
      const message = buildResponse(query, { answers: [txt(...long)] });
      const framed = new Uint8Array(message.length + 2);
      new DataView(framed.buffer).setUint16(0, message.length);
      framed.set(message, 2);
      /** The length prefix one byte at a time, then the message in 97-byte pieces. */
      const parts = [framed.slice(0, 1), framed.slice(1, 2)];
      for (let at = 2; at < framed.length; at += 97)
        parts.push(framed.slice(at, at + 97));
      return parts.map((raw) => ({ raw, delayMs: 2 }));
    });
    expect(
      await resolveTxtRecords("example.com", options({ attemptTimeoutMs: 1_500 })),
    ).toEqual([long]);
  });
});
