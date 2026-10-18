import { describe, test, expect } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import { flashMessageFor } from "../../src/pages/flash-errors.ts";
import { DomainAlreadyRegisteredError } from "../../src/modules/domains/errors.ts";

/**
 * Flash messages travel in the redirect URL: only messages the app wrote
 * for the user may appear there, never database or programming errors.
 */
describe("flashMessageFor", () => {
  test("shows a message the app wrote for the user", () => {
    expect(
      flashMessageFor(new DomainAlreadyRegisteredError("example.com"), "Failed"),
    ).toBe('Domain "example.com" is already registered.');
    expect(flashMessageFor(new Error("Template name is required"), "Failed")).toBe(
      "Template name is required",
    );
  });

  test("hides a database error, whose message carries the query and its values", () => {
    const error = new DrizzleQueryError(
      'insert into "templates" ("html") values ($1)',
      ["<p>secret body</p>"],
      new Error("duplicate key value"),
    );
    expect(flashMessageFor(error, "Failed to create template")).toBe(
      "Failed to create template",
    );
  });

  test("hides a driver error carrying a SQLSTATE", () => {
    const error = Object.assign(new Error('relation "x" does not exist'), {
      errno: "42P01",
    });
    expect(flashMessageFor(error, "Failed")).toBe("Failed");
  });

  test.each([
    new TypeError("undefined is not an object (evaluating 'row.id')"),
    new RangeError("Invalid time value"),
    new ReferenceError("x is not defined"),
    new SyntaxError("Unexpected token"),
  ])("hides a programming error: %p", (error) => {
    expect(flashMessageFor(error, "Failed")).toBe("Failed");
  });

  test("hides anything that is not an Error", () => {
    expect(flashMessageFor("boom", "Failed")).toBe("Failed");
  });
});
