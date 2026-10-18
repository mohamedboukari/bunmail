import { describe, test, expect } from "bun:test";
import {
  DEVICE_COOKIE,
  SESSION_COOKIE,
  clearSessionCookie,
  deviceSetCookie,
  readDeviceCookie,
  readSessionCookie,
  sessionSetCookie,
} from "../../src/pages/session.ts";

/**
 * Unit tests for the dashboard session cookie helpers (#216).
 *
 * The cookie only carries an opaque token; the session lives in the
 * database. The 13 tests of the old stateless HMAC cookie, and the spy
 * that proved its `timingSafeEqual` comparison, are gone with that code:
 * the presented token is now shape-checked, hashed and looked up through
 * a unique index, so no secret is compared in JavaScript any more (the
 * #186 criterion is met by construction, not by a constant-time compare).
 */

const TOKEN = "A".repeat(40) + "b_c";

describe("readSessionCookie", () => {
  test("reads bm_session from a lone cookie", () => {
    expect(readSessionCookie(`bm_session=${TOKEN}`)).toBe(TOKEN);
  });

  test("finds bm_session among several cookies, with spaces", () => {
    expect(readSessionCookie(`theme=dark; bm_session=${TOKEN} ; other=1`)).toBe(TOKEN);
  });

  test("ignores a cookie whose name only ends in bm_session", () => {
    expect(readSessionCookie(`xbm_session=${TOKEN}`)).toBeUndefined();
    expect(readSessionCookie(`xbm_session=evil; bm_session=${TOKEN}`)).toBe(TOKEN);
  });

  test("an empty value, a missing header or no bm_session counts as missing", () => {
    expect(readSessionCookie("bm_session=")).toBeUndefined();
    expect(readSessionCookie("bm_session=  ; a=b")).toBeUndefined();
    expect(readSessionCookie(null)).toBeUndefined();
    expect(readSessionCookie("")).toBeUndefined();
    expect(readSessionCookie("a=b; c=d")).toBeUndefined();
    expect(readSessionCookie("bm_session")).toBeUndefined();
  });

  test("the first bm_session wins (the most specific path)", () => {
    expect(readSessionCookie(`bm_session=${TOKEN}; bm_session=older`)).toBe(TOKEN);
  });

  test("returns a legacy <ts>.<hmac> value as is (the guard rejects its shape)", () => {
    const legacy = `1700000000.${"a".repeat(64)}`;
    expect(readSessionCookie(`bm_session=${legacy}`)).toBe(legacy);
  });
});

describe("sessionSetCookie / clearSessionCookie", () => {
  test("sets the token with HttpOnly, SameSite=Lax, Path=/dashboard and Max-Age", () => {
    const cookie = sessionSetCookie(TOKEN, false, 604800);
    expect(cookie.startsWith(`${SESSION_COOKIE}=${TOKEN}; `)).toBe(true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/dashboard");
    expect(cookie).toContain("Max-Age=604800");
    expect(cookie).not.toContain("Secure");
  });

  test("adds Secure only when asked (production)", () => {
    expect(sessionSetCookie(TOKEN, true, 60)).toContain("; Secure;");
    expect(clearSessionCookie(true)).toContain("; Secure;");
    expect(clearSessionCookie(false)).not.toContain("Secure");
  });

  test("a negative or fractional lifetime becomes a whole, non-negative Max-Age", () => {
    expect(sessionSetCookie(TOKEN, false, -5)).toContain("Max-Age=0");
    expect(sessionSetCookie(TOKEN, false, 59.9)).toContain("Max-Age=59");
  });

  test("clearing empties the value with the same attributes and Max-Age=0", () => {
    const cleared = clearSessionCookie(false);
    expect(cleared).toBe(
      "bm_session=; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=0",
    );
  });
});

describe("device cookie (#282)", () => {
  test("readDeviceCookie reads bm_device only, next to bm_session", () => {
    const header = `bm_session=${TOKEN}; bm_device=dev-value; xbm_device=evil`;
    expect(readDeviceCookie(header)).toBe("dev-value");
    expect(readSessionCookie(header)).toBe(TOKEN);
    expect(readDeviceCookie(`xbm_device=evil`)).toBeUndefined();
    expect(readDeviceCookie("bm_device=")).toBeUndefined();
    expect(readDeviceCookie(null)).toBeUndefined();
  });

  test("deviceSetCookie: the session cookie's attributes and a long Max-Age", () => {
    expect(deviceSetCookie(TOKEN, false, 34_560_000)).toBe(
      `${DEVICE_COOKIE}=${TOKEN}; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=34560000`,
    );
    expect(deviceSetCookie(TOKEN, true, 60)).toBe(
      `bm_device=${TOKEN}; HttpOnly; SameSite=Lax; Secure; Path=/dashboard; Max-Age=60`,
    );
    expect(deviceSetCookie(TOKEN, false, -1)).toContain("Max-Age=0");
  });
});
