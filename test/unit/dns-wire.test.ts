import { describe, test, expect } from "bun:test";
import {
  MAX_CNAME_LINKS,
  encodeQuery,
  parseTxtResponse,
  type TxtQuestion,
  type TxtResponseOutcome,
} from "../../src/utils/dns-wire.ts";
import {
  CLASS_IN,
  TYPE_CNAME,
  buildResponse,
  encodeName,
  optRecord,
  seededRandom,
  txt,
  txtRdata,
  type FakeDnsQuery,
  type FakeRecord,
} from "../fake-dns.ts";

/**
 * The DNS wire format of TXT lookups (`src/utils/dns-wire.ts`), without
 * sockets: the query, replies without a question, the CNAME chain walk,
 * and a fixed-seed fuzz of the response parser (random bytes, random
 * bodies, every truncation and single-byte mutations of a valid response),
 * which must never throw.
 */

const QUESTION: TxtQuestion = { id: 0x1234, labels: ["example", "com"] };

/** The query the fuzz responses answer, as the fake server would parse it. */
const FUZZ_QUERY: FakeDnsQuery = {
  id: QUESTION.id,
  name: "example.com",
  qtype: 16,
  qclass: CLASS_IN,
  flags: 0x0100,
  additionalCount: 1,
  ednsPayload: 1232,
  transport: "udp",
  clientPort: 0,
  raw: new Uint8Array(0),
};

/** A valid response with compression, a CNAME, several strings and an OPT record. */
const VALID = buildResponse(FUZZ_QUERY, {
  answers: [
    { name: null, type: TYPE_CNAME, rdata: encodeName("t.example.net") },
    { name: "t.example.net", rdata: txtRdata("v=DKIM1; ", "p=abc") },
    txt("second"),
  ],
  authority: [{ name: "example.com", type: 6, rdata: new Uint8Array(22) }],
  additional: [optRecord()],
});

const OUTCOME_KINDS = new Set(["mismatch", "truncated", "records", "error"]);

/** Parses without throwing and gives a known outcome; returns it. */
function parsedSafely(bytes: Uint8Array): TxtResponseOutcome {
  const outcome = parseTxtResponse(bytes, QUESTION);
  expect(OUTCOME_KINDS.has(outcome.kind)).toBe(true);
  return outcome;
}

describe("parseTxtResponse: fuzz (fixed seed)", () => {
  test("the valid response parses", () => {
    expect(parseTxtResponse(VALID, QUESTION)).toEqual({
      kind: "records",
      records: [["v=DKIM1; ", "p=abc"], ["second"]],
    });
  });

  test("every truncation of the valid response is rejected", () => {
    for (let length = 0; length < VALID.length; length++) {
      const outcome = parsedSafely(VALID.slice(0, length));
      expect(
        outcome.kind === "mismatch" ||
          (outcome.kind === "error" && outcome.code === "EBADRESP"),
      ).toBe(true);
    }
  });

  test("random bytes never throw", () => {
    const random = seededRandom(0xb0b);
    for (let i = 0; i < 3_000; i++) {
      const bytes = Uint8Array.from({ length: Math.floor(random() * 600) }, () =>
        Math.floor(random() * 256),
      );
      parsedSafely(bytes);
    }
  });

  test("random bodies after our header and question never throw", () => {
    const random = seededRandom(42);
    const prefix = buildResponse(FUZZ_QUERY);
    for (let i = 0; i < 3_000; i++) {
      const body = Uint8Array.from({ length: Math.floor(random() * 400) }, () =>
        Math.floor(random() * 256),
      );
      const bytes = new Uint8Array(prefix.length + body.length);
      bytes.set(prefix);
      bytes.set(body, prefix.length);
      const view = new DataView(bytes.buffer);
      view.setUint16(6, Math.floor(random() * 8));
      view.setUint16(8, Math.floor(random() * 3));
      view.setUint16(10, Math.floor(random() * 3));
      parsedSafely(bytes);
    }
  });

  test("single-byte mutations of the valid response never throw", () => {
    const random = seededRandom(1337);
    for (let at = 0; at < VALID.length; at++) {
      for (let i = 0; i < 8; i++) {
        const bytes = VALID.slice();
        bytes[at] = Math.floor(random() * 256);
        parsedSafely(bytes);
      }
    }
  });
});

describe("encodeQuery", () => {
  test("with EDNS0: ARCOUNT 1 and an OPT advertising 1232 bytes", () => {
    const bytes = encodeQuery(QUESTION);
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(0)).toBe(0x1234);
    expect(view.getUint16(2)).toBe(0x0100);
    expect(view.getUint16(10)).toBe(1);
    expect(Array.from(bytes.slice(-11))).toEqual([0, 0, 41, 4, 208, 0, 0, 0, 0, 0, 0]);
  });

  test("without EDNS0: ARCOUNT 0 and no OPT", () => {
    const bytes = encodeQuery(QUESTION, false);
    expect(new DataView(bytes.buffer).getUint16(10)).toBe(0);
    expect(bytes.length).toBe(encodeQuery(QUESTION).length - 11);
  });
});

describe("parseTxtResponse: replies without a question", () => {
  /** Our ID, QR set, QDCOUNT 0 and `rcode`. */
  function questionless(rcode: number, id = QUESTION.id, flags = 0x8180): Uint8Array {
    const bytes = new Uint8Array(12);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, id);
    view.setUint16(2, flags | rcode);
    return bytes;
  }

  test.each([
    [1, "EFORMERR"],
    [2, "ESERVFAIL"],
    [4, "ENOTIMP"],
    [5, "EREFUSED"],
  ])("RCODE %d is %s", (rcode, code) => {
    const outcome = parseTxtResponse(questionless(rcode), QUESTION);
    expect<string>(outcome.kind === "error" ? outcome.code : outcome.kind).toBe(code);
  });

  test("NOERROR, NXDOMAIN, another ID or QR clear is a mismatch", () => {
    expect(parseTxtResponse(questionless(0), QUESTION).kind).toBe("mismatch");
    expect(parseTxtResponse(questionless(3), QUESTION).kind).toBe("mismatch");
    expect(parseTxtResponse(questionless(2, 0x4321), QUESTION).kind).toBe("mismatch");
    expect(parseTxtResponse(questionless(2, QUESTION.id, 0x0180), QUESTION).kind).toBe(
      "mismatch",
    );
  });
});

describe("parseTxtResponse: CNAME chains", () => {
  /** A chain of `links` CNAMEs from the name asked, the TXT at its end, in `order`. */
  function chain(links: number, order: "forward" | "reverse"): Uint8Array {
    const names = Array.from({ length: links }, (_, i) => `c${i}.example.net`);
    const records: FakeRecord[] = names.map((target, i) => ({
      name: i === 0 ? null : (names[i - 1] ?? null),
      type: TYPE_CNAME,
      rdata: encodeName(target),
    }));
    records.push({ name: names.at(-1) ?? null, rdata: txtRdata("end") });
    return buildResponse(FUZZ_QUERY, {
      answers: order === "forward" ? records : records.toReversed(),
    });
  }

  test(`a chain of ${MAX_CNAME_LINKS} links is followed, in any order`, () => {
    for (const order of ["forward", "reverse"] as const) {
      expect(parseTxtResponse(chain(MAX_CNAME_LINKS, order), QUESTION)).toEqual({
        kind: "records",
        records: [["end"]],
      });
    }
  });

  test("one link more is EBADRESP", () => {
    expect(parseTxtResponse(chain(MAX_CNAME_LINKS + 1, "reverse"), QUESTION)).toEqual({
      kind: "error",
      code: "EBADRESP",
    });
  });

  test("thousands of reverse-ordered CNAMEs are read in linear time", () => {
    const started = performance.now();
    expect(parseTxtResponse(chain(2_000, "reverse"), QUESTION)).toEqual({
      kind: "error",
      code: "EBADRESP",
    });
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("two different targets for one owner are EBADRESP; a loop ends the walk", () => {
    const twoTargets = buildResponse(FUZZ_QUERY, {
      answers: [
        { name: null, type: TYPE_CNAME, rdata: encodeName("a.example.net") },
        { name: null, type: TYPE_CNAME, rdata: encodeName("b.example.net") },
      ],
    });
    expect(parseTxtResponse(twoTargets, QUESTION)).toEqual({
      kind: "error",
      code: "EBADRESP",
    });
    const loop = buildResponse(FUZZ_QUERY, {
      answers: [
        { name: null, type: TYPE_CNAME, rdata: encodeName("a.example.net") },
        { name: "a.example.net", type: TYPE_CNAME, rdata: encodeName("example.com") },
        txt("own"),
      ],
    });
    expect(parseTxtResponse(loop, QUESTION)).toEqual({
      kind: "records",
      records: [["own"]],
    });
  });
});
