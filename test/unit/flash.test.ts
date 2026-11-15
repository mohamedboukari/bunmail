import { describe, test, expect } from "bun:test";
import {
  FLASH_MESSAGES,
  NUMERIC_FLASH_MESSAGES,
  type FlashCode,
  type NumericFlashCode,
} from "../../src/pages/lib/flash-codes.ts";
import {
  flashMessage,
  flashUrl,
  toFlash,
  type Flash,
} from "../../src/pages/lib/flash.ts";
import { flashOfLocation } from "../flash-of.ts";

/**
 * Flash codes (#421): a redirect names a banner by code and the page
 * shows only the message written for that code, so a link from anyone
 * else cannot put words of its own inside the dashboard.
 */

/** Every code of each table, typed (`Object.keys` is `string[]`). */
const FIXED_CODES = Object.keys(FLASH_MESSAGES).filter((key): key is FlashCode =>
  Object.hasOwn(FLASH_MESSAGES, key),
);
const NUMERIC_CODES = Object.keys(NUMERIC_FLASH_MESSAGES).filter(
  (key): key is NumericFlashCode => Object.hasOwn(NUMERIC_FLASH_MESSAGES, key),
);

/** An en or em dash, written as escapes so this file carries neither. */
const DASHES = /[\u2013\u2014]/;

describe("the code tables", () => {
  test("codes are lower snake case, so a URL carries them unencoded", () => {
    for (const code of [...FIXED_CODES, ...NUMERIC_CODES]) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  test("no code is in both tables", () => {
    const fixed = new Set<string>(FIXED_CODES);
    expect(NUMERIC_CODES.filter((code) => fixed.has(code))).toEqual([]);
  });

  test("no message has an em or en dash", () => {
    for (const code of FIXED_CODES) {
      expect(FLASH_MESSAGES[code].text).not.toMatch(DASHES);
    }
    for (const code of NUMERIC_CODES) {
      expect(NUMERIC_FLASH_MESSAGES[code].text(2)).not.toMatch(DASHES);
    }
  });
});

describe("toFlash", () => {
  test.each(FIXED_CODES)("%p renders its message and colour", (code) => {
    const entry = FLASH_MESSAGES[code];
    expect(entry.text.length).toBeGreaterThan(0);
    expect(toFlash(code, undefined)).toEqual({ message: entry.text, type: entry.type });
    expect(flashOfLocation(flashUrl("/dashboard/x", code))).toEqual({
      message: entry.text,
      type: entry.type,
    });
    expect(flashMessage(code)).toBe(entry.text);
  });

  test.each(NUMERIC_CODES)("%p renders its message with the number", (code) => {
    const entry = NUMERIC_FLASH_MESSAGES[code];
    const url = flashUrl("/dashboard/x", { code, n: 3 });
    expect(url).toBe(`/dashboard/x?flash=${code}&flashN=3`);
    expect(flashOfLocation(url)).toEqual({ message: entry.text(3), type: entry.type });
  });

  test("a few messages, word for word", () => {
    expect(toFlash("webhook_not_found", undefined)).toEqual({
      message: "Webhook not found",
      type: "error",
    });
    expect(toFlash("api_key_revoked", undefined)).toEqual({
      message: "API key revoked",
      type: "success",
    });
    expect(toFlash("emails_trashed", "3")).toEqual({
      message: "3 email(s) moved to trash",
      type: "success",
    });
    expect(toFlash("sessions_revoked_others", "1")?.message).toBe(
      "Signed out 1 other device.",
    );
  });

  test("an unknown code renders nothing", () => {
    expect(toFlash("not_a_code", undefined)).toBeUndefined();
    expect(toFlash("WEBHOOK_NOT_FOUND", undefined)).toBeUndefined();
    expect(toFlash("", undefined)).toBeUndefined();
    expect(toFlash(undefined, undefined)).toBeUndefined();
  });

  test("arbitrary text, as an old free-text link carried, renders nothing", () => {
    expect(
      toFlash("Your account was compromised, call +1 555 0100", undefined),
    ).toBeUndefined();
    expect(toFlash("Webhook created", undefined)).toBeUndefined();
    expect(
      flashOfLocation(
        "/dashboard/account/sso?flash=Your%20account%20was%20compromised&flashType=error",
      ),
    ).toBeUndefined();
  });

  test("prototype keys are not codes", () => {
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(toFlash(key, undefined)).toBeUndefined();
      expect(toFlash(key, "1")).toBeUndefined();
    }
  });

  test("a numeric code takes digits only: text in the number renders nothing", () => {
    expect(toFlash("emails_trashed", undefined)).toBeUndefined();
    expect(toFlash("emails_trashed", "")).toBeUndefined();
    expect(toFlash("emails_trashed", "3 call us")).toBeUndefined();
    expect(toFlash("emails_trashed", "-1")).toBeUndefined();
    expect(toFlash("emails_trashed", "1.5")).toBeUndefined();
    expect(toFlash("emails_trashed", "1e3")).toBeUndefined();
    expect(toFlash("emails_trashed", " 3")).toBeUndefined();
    expect(toFlash("emails_trashed", "1234567890")).toBeUndefined();
    expect(
      flashOfLocation(
        "/dashboard/emails?flash=emails_trashed&flashN=3%20emails%20lost%2C%20call%20us",
      ),
    ).toBeUndefined();
  });

  test("a limit's number cannot carry text either", () => {
    expect(toFlash("webhook_limit_reached", "10")?.message).toBe(
      "This API key already has the maximum of 10 webhooks. Delete one before adding another.",
    );
    expect(
      toFlash("webhook_limit_reached", "10 webhooks; call +1 555 0100"),
    ).toBeUndefined();
  });

  test("a fixed-text code ignores any number", () => {
    expect(toFlash("webhook_deleted", "99 call us")).toEqual({
      message: "Webhook deleted",
      type: "success",
    });
  });
});

describe("flashUrl", () => {
  test("appends to a path with or without a query", () => {
    expect(flashUrl("/dashboard/webhooks", "webhook_created")).toBe(
      "/dashboard/webhooks?flash=webhook_created",
    );
    expect(flashUrl("/dashboard/emails?page=2", { code: "emails_trashed", n: 4 })).toBe(
      "/dashboard/emails?page=2&flash=emails_trashed&flashN=4",
    );
  });

  test("a number that is not a non-negative safe integer goes out as 0", () => {
    const bad: Flash[] = [
      { code: "emails_trashed", n: -2 },
      { code: "emails_trashed", n: 1.5 },
      { code: "emails_trashed", n: Number.NaN },
      { code: "emails_trashed", n: Number.POSITIVE_INFINITY },
    ];
    for (const flash of bad) {
      expect(flashUrl("/d", flash)).toBe("/d?flash=emails_trashed&flashN=0");
    }
  });

  test("a number above the shared maximum is clamped, and still reads back", () => {
    const url = flashUrl("/d", { code: "emails_trashed", n: 5_000_000_000 });
    expect(url).toBe("/d?flash=emails_trashed&flashN=999999999");
    expect(flashOfLocation(url)?.message).toBe("999999999 email(s) moved to trash");
    const max = flashUrl("/d", { code: "emails_trashed", n: 999_999_999 });
    expect(flashOfLocation(max)?.message).toBe("999999999 email(s) moved to trash");
  });
});
