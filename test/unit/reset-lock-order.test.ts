import { describe, test, expect, mock, beforeEach } from "bun:test";
import { getTableName, is, Table } from "drizzle-orm";

/**
 * The lock order of a completed reset (#224, review L2), without a
 * database: every query the services build is recorded as
 * `<op>:<table>` (with `:lock` when it ends in `FOR UPDATE`), in the order
 * they are built, and answers from a small table of canned rows. A
 * completed admin reset link and a completed `reset-owner` link must lock
 * the account's `users` row right after spending their token and before
 * touching any credential, the order a link write uses (it locks the
 * account first), so a link racing a reset either commits first and is
 * removed by it, or waits and then finds its session gone. The SQL itself
 * is covered by the integration tests.
 */

type Op = "select" | "insert" | "update" | "delete";

/** Every query built, in order. */
let ops: string[] = [];
/** How many times each `<op>:<table>` was awaited (for the canned answers). */
let seen = new Map<string, number>();
/** Canned answers: `<op>:<table>` and the call number (1-based) to rows. */
let answers: Record<string, unknown[]> = {};

/** The table name of a `from` / `update` / `insert` / `delete` argument, if it is a table. */
function tableOf(arg: unknown): string {
  return is(arg, Table) ? getTableName(arg) : "?";
}

/** A query builder that records its table and answers from `answers`. */
function query(op: Op, initialTable: string): unknown {
  let table = initialTable;
  const index = ops.length;
  ops.push(`${op}:${table}`);
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          const key = `${op}:${table}`;
          const count = (seen.get(key) ?? 0) + 1;
          seen.set(key, count);
          const next = answers[`${key}#${count}`] ?? [];
          return (resolve: (value: unknown) => void) => resolve(next);
        }
        return (arg: unknown) => {
          if (prop === "from") {
            table = tableOf(arg);
            ops[index] = `${op}:${table}`;
          }
          if (prop === "for") ops[index] = `${ops[index] ?? ""}:lock`;
          return builder;
        };
      },
    },
  );
  return builder;
}

const fakeDb = {
  select: () => query("select", "?"),
  insert: (table: unknown) => query("insert", tableOf(table)),
  update: (table: unknown) => query("update", tableOf(table)),
  delete: (table: unknown) => query("delete", tableOf(table)),
  execute: () => Promise.resolve([]),
  transaction: (run: (tx: unknown) => Promise<unknown>) => run(fakeDb),
};

void mock.module("../../src/db/index.ts", () => ({ db: fakeDb }));

const { completePasswordReset } =
  await import("../../src/modules/users/services/password-reset.service.ts");
const { completeOwnerSetup } =
  await import("../../src/modules/users/services/owner.service.ts");

const PASSWORD = "a brand new passphrase, long enough";
const TOKEN = "a".repeat(43);

beforeEach(() => {
  ops = [];
  seen = new Map();
  answers = {};
});

/** The position of the first query matching `entry`, or -1. */
function first(entry: string): number {
  return ops.indexOf(entry);
}

describe("a completed reset locks the account row first (#224)", () => {
  test("admin reset link: token spent, then users FOR UPDATE, then the credentials and the links", async () => {
    answers = {
      "select:user_tokens#1": [
        { resetId: "tok_1", userId: "usr_1", email: "m@example.com" },
      ],
      "update:user_tokens#1": [
        { resetId: "tok_1", userId: "usr_1", issuedBy: "usr_admin" },
      ],
      "update:users#1": [{ email: "m@example.com" }],
    };
    const result = await completePasswordReset(TOKEN, PASSWORD);
    expect(result.ok).toBe(true);
    const spend = first("update:user_tokens");
    const lock = first("select:users:lock");
    expect(spend).toBeGreaterThanOrEqual(0);
    expect(lock).toBe(spend + 1);
    expect(lock).toBeLessThan(first("delete:user_credentials"));
    expect(lock).toBeLessThan(first("insert:user_credentials"));
  });

  test("reset-owner link: token spent, then users FOR UPDATE, then the credentials and the links", async () => {
    answers = {
      "select:user_tokens#1": [{ userId: "usr_owner", email: "o@example.com" }],
      "update:user_tokens#1": [{ userId: "usr_owner" }],
      "update:users#1": [{ userId: "usr_owner", email: "o@example.com" }],
    };
    const owner = await completeOwnerSetup(TOKEN, PASSWORD);
    expect(owner?.userId).toBe("usr_owner");
    const spend = first("update:user_tokens");
    const lock = first("select:users:lock");
    expect(spend).toBeGreaterThanOrEqual(0);
    expect(lock).toBe(spend + 1);
    expect(lock).toBeLessThan(first("delete:user_credentials"));
  });
});
