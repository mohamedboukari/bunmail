import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readGeoipSettings } from "../../src/config.ts";
import {
  GEOIP_MAX_RESPONSE_BYTES,
  fetchIpinfoLocation,
  formatLocation,
  loadMmdbLookup,
  locationFromIpinfo,
  locationFromMmdbRecord,
  lookupLocation,
  type GeoipFetch,
} from "../../src/modules/users/services/geoip.service.ts";

/**
 * Approximate session locations (#281): the GeoIP config reader, the
 * label formatter, the `.mmdb` reader (against a tiny database generated
 * here in the MaxMind DB format) and the ipinfo client (with a fake
 * `fetch`).
 */

/* ─── A minimal MaxMind DB writer (test fixture) ─── */

/** Data field type numbers of the MaxMind DB format. */
const TYPE = { string: 2, uint16: 5, uint32: 6, map: 7, uint64: 9, array: 11 } as const;

/** A value the fixture writer can encode. */
type MmdbValue =
  | string
  | { uint: number; type: "uint16" | "uint32" | "uint64" }
  | MmdbValue[]
  | { [key: string]: MmdbValue };

/** Control byte(s) for a field of `type` and `size` (sizes under 29 only). */
function control(type: number, size: number): number[] {
  if (size >= 29) throw new Error("fixture writer: size too large");
  return type <= 7 ? [(type << 5) | size] : [size, type - 7];
}

/** Big-endian bytes of an unsigned integer, without leading zeros. */
function uintBytes(value: number): number[] {
  const bytes: number[] = [];
  for (let v = value; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return bytes;
}

/** Encodes one value in the MaxMind DB data format. */
function encode(value: MmdbValue): number[] {
  if (typeof value === "string") {
    const bytes = [...Buffer.from(value, "utf8")];
    return [...control(TYPE.string, bytes.length), ...bytes];
  }
  if (Array.isArray(value)) {
    return [...control(TYPE.array, value.length), ...value.flatMap(encode)];
  }
  if ("uint" in value && typeof value.uint === "number" && "type" in value) {
    const bytes = uintBytes(value.uint);
    const type =
      value.type === "uint16"
        ? TYPE.uint16
        : value.type === "uint32"
          ? TYPE.uint32
          : TYPE.uint64;
    return [...control(type, bytes.length), ...bytes];
  }
  const entries = Object.entries(value);
  const bytes = control(TYPE.map, entries.length);
  for (const [key, item] of entries) bytes.push(...encode(key), ...encode(item));
  return bytes;
}

/** 24-bit big-endian. */
function uint24(value: number): number[] {
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * An IPv4 database with one tree node: addresses whose first bit is 0
 * (0.0.0.0 to 127.255.255.255) map to `left`, the rest to `right`.
 */
function buildMmdb(left: MmdbValue, right: MmdbValue): Buffer {
  const nodeCount = 1;
  const leftData = encode(left);
  const rightData = encode(right);
  /** A record value past the node count points into the data section (16-byte separator). */
  const tree = [...uint24(nodeCount + 16), ...uint24(nodeCount + 16 + leftData.length)];
  const metadata = encode({
    node_count: { uint: nodeCount, type: "uint32" },
    record_size: { uint: 24, type: "uint16" },
    ip_version: { uint: 4, type: "uint16" },
    database_type: "BunMail-Test-City",
    languages: ["en"],
    binary_format_major_version: { uint: 2, type: "uint16" },
    binary_format_minor_version: { uint: 0, type: "uint16" },
    build_epoch: { uint: 1_700_000_000, type: "uint64" },
    description: { en: "BunMail test fixture" },
  });
  return Buffer.from([
    ...tree,
    ...Array.from({ length: 16 }, () => 0),
    ...leftData,
    ...rightData,
    ...Buffer.from("ABCDEF4D61784D696E642E636F6D", "hex"),
    ...metadata,
  ]);
}

let dir = "";
let dbPath = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bunmail-geoip-"));
  dbPath = join(dir, "test-city.mmdb");
  await writeFile(
    dbPath,
    buildMmdb(
      {
        city: { names: { en: "Mountain View" } },
        country: { names: { en: "United States" }, iso_code: "US" },
      },
      { country: { names: { en: "Australia" }, iso_code: "AU" } },
    ),
  );
  await writeFile(join(dir, "corrupt.mmdb"), "not a maxmind database");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/* ─── Config ─── */

describe("readGeoipSettings", () => {
  const none = { dbPath: undefined, provider: undefined, token: undefined };

  test("unset or blank: off", () => {
    expect(readGeoipSettings(none)).toEqual({ source: "off" });
    expect(readGeoipSettings({ dbPath: "", provider: " ", token: "" })).toEqual({
      source: "off",
    });
  });

  test("a database path: offline lookup", () => {
    expect(readGeoipSettings({ ...none, dbPath: " /data/dbip-city-lite.mmdb " })).toEqual(
      {
        source: "mmdb",
        dbPath: "/data/dbip-city-lite.mmdb",
      },
    );
  });

  test("ipinfo with a token: online lookup", () => {
    expect(
      readGeoipSettings({ ...none, provider: "IPinfo", token: "abc_123-x" }),
    ).toEqual({
      source: "ipinfo",
      token: "abc_123-x",
    });
  });

  test("the database wins over a provider, which is still validated", () => {
    expect(
      readGeoipSettings({ dbPath: "/data/a.mmdb", provider: "ipinfo", token: "t0k" }),
    ).toEqual({ source: "mmdb", dbPath: "/data/a.mmdb" });
    expect(() =>
      readGeoipSettings({ dbPath: "/data/a.mmdb", provider: "ip-api", token: "t0k" }),
    ).toThrow(/GEOIP_PROVIDER/);
  });

  test("refuses an unknown provider", () => {
    expect(() => readGeoipSettings({ ...none, provider: "ip-api", token: "x" })).toThrow(
      'Invalid GEOIP_PROVIDER "ip-api", must be one of: ipinfo',
    );
  });

  test("refuses a provider without a token, and a token without a provider", () => {
    expect(() => readGeoipSettings({ ...none, provider: "ipinfo" })).toThrow(
      /needs GEOIP_API_TOKEN/,
    );
    expect(() => readGeoipSettings({ ...none, token: "abc" })).toThrow(
      /GEOIP_API_TOKEN is set but GEOIP_PROVIDER is not/,
    );
  });

  test("refuses a token with characters a token never has, without echoing it", () => {
    for (const token of ["abc&x=1", "a b", "a/b", "x".repeat(129)]) {
      let message = "";
      try {
        readGeoipSettings({ ...none, provider: "ipinfo", token });
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("GEOIP_API_TOKEN must be");
      expect(message).not.toContain(token);
    }
  });
});

/* ─── Labels ─── */

describe("formatLocation", () => {
  test("City, Country, or Country alone", () => {
    expect(formatLocation("Paris", "France")).toBe("Paris, France");
    expect(formatLocation(undefined, "France")).toBe("France");
    expect(formatLocation("", "France")).toBe("France");
  });

  test("no country: nothing", () => {
    expect(formatLocation("Paris", undefined)).toBeNull();
    expect(formatLocation("Paris", "  ")).toBeNull();
    expect(formatLocation(null, null)).toBeNull();
  });

  test("non-strings are ignored", () => {
    expect(formatLocation(42, "France")).toBe("France");
    expect(formatLocation("Paris", { en: "France" })).toBeNull();
  });

  test("control characters and runs of whitespace are cleaned", () => {
    expect(formatLocation(" New\u0000\nYork ", "United​ States")).toBe(
      "New York, United States",
    );
  });

  test("cut to 128 code points without splitting a surrogate pair", () => {
    const label = formatLocation("😀".repeat(200), "X");
    expect(label).not.toBeNull();
    expect(Array.from(label ?? "").length).toBe(128);
    expect(label?.endsWith("😀")).toBe(true);
  });
});

describe("locationFromMmdbRecord", () => {
  test("reads city.names.en and country.names.en", () => {
    expect(
      locationFromMmdbRecord({
        city: { names: { en: "Berlin", de: "Berlin" } },
        country: { names: { en: "Germany" } },
      }),
    ).toBe("Berlin, Germany");
    expect(locationFromMmdbRecord({ country: { names: { en: "Germany" } } })).toBe(
      "Germany",
    );
  });

  test("anything else: nothing", () => {
    expect(locationFromMmdbRecord(null)).toBeNull();
    expect(locationFromMmdbRecord("Germany")).toBeNull();
    expect(locationFromMmdbRecord({ country: { names: ["Germany"] } })).toBeNull();
    expect(locationFromMmdbRecord({ autonomous_system_number: 1 })).toBeNull();
  });
});

describe("locationFromIpinfo", () => {
  test("the Lite answer (country only)", () => {
    expect(
      locationFromIpinfo({
        ip: "8.8.8.8",
        asn: "AS15169",
        country_code: "US",
        country: "United States",
        continent: "North America",
      }),
    ).toBe("United States");
  });

  test("a city when a richer plan returns one", () => {
    expect(locationFromIpinfo({ city: "Sydney", country: "Australia" })).toBe(
      "Sydney, Australia",
    );
  });

  test("anything else: nothing", () => {
    expect(locationFromIpinfo([])).toBeNull();
    expect(locationFromIpinfo({ error: { title: "Wrong token" } })).toBeNull();
  });
});

/* ─── Offline database ─── */

describe("loadMmdbLookup", () => {
  test("reads a MaxMind DB file and looks addresses up", async () => {
    const lookup = await loadMmdbLookup(dbPath);
    expect(locationFromMmdbRecord(lookup("8.8.8.8"))).toBe(
      "Mountain View, United States",
    );
    expect(locationFromMmdbRecord(lookup("203.0.113.9"))).toBe("Australia");
  });

  test("a missing or corrupt file throws", async () => {
    expect(loadMmdbLookup(join(dir, "missing.mmdb"))).rejects.toThrow();
    expect(loadMmdbLookup(join(dir, "corrupt.mmdb"))).rejects.toThrow();
  });
});

describe("lookupLocation", () => {
  test("off: nothing, no lookup", async () => {
    expect(await lookupLocation("8.8.8.8", { source: "off" })).toBeNull();
  });

  test("private, loopback, link-local and malformed addresses are never looked up", async () => {
    const settings = { source: "ipinfo", token: "t0k" } as const;
    for (const ip of [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "::1",
      "fe80::1",
      "x",
    ]) {
      expect(await lookupLocation(ip, settings)).toBeNull();
    }
    expect(await lookupLocation(null, settings)).toBeNull();
  });

  test("offline database: the label of the address", async () => {
    const settings = { source: "mmdb", dbPath } as const;
    expect(await lookupLocation("8.8.8.8", settings)).toBe(
      "Mountain View, United States",
    );
    expect(await lookupLocation("203.0.113.9", settings)).toBe("Australia");
  });
});

/* ─── Online provider ─── */

describe("fetchIpinfoLocation", () => {
  const TOKEN = "s3cr3t_token";

  /** A fake fetch recording the URL and init it got. */
  function fakeFetch(answer: () => Response | Promise<Response>): {
    impl: GeoipFetch;
    calls: { url: string; init: RequestInit }[];
  } {
    const calls: { url: string; init: RequestInit }[] = [];
    return {
      calls,
      impl: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(answer());
      },
    };
  }

  test("asks the Lite API over HTTPS with the token, a timeout and no redirects", async () => {
    const fetch = fakeFetch(() =>
      Response.json({ country: "France", country_code: "FR" }),
    );
    expect(await fetchIpinfoLocation("2001:db8::1", TOKEN, fetch.impl)).toBe("France");
    const [call] = fetch.calls;
    expect(call?.url).toBe(`https://api.ipinfo.io/lite/2001%3Adb8%3A%3A1?token=${TOKEN}`);
    expect(call?.init.redirect).toBe("error");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("a non-2xx answer throws, with the status only", async () => {
    const fetch = fakeFetch(() => new Response("rate limited", { status: 429 }));
    expect(fetchIpinfoLocation("8.8.8.8", TOKEN, fetch.impl)).rejects.toThrow(
      "ipinfo answered HTTP 429",
    );
  });

  test("an oversized answer throws, declared or streamed", async () => {
    const big = "x".repeat(GEOIP_MAX_RESPONSE_BYTES + 1);
    const declared = fakeFetch(
      () => new Response(big, { headers: { "content-length": String(big.length) } }),
    );
    expect(fetchIpinfoLocation("8.8.8.8", TOKEN, declared.impl)).rejects.toThrow(
      "too large",
    );
    const streamed = fakeFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(big));
              controller.close();
            },
          }),
        ),
    );
    expect(fetchIpinfoLocation("8.8.8.8", TOKEN, streamed.impl)).rejects.toThrow(
      "too large",
    );
  });

  test("invalid JSON throws", async () => {
    const fetch = fakeFetch(() => new Response("<html>"));
    expect(fetchIpinfoLocation("8.8.8.8", TOKEN, fetch.impl)).rejects.toThrow(
      "invalid JSON",
    );
  });

  test("a network error or timeout throws without the URL or the token", async () => {
    const failing: GeoipFetch = (url) =>
      Promise.reject(new TypeError(`Unable to connect to ${url}`));
    let message = "";
    try {
      await fetchIpinfoLocation("8.8.8.8", TOKEN, failing);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("ipinfo request failed (TypeError)");
    expect(message).not.toContain(TOKEN);

    const timeout: GeoipFetch = () =>
      Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
    expect(fetchIpinfoLocation("8.8.8.8", TOKEN, timeout)).rejects.toThrow(
      "ipinfo request failed (TimeoutError)",
    );
  });
});
