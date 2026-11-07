import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_RUA_PER_RECORD,
  TLSRPT_RECORD_TTL_MS,
  lookupTlsRptRecord,
  parseRua,
  parseTlsRptTxt,
  publishesTlsRpt,
  setTlsRptRecordDeps,
  tlsRptRecordCacheSize,
} from "../../src/modules/tls-rpt/services/tls-rpt-record.ts";

/**
 * The `_smtp._tls` TXT record (RFC 8460 section 3, #345): strict parsing of
 * hostile input, and the delivery path's cached "does this domain publish
 * one" answer. No real DNS: the lookup is replaced.
 */

afterEach(() => setTlsRptRecordDeps(null));

describe("parseTlsRptTxt", () => {
  test("RFC 8460 example records: mailto and https", () => {
    expect(parseTlsRptTxt([["v=TLSRPTv1;rua=mailto:reports@example.com"]])).toEqual([
      {
        scheme: "mailto",
        uri: "mailto:reports@example.com",
        address: "reports@example.com",
        key: "mailto:reports@example.com",
        destination: "reports@example.com",
      },
    ]);
    expect(
      parseTlsRptTxt([["v=TLSRPTv1; rua=https://reporting.example.com/v1/tlsrpt"]]),
    ).toEqual([
      {
        scheme: "https",
        uri: "https://reporting.example.com/v1/tlsrpt",
        url: "https://reporting.example.com/v1/tlsrpt",
        key: "https://reporting.example.com/v1/tlsrpt",
        destination: "https://reporting.example.com",
      },
    ]);
  });

  test("duplicates by normalised form are dropped: case of an address, an equivalent URL", () => {
    const rua = parseTlsRptTxt([
      [
        "v=TLSRPTv1; rua=mailto:TLS@Example.com,mailto:tls@example.COM,mailto:tls%40example.com," +
          "https://R.example.net/a,https://r.example.net:443/a",
      ],
    ]);
    expect(rua?.map((r) => r.key)).toEqual([
      "mailto:tls@example.com",
      "https://r.example.net/a",
    ]);
  });

  test("several rua, comma separated, with whitespace; strings of one record are joined", () => {
    const rua = parseTlsRptTxt([
      ["v=TLSRPTv1; rua=mailto:tls@example.com, ", "https://r.example.net/tls?k=1"],
    ]);
    expect(rua?.map((r) => r.scheme)).toEqual(["mailto", "https"]);
    expect(rua?.[1]).toMatchObject({ url: "https://r.example.net/tls?k=1" });
  });

  test("unknown fields are ignored; a trailing semicolon is fine", () => {
    expect(
      parseTlsRptTxt([["v=TLSRPTv1; ext=1; rua=mailto:a@example.com;"]])?.length,
    ).toBe(1);
  });

  test("duplicates are dropped and at most MAX_RUA_PER_RECORD kept", () => {
    const many = Array.from({ length: 9 }, (_, i) => `mailto:r${i}@example.com`);
    const rua = parseTlsRptTxt([
      [`v=TLSRPTv1; rua=mailto:r0@example.com,${many.join(",")}`],
    ]);
    expect(rua).toHaveLength(MAX_RUA_PER_RECORD);
    expect(new Set(rua?.map((r) => r.uri)).size).toBe(MAX_RUA_PER_RECORD);
  });

  test("records of other versions or other services are ignored", () => {
    expect(
      parseTlsRptTxt([
        ["v=spf1 -all"],
        ["v=TLSRPTv10; rua=mailto:x@example.com"],
        ["v=TLSRPTv1; rua=mailto:ok@example.com"],
      ])?.[0],
    ).toMatchObject({ address: "ok@example.com" });
  });

  test("none, or more than one TLSRPTv1 record: no record", () => {
    expect(parseTlsRptTxt([])).toBeNull();
    expect(parseTlsRptTxt([["v=spf1 -all"]])).toBeNull();
    expect(
      parseTlsRptTxt([
        ["v=TLSRPTv1; rua=mailto:a@example.com"],
        ["v=TLSRPTv1; rua=mailto:b@example.com"],
      ]),
    ).toBeNull();
  });

  test.each([
    ["no rua", "v=TLSRPTv1;"],
    ["two rua fields", "v=TLSRPTv1; rua=mailto:a@example.com; rua=mailto:b@example.com"],
    ["a field without =", "v=TLSRPTv1; rua"],
    ["an empty inner field", "v=TLSRPTv1;; rua=mailto:a@example.com"],
    ["version not first", "rua=mailto:a@example.com; v=TLSRPTv1"],
    ["only unusable URIs", "v=TLSRPTv1; rua=ftp://x.example.com/,http://x.example.com/"],
  ])("invalid: %s", (_name, record) => {
    expect(parseTlsRptTxt([[record]])).toBeNull();
  });
});

describe("parseRua", () => {
  test("mailto is percent-decoded and its domain lower-cased", () => {
    expect(parseRua("mailto:Tls%2Brpt@Example.COM")).toEqual({
      scheme: "mailto",
      uri: "mailto:Tls%2Brpt@Example.COM",
      address: "Tls+rpt@example.com",
      key: "mailto:tls+rpt@example.com",
      destination: "tls+rpt@example.com",
    });
  });

  test("https: the destination is the origin", () => {
    expect(parseRua("https://r.example.net:8443/x?y=1")).toMatchObject({
      key: "https://r.example.net:8443/x?y=1",
      destination: "https://r.example.net:8443",
    });
  });

  test.each([
    "mailto:a@example.com?subject=x",
    "mailto:a@example.com?to=b@evil.example",
    "mailto:not-an-address",
    "mailto:a@example.com%0d%0aBcc:%20b@evil.example",
    "mailto:%E0%A4%A",
    "mailto:a%00@example.com",
    "mailto:a@example.com%00",
    "mailto:a%07b@example.com",
    "mailto:a(comment)@example.com",
    "mailto:%28comment%29a@example.com",
    "mailto:%5B127.0.0.1%5D@example.com",
    "mailto:a@%5B127.0.0.1%5D",
    "mailto:a%5Cb@example.com",
    "mailto:a%3Bb@example.com",
    "mailto:@route:a@example.com",
    "mailto:a%2Cb@example.com",
    "mailto:%C3%A9t%C3%A9@example.com",
    "mailto:a@%C3%A9xample.com",
    "http://reports.example.com/",
    "https://user:pass@reports.example.com/",
    "https://reports.example.com/#frag",
    "https://",
    "javascript:alert(1)",
    `https://example.com/${"a".repeat(2100)}`,
    "",
  ])("refuses %p", (raw) => {
    expect(parseRua(raw)).toBeNull();
  });
});

describe("lookupTlsRptRecord", () => {
  test("queries _smtp._tls.<domain>", async () => {
    const names: string[] = [];
    const answer = await lookupTlsRptRecord("example.com", {
      resolveTxt: async (name) => {
        names.push(name);
        return [["v=TLSRPTv1; rua=mailto:t@example.com"]];
      },
      now: () => 0,
      timeoutMs: 1_000,
    });
    expect(names).toEqual(["_smtp._tls.example.com"]);
    expect(answer.kind).toBe("record");
  });

  test("NXDOMAIN and NODATA are no record; SERVFAIL is an error", async () => {
    const failing = (code: string) => ({
      resolveTxt: async (): Promise<string[][]> => {
        throw Object.assign(new Error(code), { code });
      },
      now: () => 0,
      timeoutMs: 1_000,
    });
    expect((await lookupTlsRptRecord("a.example", failing("ENOTFOUND"))).kind).toBe(
      "none",
    );
    expect((await lookupTlsRptRecord("a.example", failing("ENODATA"))).kind).toBe("none");
    expect(await lookupTlsRptRecord("a.example", failing("ESERVFAIL"))).toEqual({
      kind: "error",
      code: "ESERVFAIL",
    });
  });
});

describe("publishesTlsRpt (cache)", () => {
  test("one lookup per domain within the TTL, shared by concurrent callers", async () => {
    let now = 1_000_000;
    let lookups = 0;
    setTlsRptRecordDeps({
      resolveTxt: async () => {
        lookups++;
        return [["v=TLSRPTv1; rua=mailto:t@example.com"]];
      },
      now: () => now,
    });
    const answers = await Promise.all([
      publishesTlsRpt("Example.com."),
      publishesTlsRpt("example.com"),
    ]);
    expect(answers).toEqual([true, true]);
    expect(await publishesTlsRpt("example.com")).toBe(true);
    expect(lookups).toBe(1);
    now += TLSRPT_RECORD_TTL_MS;
    expect(await publishesTlsRpt("example.com")).toBe(true);
    expect(lookups).toBe(2);
  });

  test("a failed lookup counts as no record, and is retried sooner", async () => {
    let now = 0;
    let fail = true;
    setTlsRptRecordDeps({
      resolveTxt: async () => {
        if (fail) throw Object.assign(new Error("x"), { code: "ETIMEOUT" });
        return [["v=TLSRPTv1; rua=mailto:t@example.com"]];
      },
      now: () => now,
    });
    expect(await publishesTlsRpt("example.org")).toBe(false);
    fail = false;
    now += 5 * 60_000;
    expect(await publishesTlsRpt("example.org")).toBe(true);
    expect(tlsRptRecordCacheSize()).toBe(1);
  });
});
