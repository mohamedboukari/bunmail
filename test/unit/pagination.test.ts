import { describe, test, expect } from "bun:test";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE,
  PAGE_SIZES,
  parsePagination,
} from "../../src/pages/pagination.ts";

describe("parsePagination (#172, #429)", () => {
  test("uses defaults when params are missing", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(25);
    expect(parsePagination({})).toEqual({ page: 1, limit: 25 });
    expect(parsePagination({}, 50)).toEqual({ page: 1, limit: 50 });
  });

  test("offers exactly 25, 50 and 100 rows per page", () => {
    expect([...PAGE_SIZES]).toEqual([25, 50, 100]);
  });

  test("passes every allowed size through", () => {
    for (const size of PAGE_SIZES) {
      expect(parsePagination({ page: "3", limit: String(size) })).toEqual({
        page: 3,
        limit: size,
      });
    }
  });

  test("any other limit falls back to the page's default, never a 422", () => {
    /** The old default (an old bookmark), sizes in between, and below the smallest. */
    for (const limit of ["20", "10", "1", "26", "75", "99", "101", "200"]) {
      expect(parsePagination({ limit }).limit).toBe(25);
      expect(parsePagination({ limit }, 50).limit).toBe(50);
    }
  });

  test("page 0 or negative falls back to 1 (was a negative OFFSET, a 500)", () => {
    expect(parsePagination({ page: "0" }).page).toBe(1);
    expect(parsePagination({ page: "-1" }).page).toBe(1);
  });

  test("non-numeric values fall back to defaults (limit=abc used to read every row)", () => {
    expect(parsePagination({ page: "abc", limit: "abc" })).toEqual({
      page: 1,
      limit: 25,
    });
    expect(parsePagination({ page: "", limit: "" })).toEqual({ page: 1, limit: 25 });
  });

  test("limit 0 or negative falls back to the default", () => {
    expect(parsePagination({ limit: "0" }).limit).toBe(25);
    expect(parsePagination({ limit: "-5" }, 100).limit).toBe(100);
  });

  test("a huge limit falls back to the default instead of reading the table", () => {
    expect(parsePagination({ limit: "99999999" }).limit).toBe(25);
    expect(parsePagination({ limit: "1e3" }).limit).toBe(25);
  });

  test("a huge page is capped at MAX_PAGE (1e20 overflowed Postgres's OFFSET, a 500)", () => {
    expect(parsePagination({ page: "99999999999999999999" }).page).toBe(MAX_PAGE);
    expect(parsePagination({ page: "1e20" }).page).toBe(1);
    expect(MAX_PAGE).toBe(1_000_000);
  });

  test("decimals truncate like parseInt", () => {
    expect(parsePagination({ page: "2.5", limit: "50.9" })).toEqual({
      page: 2,
      limit: 50,
    });
  });

  test("never yields a value that could make OFFSET negative or LIMIT unbounded", () => {
    for (const page of [
      "0",
      "-1",
      "abc",
      "",
      "1e3",
      "NaN",
      "Infinity",
      "99999999999999999999",
    ]) {
      for (const limit of ["0", "-1", "abc", "", "1e3", "NaN", "Infinity", "99999999"]) {
        const p = parsePagination({ page, limit });
        expect(Number.isInteger(p.page) && p.page >= 1 && p.page <= MAX_PAGE).toBe(true);
        /** The value the service turns into OFFSET must be a safe, non-negative integer. */
        expect(Number.isSafeInteger((p.page - 1) * p.limit)).toBe(true);
        expect(PAGE_SIZES.some((size) => size === p.limit)).toBe(true);
      }
    }
  });
});
