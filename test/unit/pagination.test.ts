import { describe, test, expect } from "bun:test";
import { MAX_PAGE, MAX_PAGE_SIZE, parsePagination } from "../../src/pages/pagination.ts";

describe("parsePagination (#172)", () => {
  test("uses defaults when params are missing", () => {
    expect(parsePagination({})).toEqual({ page: 1, limit: 20 });
    expect(parsePagination({}, 25)).toEqual({ page: 1, limit: 25 });
  });

  test("passes valid values through", () => {
    expect(parsePagination({ page: "3", limit: "50" })).toEqual({ page: 3, limit: 50 });
  });

  test("page 0 or negative falls back to 1 (was a negative OFFSET, a 500)", () => {
    expect(parsePagination({ page: "0" }).page).toBe(1);
    expect(parsePagination({ page: "-1" }).page).toBe(1);
  });

  test("non-numeric values fall back to defaults (limit=abc used to read every row)", () => {
    expect(parsePagination({ page: "abc", limit: "abc" })).toEqual({
      page: 1,
      limit: 20,
    });
    expect(parsePagination({ page: "", limit: "" })).toEqual({ page: 1, limit: 20 });
  });

  test("limit 0 or negative falls back to the default", () => {
    expect(parsePagination({ limit: "0" }).limit).toBe(20);
    expect(parsePagination({ limit: "-5" }, 25).limit).toBe(25);
  });

  test("a huge limit is capped at MAX_PAGE_SIZE", () => {
    expect(parsePagination({ limit: "99999999" }).limit).toBe(MAX_PAGE_SIZE);
    expect(MAX_PAGE_SIZE).toBe(100);
  });

  test("a huge page is capped at MAX_PAGE (1e20 overflowed Postgres's OFFSET, a 500)", () => {
    expect(parsePagination({ page: "99999999999999999999" }).page).toBe(MAX_PAGE);
    expect(parsePagination({ page: "1e20" }).page).toBe(1);
    expect(MAX_PAGE).toBe(1_000_000);
  });

  test("decimals truncate like parseInt", () => {
    expect(parsePagination({ page: "2.5", limit: "10.9" })).toEqual({
      page: 2,
      limit: 10,
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
        expect(
          Number.isInteger(p.limit) && p.limit >= 1 && p.limit <= MAX_PAGE_SIZE,
        ).toBe(true);
      }
    }
  });
});
