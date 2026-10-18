import { describe, test, expect } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import {
  UserStoreError,
  sanitizeUserStoreError,
  withSanitizedErrors,
} from "../../src/modules/users/errors.ts";

/**
 * Users-store database errors must never carry query parameters into the
 * logs (#215, #216): drizzle's message embeds them, and on the owner,
 * login and session paths they are password hashes, token hashes and
 * account emails.
 */

/** A driver error shaped like Bun's `PostgresError` (SQLSTATE in `errno`). */
function postgresError(message: string, errno: string): Error {
  return Object.assign(new Error(message), { errno, code: "ERR_POSTGRES_SERVER_ERROR" });
}

describe("sanitizeUserStoreError", () => {
  test("strips the SQL, the params and the driver message, keeps the SQLSTATE", () => {
    const original = new DrizzleQueryError(
      'insert into "user_credentials" ("secret_hash") values ($1)',
      ["$argon2id$v=19$m=65536,t=2,p=1$c2VjcmV0", "owner@example.com"],
      postgresError(
        'invalid input syntax for type integer: "owner@example.com"',
        "22P02",
      ),
    );
    expect(original.message).toContain("$argon2id$");

    const sanitized = sanitizeUserStoreError(original);
    expect(sanitized).toBeInstanceOf(UserStoreError);
    const message = sanitized instanceof Error ? sanitized.message : "";
    expect(message).toBe("User store query failed (SQLSTATE 22P02)");
    expect(message).not.toContain("argon2id");
    expect(message).not.toContain("owner@example.com");
    expect(message).not.toContain("user_credentials");
    expect(sanitized instanceof UserStoreError ? sanitized.sqlState : "").toBe("22P02");
  });

  test("a query error without a driver SQLSTATE still loses its params", () => {
    const sanitized = sanitizeUserStoreError(
      new DrizzleQueryError(
        "select $1",
        ["secret-token-hash"],
        new Error("connection closed"),
      ),
    );
    expect(sanitized).toBeInstanceOf(UserStoreError);
    expect(sanitized instanceof Error ? sanitized.message : "").toBe(
      "User store query failed",
    );
  });

  test("any other error passes through unchanged (deliberate service errors keep their text)", () => {
    const deliberate = new Error(
      "No owner account exists and BUNMAIL_OWNER_EMAIL is not set",
    );
    expect(sanitizeUserStoreError(deliberate)).toBe(deliberate);
    expect(sanitizeUserStoreError("plain string")).toBe("plain string");
  });
});

describe("withSanitizedErrors", () => {
  test("rethrows a query error as UserStoreError and passes values through", async () => {
    expect(await withSanitizedErrors(() => Promise.resolve(42))).toBe(42);

    const failingQuery = (): Promise<never> => {
      throw new DrizzleQueryError(
        'select "id" from "sessions" where "token_hash" = $1',
        ["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
        postgresError("canceling statement due to statement timeout", "57014"),
      );
    };
    const thrown = await withSanitizedErrors(failingQuery).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(UserStoreError);
    expect(thrown instanceof Error ? thrown.message : "").toBe(
      "User store query failed (SQLSTATE 57014)",
    );
  });
});
