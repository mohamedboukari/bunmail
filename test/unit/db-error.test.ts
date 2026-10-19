import { describe, test, expect } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import { loggableError, sqlStateOf } from "../../src/utils/db-error.ts";

/**
 * `loggableError` (#184): a failed write's log line never carries a
 * drizzle query error's message, which embeds the query parameters.
 */
describe("loggableError", () => {
  test("a drizzle query error is reduced to its SQLSTATE", () => {
    const cause = Object.assign(new Error("injected failure"), { errno: "P0001" });
    const error = new DrizzleQueryError(
      "insert into suppressions (email) values ($1)",
      ["reader@example.org"],
      cause,
    );
    expect(loggableError(error)).toBe("Database query failed (SQLSTATE P0001)");
  });

  test("without a SQLSTATE, nothing of the query is kept", () => {
    const error = new DrizzleQueryError("select $1", ["reader@example.org"]);
    expect(loggableError(error)).toBe("Database query failed");
  });

  test("other errors keep their message", () => {
    expect(loggableError(new Error("injected failure"))).toBe("injected failure");
    expect(loggableError("plain")).toBe("plain");
  });
});

describe("sqlStateOf", () => {
  test("reads the SQLSTATE of a drizzle error's cause, a Postgres error, or a sanitized error", () => {
    const cause = Object.assign(new Error("injected failure"), { errno: "P0001" });
    expect(sqlStateOf(new DrizzleQueryError("select 1", [], cause))).toBe("P0001");
    expect(sqlStateOf(cause)).toBe("P0001");
    expect(sqlStateOf(Object.assign(new Error("x"), { sqlState: "40001" }))).toBe(
      "40001",
    );
  });

  test("null when there is none", () => {
    expect(sqlStateOf(new Error("plain"))).toBeNull();
    expect(sqlStateOf(undefined)).toBeNull();
  });
});
