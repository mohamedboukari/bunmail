import { describe, test, expect } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import {
  OwnerStoreError,
  sanitizeOwnerStoreError,
} from "../../src/modules/users/errors.ts";

/**
 * Owner-store database errors must never carry query parameters into the
 * logs (#215): drizzle's message embeds them, and on the owner paths they
 * are the password hash, token hashes and the owner email.
 */

/** A driver error shaped like Bun's `PostgresError` (SQLSTATE in `errno`). */
function postgresError(message: string, errno: string): Error {
  return Object.assign(new Error(message), { errno, code: "ERR_POSTGRES_SERVER_ERROR" });
}

describe("sanitizeOwnerStoreError", () => {
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

    const sanitized = sanitizeOwnerStoreError(original);
    expect(sanitized).toBeInstanceOf(OwnerStoreError);
    const message = sanitized instanceof Error ? sanitized.message : "";
    expect(message).toBe("Owner store query failed (SQLSTATE 22P02)");
    expect(message).not.toContain("argon2id");
    expect(message).not.toContain("owner@example.com");
    expect(message).not.toContain("user_credentials");
    expect(sanitized instanceof OwnerStoreError ? sanitized.sqlState : "").toBe("22P02");
  });

  test("a query error without a driver SQLSTATE still loses its params", () => {
    const sanitized = sanitizeOwnerStoreError(
      new DrizzleQueryError(
        "select $1",
        ["secret-token-hash"],
        new Error("connection closed"),
      ),
    );
    expect(sanitized).toBeInstanceOf(OwnerStoreError);
    expect(sanitized instanceof Error ? sanitized.message : "").toBe(
      "Owner store query failed",
    );
  });

  test("any other error passes through unchanged (deliberate service errors keep their text)", () => {
    const deliberate = new Error(
      "No owner account exists and BUNMAIL_OWNER_EMAIL is not set",
    );
    expect(sanitizeOwnerStoreError(deliberate)).toBe(deliberate);
    expect(sanitizeOwnerStoreError("plain string")).toBe("plain string");
  });
});
