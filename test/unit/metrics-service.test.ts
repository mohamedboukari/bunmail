import { describe, test, expect } from "bun:test";
import { readMetricsToken } from "../../src/config.ts";
import {
  httpArea,
  isAuthorizedScrape,
} from "../../src/modules/metrics/services/metrics.service.ts";

/** The `area` label must stay a small fixed set: never a raw path, which carries IDs. */
describe("httpArea", () => {
  test.each([
    ["/api/v1/emails", "api/v1/emails"],
    ["/api/v1/emails/msg_0123456789abcdef01234567", "api/v1/emails"],
    ["/api/v1/api-keys/key_1/rotate", "api/v1/api-keys"],
    ["/api/v1/nope", "api/v1/other"],
    ["/api/v1", "api/v1/other"],
    ["/api/docs/json", "api/docs"],
    ["/dashboard/emails/msg_1", "dashboard"],
    ["/u/:token", "unsubscribe"],
    ["/health", "health"],
    ["/metrics", "metrics"],
    ["/", "other"],
    ["/wp-login.php", "other"],
    ["/health/extra", "other"],
  ])("%s -> %s", (path, area) => {
    expect(httpArea(path)).toBe(area);
  });
});

describe("isAuthorizedScrape", () => {
  const TOKEN = "a".repeat(40);

  test("accepts the exact bearer token, any scheme case", () => {
    expect(isAuthorizedScrape(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorizedScrape(`bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  test.each([
    ["no header", null],
    ["empty", ""],
    ["another scheme", `Basic ${TOKEN}`],
    ["a bare token", TOKEN],
    ["a wrong token", `Bearer ${"b".repeat(40)}`],
    ["a prefix of the token", `Bearer ${TOKEN.slice(0, 39)}`],
    ["the token plus more", `Bearer ${TOKEN}x`],
    ["two tokens", `Bearer ${TOKEN} ${TOKEN}`],
  ])("refuses %s", (_label, header) => {
    expect(isAuthorizedScrape(header, TOKEN)).toBe(false);
  });
});

describe("readMetricsToken (METRICS_TOKEN)", () => {
  test("unset or blank turns /metrics off", () => {
    expect(readMetricsToken(undefined)).toBeNull();
    expect(readMetricsToken("")).toBeNull();
    expect(readMetricsToken("   ")).toBeNull();
  });

  /** 32 characters, 31 distinct: the shape of a random token. */
  const VARIED = "Zq-8_Yp7Xo6Wn5Vm4Ul3Tk2Sj1Ri0QhA";

  test("a 32 to 256 character URL-safe token is kept, trimmed", () => {
    const hex = "0123456789abcdef".repeat(4);
    expect(readMetricsToken(` ${hex} `)).toBe(hex);
    expect(readMetricsToken(VARIED)).toBe(VARIED);
    expect(readMetricsToken(VARIED.repeat(8))).toBe(VARIED.repeat(8));
  });

  test.each([
    ["too short", VARIED.slice(0, 31)],
    ["too long", `${VARIED.repeat(8)}x`],
    ["a space inside", `${VARIED.slice(0, 16)} ${VARIED.slice(16)}`],
    ["other characters", `${VARIED}=`],
    ["one repeated character", "a".repeat(64)],
    ["fewer than 8 distinct characters", "abcdefg".repeat(10)],
  ])("refuses to boot on %s", (_label, raw) => {
    expect(() => readMetricsToken(raw)).toThrow("METRICS_TOKEN must be 32 to 256");
  });
});
