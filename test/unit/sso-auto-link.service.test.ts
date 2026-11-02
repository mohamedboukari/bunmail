import { describe, test, expect, mock, beforeEach } from "bun:test";
import { DrizzleQueryError, Table, getTableName, is } from "drizzle-orm";
import type { SsoAutoLinkRefusal } from "../../src/modules/users/types/sso.types.ts";

/**
 * `sso-auto-link.service.ts` (#224, part 4) without a database. Every
 * query the service builds is answered either from a queue per operation
 * (in the order the service awaits them) or, for the races, by a resolver
 * over a small in-memory link table. Each awaited query is logged as
 * `<tx>:<op>:<table>[:for-update]`, so the tests can pin what is locked,
 * in which order, and what is written.
 *
 * Row locks are simulated by one mutex for the `users` rows: a
 * transaction awaiting a `users` select `FOR UPDATE` waits until the
 * transaction holding it ends (enough for races on one account, which
 * is what the service serializes). As under read committed, a statement
 * is answered on what it would see when it starts: a locking statement
 * is answered first and only then waits for the lock, so whatever it
 * reads besides the row it locks (a second factor, through a subquery)
 * can be stale; statements started after the lock see what committed. The SQL itself is covered by
 * `test/integration/sso-auto-link.integration.test.ts`.
 */

type Op = "select" | "insert" | "update" | "delete";

/** One awaited query, as the resolver and the log see it. */
interface Call {
  op: Op;
  table: string;
  locked: boolean;
  tx: number;
  values: unknown;
}

/** What each operation's next awaited query answers; an `Error` rejects. */
const queues: Record<Op, unknown[]> = { select: [], insert: [], update: [], delete: [] };
/** When set, answers every query instead of the queues. */
let resolver: ((call: Call) => unknown) | null = null;
/** Every `.values(...)` argument, in order. */
let captured: unknown[] = [];
/** Every awaited query, in the order it was answered. */
let log: string[] = [];
/** Every awaited select as `<tx>:<table>[:for-update]:<fields>`, in order. */
let selects: string[] = [];
let transactions = 0;

/** The `users` row lock: the end of the transaction holding it, and its id. */
let lockTail: Promise<void> = Promise.resolve();
const lockHolders = new Map<number, () => void>();

/** Takes the `users` lock for `tx`, waiting for the holder to finish. */
async function acquireUsersLock(tx: number): Promise<void> {
  if (lockHolders.has(tx)) return;
  const previous = lockTail;
  let release: () => void = () => {};
  lockTail = new Promise((resolve) => {
    release = resolve;
  });
  lockHolders.set(tx, release);
  await previous;
}

/** A query builder: any method chains; the table, the lock and the values are recorded. */
function query(op: Op, tx: number, table?: Table, fields: string[] = []): unknown {
  const state: { table: Table | undefined; locked: boolean; values: unknown } = {
    table,
    locked: false,
    values: undefined,
  };
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (
            resolve: (value: unknown) => void,
            reject: (error: unknown) => void,
          ) => {
            void (async () => {
              const name = state.table ? getTableName(state.table) : "?";
              const call: Call = {
                op,
                table: name,
                locked: state.locked,
                tx,
                values: state.values,
              };
              /** Answered on the statement's starting view, then the lock (see the header). */
              const next = resolver ? resolver(call) : (queues[op].shift() ?? []);
              if (op === "select" && name === "users" && state.locked) {
                await acquireUsersLock(tx);
              }
              const lockMark = state.locked ? ":for-update" : "";
              log.push(`${tx}:${op}:${name}${lockMark}`);
              if (op === "select")
                selects.push(`${tx}:${name}${lockMark}:${fields.join(",")}`);
              if (next instanceof Error) reject(next);
              else resolve(next);
            })();
          };
        }
        return (arg: unknown) => {
          if (prop === "from" && is(arg, Table)) state.table = arg;
          if (prop === "values") {
            state.values = arg;
            captured.push(arg);
          }
          if (prop === "for") state.locked = true;
          return builder;
        };
      },
    },
  );
  return builder;
}

/** An executor bound to a transaction id (0: outside any transaction). */
function executor(tx: number): Record<string, unknown> {
  return {
    select: (fields?: Record<string, unknown>) =>
      query("select", tx, undefined, fields ? Object.keys(fields) : []),
    insert: (table: Table) => query("insert", tx, table),
    update: (table: Table) => query("update", tx, table),
    delete: (table: Table) => query("delete", tx, table),
    transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      transactions += 1;
      const id = transactions;
      try {
        return await run(executor(id));
      } finally {
        lockHolders.get(id)?.();
        lockHolders.delete(id);
      }
    },
  };
}

void mock.module("../../src/db/index.ts", () => ({ db: executor(0) }));

const autoLink =
  await import("../../src/modules/users/services/sso-auto-link.service.ts");
const { linkSsoIdentity } =
  await import("../../src/modules/users/services/sso-link.service.ts");
const { UserStoreError } = await import("../../src/modules/users/errors.ts");

const CLIENT = { ip: "203.0.113.7", userAgent: "test" };
const KEY = "oidc:https://idp.example.com";
const TARGET = { providerKey: KEY, sub: "sub-1", email: "member@example.com" };
const INPUT = {
  ...TARGET,
  provider: { id: "corp", label: "Corp" },
  name: "member@example.com",
};

/** What the locking statement answers: the account's id only. */
const LOCKED = [{ userId: "usr_1" }];

/** The account row as the service reads it (after the lock, in a transaction). */
function member(
  overrides: Partial<{
    userId: string;
    role: string;
    disabledAt: Date | null;
    hasSecondFactor: boolean;
  }> = {},
): Record<string, unknown> {
  return {
    userId: "usr_1",
    role: "member",
    disabledAt: null,
    hasSecondFactor: false,
    ...overrides,
  };
}

/** A unique violation as drizzle reports it. */
function uniqueViolation(): DrizzleQueryError {
  return new DrizzleQueryError(
    "insert",
    [],
    Object.assign(new Error("dup"), { errno: "23505" }),
  );
}

/** The recorded `.values(...)` rows that carry `field`. */
function rowsWith(field: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const value of captured) {
    if (typeof value === "object" && value !== null && field in value) {
      rows.push(Object.fromEntries(Object.entries(value)));
    }
  }
  return rows;
}

beforeEach(() => {
  for (const op of ["select", "insert", "update", "delete"] as const) queues[op] = [];
  resolver = null;
  captured = [];
  log = [];
  selects = [];
  transactions = 0;
  lockTail = Promise.resolve();
  lockHolders.clear();
});

describe("resolveSsoAutoLink (the read before anything changes)", () => {
  test("no account with the address: no_account_for_email, no account named, links not read", async () => {
    queues.select.push([]);
    expect(await autoLink.resolveSsoAutoLink(TARGET)).toEqual({
      ok: false,
      reason: "no_account_for_email",
      userId: null,
    });
    expect(log).toEqual(["0:select:users"]);
  });

  test("two accounts with the address (emails are unique, so never in practice): refused", async () => {
    queues.select.push([member(), member({ userId: "usr_2" })]);
    expect(await autoLink.resolveSsoAutoLink(TARGET)).toEqual({
      ok: false,
      reason: "no_account_for_email",
      userId: null,
    });
  });

  const refusals: Array<[SsoAutoLinkRefusal, Record<string, unknown>, unknown[]]> = [
    ["deactivated", member({ disabledAt: new Date() }), []],
    ["owner_not_auto_linked", member({ role: "owner", hasSecondFactor: true }), []],
    ["admin_not_auto_linked", member({ role: "admin" }), []],
    ["second_factor_enrolled", member({ hasSecondFactor: true }), []],
    ["provider_already_linked", member(), [{ userId: "usr_1", sub: "sub-0" }]],
    ["already_linked", member(), [{ userId: "usr_2", sub: "sub-1" }]],
  ];
  for (const [reason, account, links] of refusals) {
    test(`${reason}: refused against the account`, async () => {
      queues.select.push([account], links);
      expect(await autoLink.resolveSsoAutoLink(TARGET)).toEqual({
        ok: false,
        reason,
        userId: "usr_1",
      });
    });
  }

  test("only an enabled member without a second factor or a link at the provider may be linked; nothing locked or written", async () => {
    queues.select.push([member()], []);
    expect(await autoLink.resolveSsoAutoLink(TARGET)).toEqual({
      ok: true,
      userId: "usr_1",
    });
    expect(log.every((line) => !line.endsWith(":for-update"))).toBe(true);
    expect(captured).toEqual([]);
    expect(transactions).toBe(0);
  });
});

describe("autoLinkSsoIdentity", () => {
  test("a member without a second factor: users locked first, the link written like an explicit one, auto_linked recorded, then a password-level session", async () => {
    queues.select.push(LOCKED, [member()], []);
    const result = await autoLink.autoLinkSsoIdentity(INPUT, CLIENT);
    if (!result.ok) throw new Error(result.reason);
    expect(result).toMatchObject({
      userId: "usr_1",
      email: "member@example.com",
      assurance: "password",
      autoLinked: { name: "member@example.com" },
    });
    expect(transactions).toBe(1);
    expect(log).toEqual([
      "1:select:users:for-update",
      "1:select:users",
      "1:select:user_credentials",
      "1:insert:user_credentials",
      "1:update:users",
      "1:insert:audit_events",
      "1:update:user_credentials",
      "1:insert:sessions",
      "1:insert:audit_events",
    ]);
    expect(captured[0]).toEqual({
      id: result.linkId,
      userId: "usr_1",
      type: "oauth",
      provider: KEY,
      providerAccountId: "sub-1",
      name: "member@example.com",
    });
    expect(rowsWith("tokenHash")).toEqual([
      expect.objectContaining({
        userId: "usr_1",
        assurance: "password",
        authMethod: "oauth",
        credentialId: result.linkId,
      }),
    ]);
    const audits = rowsWith("action");
    expect(audits.map((row) => [row["action"], row["metadata"]])).toEqual([
      ["auth.sso.auto_linked", { provider: "corp" }],
      ["auth.login.succeeded", { method: "oauth", provider: "corp" }],
    ]);
    expect(audits[0]).toMatchObject({
      outcome: "success",
      actorId: "usr_1",
      targetType: "sso_link",
      targetId: result.linkId,
      targetLabel: "Corp",
    });
    expect(audits[1]?.["targetId"]).toBe(result.sessionId);
    /** Neither the subject nor the provider email is recorded (the actor label is a live lookup). */
    const recorded = JSON.stringify(
      audits.map((row) => [row["targetId"], row["targetLabel"], row["metadata"]]),
    );
    expect(recorded).not.toContain("sub-1");
    expect(recorded).not.toContain("member@example.com");
  });

  test("the lock is its own statement (the id only); the rules are read by the statements after it (L1)", async () => {
    queues.select.push(LOCKED, [member()], []);
    expect((await autoLink.autoLinkSsoIdentity(INPUT, CLIENT)).ok).toBe(true);
    expect(selects).toEqual([
      "1:users:for-update:userId",
      "1:users:userId,role,disabledAt,hasSecondFactor",
      "1:user_credentials:userId,sub",
    ]);
  });

  test("an account with a second factor is refused (second_factor_enrolled): no link, no session", async () => {
    queues.select.push(LOCKED, [member({ hasSecondFactor: true })], []);
    expect(await autoLink.autoLinkSsoIdentity(INPUT, CLIENT)).toEqual({
      ok: false,
      reason: "second_factor_enrolled",
      userId: "usr_1",
    });
    expect(captured).toEqual([]);
  });

  const lockedRefusals: Array<[SsoAutoLinkRefusal, unknown[], unknown[], string | null]> =
    [
      ["deactivated", [member({ disabledAt: new Date() })], [], "usr_1"],
      [
        "owner_not_auto_linked",
        [member({ role: "owner", hasSecondFactor: true })],
        [],
        "usr_1",
      ],
      ["admin_not_auto_linked", [member({ role: "admin" })], [], "usr_1"],
      ["second_factor_enrolled", [member({ hasSecondFactor: true })], [], "usr_1"],
      [
        "provider_already_linked",
        [member()],
        [{ userId: "usr_1", sub: "sub-1" }],
        "usr_1",
      ],
      ["already_linked", [member()], [{ userId: "usr_2", sub: "sub-1" }], "usr_1"],
    ];
  for (const [reason, accounts, links, userId] of lockedRefusals) {
    test(`decided again under the lock: ${reason} writes nothing`, async () => {
      queues.select.push(LOCKED, accounts, links);
      expect(await autoLink.autoLinkSsoIdentity(INPUT, CLIENT)).toEqual({
        ok: false,
        reason,
        userId,
      });
      expect(log[0]).toBe("1:select:users:for-update");
      expect(captured).toEqual([]);
    });
  }

  test("no account (or more than one) locked: no_account_for_email, nothing else read", async () => {
    queues.select.push([]);
    expect(await autoLink.autoLinkSsoIdentity(INPUT, CLIENT)).toEqual({
      ok: false,
      reason: "no_account_for_email",
      userId: null,
    });
    queues.select.push([{ userId: "usr_1" }, { userId: "usr_2" }]);
    expect(await autoLink.autoLinkSsoIdentity(INPUT, CLIENT)).toMatchObject({
      reason: "no_account_for_email",
    });
    expect(log).toEqual(["1:select:users:for-update", "2:select:users:for-update"]);
    expect(captured).toEqual([]);
  });

  test("a racing explicit link of the identity to another account wins the unique index: a clean refusal, never an error", async () => {
    queues.select.push(
      LOCKED,
      [member()],
      [],
      /** Read again after the rolled-back transaction: the identity is usr_2's now. */
      [member()],
      [{ userId: "usr_2", sub: "sub-1" }],
    );
    queues.insert.push(uniqueViolation());
    expect(await autoLink.autoLinkSsoIdentity(INPUT, CLIENT)).toEqual({
      ok: false,
      reason: "already_linked",
      userId: "usr_1",
    });
    expect(rowsWith("tokenHash")).toEqual([]);
    expect(rowsWith("action")).toEqual([]);
  });

  test("a unique violation the read cannot explain is still already_linked", async () => {
    queues.select.push(LOCKED, [member()], [], [member()], []);
    queues.insert.push(uniqueViolation());
    expect(await autoLink.autoLinkSsoIdentity(INPUT, CLIENT)).toEqual({
      ok: false,
      reason: "already_linked",
      userId: "usr_1",
    });
  });

  test("any other database error is not swallowed (sanitized)", async () => {
    queues.select.push(LOCKED, [member()], []);
    queues.insert.push(
      new DrizzleQueryError(
        "insert",
        ["member@example.com"],
        Object.assign(new Error("boom"), { errno: "57P01" }),
      ),
    );
    const error: unknown = await autoLink.autoLinkSsoIdentity(INPUT, CLIENT).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UserStoreError);
    expect(String(error)).not.toContain("member@example.com");
  });
});

/* ─── Races, with the users lock simulated ─── */

describe("races on one account (#224 part 4)", () => {
  /** The links written so far: what the `user_credentials` reads see. */
  let links: Array<{ userId: string; sub: string }>;
  /** Whether a racing transaction has committed a second factor. */
  let factorAdded: boolean;

  beforeEach(() => {
    links = [];
    factorAdded = false;
    resolver = (call) => {
      if (call.op === "select" && call.table === "users") {
        return [member({ hasSecondFactor: factorAdded })];
      }
      if (call.op === "select" && call.table === "sessions") return [{ id: "ses_1" }];
      if (call.op === "select" && call.table === "user_credentials") {
        return links.map((link) => ({ userId: link.userId, sub: link.sub }));
      }
      if (call.op === "insert" && call.table === "user_credentials") {
        const row = call.values;
        const userId = typeof row === "object" && row ? Reflect.get(row, "userId") : null;
        const sub =
          typeof row === "object" && row ? Reflect.get(row, "providerAccountId") : null;
        if (typeof userId !== "string" || typeof sub !== "string")
          return new Error("row");
        /** The two unique indexes: (provider, sub) and one link per account per provider. */
        if (links.some((link) => link.sub === sub || link.userId === userId)) {
          return uniqueViolation();
        }
        links.push({ userId, sub });
      }
      return [];
    };
  });

  /** The lines of one transaction, in order. */
  function linesOf(tx: number): string[] {
    return log.filter((line) => line.startsWith(`${tx}:`));
  }

  test("two concurrent auto-links for one account: one link, one clean refusal, serialized on the users row", async () => {
    const [first, second] = await Promise.all([
      autoLink.autoLinkSsoIdentity(INPUT, CLIENT),
      autoLink.autoLinkSsoIdentity({ ...INPUT, sub: "sub-2" }, CLIENT),
    ]);
    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: false,
      reason: "provider_already_linked",
      userId: "usr_1",
    });
    expect(links).toEqual([{ userId: "usr_1", sub: "sub-1" }]);
    /** Each transaction locks the users row first; the second waits for the first to end. */
    expect(linesOf(1)[0]).toBe("1:select:users:for-update");
    expect(linesOf(2)[0]).toBe("2:select:users:for-update");
    const lastOfFirst = log.lastIndexOf(linesOf(1).at(-1) ?? "");
    expect(log.indexOf("2:select:users:for-update")).toBeGreaterThan(lastOfFirst);
    expect(rowsWith("tokenHash")).toHaveLength(1);
  });

  test("a second factor committed while the auto-link waits for the lock is seen: refused (L1)", async () => {
    /** Turning TOTP on: locks the users row first, commits the factor a moment later. */
    const enableTotp = async (): Promise<void> => {
      transactions += 1;
      const id = transactions;
      await acquireUsersLock(id);
      log.push(`${id}:totp:enabled`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      factorAdded = true;
      lockHolders.get(id)?.();
      lockHolders.delete(id);
    };
    const [, auto] = await Promise.all([
      enableTotp(),
      autoLink.autoLinkSsoIdentity(INPUT, CLIENT),
    ]);
    expect(auto).toEqual({
      ok: false,
      reason: "second_factor_enrolled",
      userId: "usr_1",
    });
    expect(links).toEqual([]);
    expect(log.slice(0, 3)).toEqual([
      "1:totp:enabled",
      "2:select:users:for-update",
      "2:select:users",
    ]);
  });

  /** An explicit link of `sub-2` for usr_1's live session. */
  function explicitLink(): ReturnType<typeof linkSsoIdentity> {
    return linkSsoIdentity(
      {
        flowSessionId: "ses_1",
        session: {
          sessionId: "ses_1",
          userId: "usr_1",
          matched: "current",
          graceOver: false,
        },
        provider: { key: KEY, id: "corp", label: "Corp" },
        sub: "sub-2",
        name: null,
      },
      CLIENT,
    );
  }

  test("auto-link first, explicit link second: the explicit one waits, then is refused", async () => {
    const [auto, explicit] = await Promise.all([
      autoLink.autoLinkSsoIdentity(INPUT, CLIENT),
      explicitLink(),
    ]);
    expect(auto.ok).toBe(true);
    expect(explicit).toMatchObject({ ok: false, reason: "provider_already_linked" });
    expect(links).toEqual([{ userId: "usr_1", sub: "sub-1" }]);
    expect(linesOf(2).slice(0, 2)).toEqual([
      "2:select:users:for-update",
      "2:select:sessions:for-update",
    ]);
  });

  test("explicit link first, auto-link second: the auto-link waits, then is refused like an unknown identity", async () => {
    const [explicit, auto] = await Promise.all([
      explicitLink(),
      autoLink.autoLinkSsoIdentity(INPUT, CLIENT),
    ]);
    expect(explicit.ok).toBe(true);
    expect(auto).toEqual({
      ok: false,
      reason: "provider_already_linked",
      userId: "usr_1",
    });
    expect(links).toEqual([{ userId: "usr_1", sub: "sub-2" }]);
    expect(linesOf(2)[0]).toBe("2:select:users:for-update");
    expect(rowsWith("tokenHash")).toEqual([]);
  });
});
