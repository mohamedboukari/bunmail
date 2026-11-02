import { describe, test, expect, mock, beforeEach } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import type { AttemptLimiter } from "../../src/modules/users/types/user.types.ts";

/**
 * `sso-link.service.ts` (#224) without a database: every query the service
 * builds resolves from a queue per operation (`select`, `insert`,
 * `update`, `delete`), in the order the service awaits them, and a
 * transaction runs its callback on the same fake (the pattern of
 * `passkey.service.test.ts`). These pin the order of the rules; the SQL is
 * covered by `test/integration/sso-links.integration.test.ts`.
 */

type Op = "select" | "insert" | "update" | "delete";

/** What each operation's next awaited query answers; an `Error` rejects. */
const queues: Record<Op, unknown[]> = { select: [], insert: [], update: [], delete: [] };
/** Every `.values(...)` argument, in order (link rows and audit rows). */
const captured: { values: unknown[] } = { values: [] };
/** How many transactions were opened. */
let transactions = 0;

/** A query builder: any method chains, `values` is recorded, awaiting answers from the queue. */
function query(op: Op): unknown {
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          const next = queues[op].shift() ?? [];
          return (resolve: (value: unknown) => void, reject: (error: unknown) => void) =>
            next instanceof Error ? reject(next) : resolve(next);
        }
        return (arg: unknown) => {
          if (prop === "values") captured.values.push(arg);
          return builder;
        };
      },
    },
  );
  return builder;
}

const fakeDb = {
  select: () => query("select"),
  insert: () => query("insert"),
  update: () => query("update"),
  delete: () => query("delete"),
  transaction: (run: (tx: unknown) => Promise<unknown>) => {
    transactions += 1;
    return run(fakeDb);
  },
};

void mock.module("../../src/db/index.ts", () => ({ db: fakeDb }));

const links = await import("../../src/modules/users/services/sso-link.service.ts");
const { hashPassword } =
  await import("../../src/modules/users/services/password.service.ts");

const PASSWORD = "the account password, long enough";
const HASH = await hashPassword(PASSWORD);
const CLIENT = { ip: "203.0.113.7", userAgent: "test" };
const PROVIDER = { key: "oidc:https://idp.example.com", id: "corp", label: "Corp" };
const USER_ID = "usr_1";
const SESSION = {
  sessionId: "ses_1",
  userId: USER_ID,
  matched: "current" as const,
  graceOver: false,
};

/** A limiter that counts calls and limits on demand. */
function limiter(limited = false): AttemptLimiter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    take: () => {
      calls.push("take");
      return Promise.resolve(limited);
    },
    isLimited: () => {
      calls.push("isLimited");
      return Promise.resolve(limited);
    },
    clear: () => {
      calls.push("clear");
      return Promise.resolve();
    },
  };
}

/** The audit rows recorded, as `[action, metadata]`. */
function audited(): Array<[unknown, unknown]> {
  const rows: Array<[unknown, unknown]> = [];
  for (const value of captured.values) {
    if (typeof value !== "object" || value === null) continue;
    const action: unknown = Reflect.get(value, "action");
    if (typeof action === "string") rows.push([action, Reflect.get(value, "metadata")]);
  }
  return rows;
}

/** A unique violation as drizzle reports it. */
function uniqueViolation(): DrizzleQueryError {
  return new DrizzleQueryError(
    "insert",
    [],
    Object.assign(new Error("dup"), { errno: "23505" }),
  );
}

/** Links with the default input, after a live session. */
function linkWith(
  overrides: Partial<Parameters<typeof links.linkSsoIdentity>[0]> = {},
): ReturnType<typeof links.linkSsoIdentity> {
  return links.linkSsoIdentity(
    {
      flowSessionId: SESSION.sessionId,
      session: SESSION,
      provider: PROVIDER,
      sub: "sub-1",
      name: "alice@example.com",
      ...overrides,
    },
    CLIENT,
  );
}

beforeEach(() => {
  for (const op of ["select", "insert", "update", "delete"] as const) queues[op] = [];
  captured.values = [];
  transactions = 0;
});

describe("authorizeSsoLink", () => {
  const input = { userId: USER_ID, provider: PROVIDER, password: PASSWORD };

  test("the owner without a second factor is refused after the budget, before the password", async () => {
    queues.select.push([{ role: "owner", hasSecondFactor: false }], []);
    const budget = limiter();
    expect(await links.authorizeSsoLink(input, budget, CLIENT)).toEqual({
      ok: false,
      reason: "second_factor_required",
    });
    /** Charged first (L4): every audited refusal is paid for. */
    expect(budget.calls).toEqual(["take"]);
    expect(audited()).toEqual([
      ["auth.sso.link_refused", { provider: "corp", reason: "second_factor_required" }],
    ]);
  });

  test("the owner with a second factor, and any other role, go on to the password", async () => {
    queues.select.push(
      [{ role: "owner", hasSecondFactor: true }],
      [],
      [{ secretHash: HASH }],
    );
    expect(await links.authorizeSsoLink(input, limiter(), CLIENT)).toEqual({ ok: true });
    queues.select.push(
      [{ role: "member", hasSecondFactor: false }],
      [],
      [{ secretHash: HASH }],
    );
    expect(await links.authorizeSsoLink(input, limiter(), CLIENT)).toEqual({ ok: true });
  });

  test("an account already linked at the provider is refused after the budget, before the password", async () => {
    queues.select.push([{ role: "member", hasSecondFactor: false }], [{ id: "crd_1" }]);
    const budget = limiter();
    expect(await links.authorizeSsoLink(input, budget, CLIENT)).toEqual({
      ok: false,
      reason: "provider_already_linked",
    });
    expect(budget.calls).toEqual(["take"]);
  });

  test("over budget: refused before any check, nothing read or recorded", async () => {
    queues.select.push([{ role: "owner", hasSecondFactor: false }], []);
    const limited = limiter(true);
    expect(await links.authorizeSsoLink(input, limited, CLIENT)).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    expect(audited()).toEqual([]);
    /** The pre-check rows were never read. */
    expect(queues.select).toHaveLength(2);
  });

  test("the budget, then exactly one password check, audited when wrong", async () => {
    const limited = limiter(true);
    expect(await links.authorizeSsoLink(input, limited, CLIENT)).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    expect(limited.calls).toEqual(["take"]);
    expect(audited()).toEqual([]);

    queues.select.push(
      [{ role: "member", hasSecondFactor: false }],
      [],
      [{ secretHash: HASH }],
    );
    const wrong = limiter();
    expect(
      await links.authorizeSsoLink({ ...input, password: "not it" }, wrong, CLIENT),
    ).toEqual({ ok: false, reason: "wrong_password" });
    expect(wrong.calls).toEqual(["take"]);
    expect(audited()).toEqual([
      ["auth.sso.link_refused", { provider: "corp", reason: "wrong_password" }],
    ]);

    queues.select.push(
      [{ role: "member", hasSecondFactor: false }],
      [],
      [{ secretHash: HASH }],
    );
    const right = limiter();
    expect(await links.authorizeSsoLink(input, right, CLIENT)).toEqual({ ok: true });
    expect(right.calls).toEqual(["take", "clear"]);
  });
});

describe("linkSsoIdentity", () => {
  test("no live session, another session, or a reused token: session_changed, no transaction", async () => {
    for (const session of [
      null,
      { ...SESSION, sessionId: "ses_other" },
      { ...SESSION, matched: "previous" as const, graceOver: true },
    ]) {
      expect(await linkWith({ session })).toEqual({
        ok: false,
        reason: "session_changed",
        userId: session?.userId ?? null,
      });
    }
    expect(transactions).toBe(0);
    expect(audited().map(([action]) => action)).toEqual([
      "auth.sso.link_refused",
      "auth.sso.link_refused",
      "auth.sso.link_refused",
    ]);
  });

  test("the previous token inside its grace period is still the session", async () => {
    queues.select.push(
      [{ role: "member", hasSecondFactor: false }],
      [{ id: "ses_1" }],
      [],
    );
    const result = await linkWith({
      session: { ...SESSION, matched: "previous", graceOver: false },
    });
    expect(result.ok).toBe(true);
  });

  test("the session row must still be live under the lock", async () => {
    queues.select.push([{ role: "member", hasSecondFactor: false }], []);
    expect(await linkWith()).toEqual({
      ok: false,
      reason: "session_changed",
      userId: USER_ID,
    });
  });

  test("the user row is locked first, then the session row; the owner rule is checked again", async () => {
    queues.select.push([{ role: "owner", hasSecondFactor: false }], [{ id: "ses_1" }]);
    expect(await linkWith()).toEqual({
      ok: false,
      reason: "second_factor_required",
      userId: USER_ID,
    });
  });

  test("an identity of another account: already_linked; of this one, or another identity at the provider: provider_already_linked", async () => {
    const lockedMember = (): void => {
      queues.select.push([{ role: "member", hasSecondFactor: false }], [{ id: "ses_1" }]);
    };
    lockedMember();
    queues.select.push([{ userId: "usr_2", sub: "sub-1" }]);
    expect(await linkWith()).toMatchObject({ ok: false, reason: "already_linked" });

    lockedMember();
    queues.select.push([{ userId: USER_ID, sub: "sub-1" }]);
    expect(await linkWith()).toMatchObject({
      ok: false,
      reason: "provider_already_linked",
    });

    lockedMember();
    queues.select.push([{ userId: USER_ID, sub: "sub-0" }]);
    expect(await linkWith()).toMatchObject({
      ok: false,
      reason: "provider_already_linked",
    });
  });

  test("stores the row keyed by issuer and subject, no secret, and records the link", async () => {
    queues.select.push(
      [{ role: "member", hasSecondFactor: false }],
      [{ id: "ses_1" }],
      [],
    );
    const result = await linkWith();
    if (!result.ok) throw new Error(result.reason);
    expect(result.name).toBe("alice@example.com");
    expect(captured.values[0]).toEqual({
      id: result.linkId,
      userId: USER_ID,
      type: "oauth",
      provider: PROVIDER.key,
      providerAccountId: "sub-1",
      name: "alice@example.com",
    });
    expect(captured.values[1]).toMatchObject({
      action: "auth.sso.linked",
      targetType: "sso_link",
      targetId: result.linkId,
      targetLabel: "Corp",
      metadata: { provider: "corp" },
    });
    /** The subject is in the link row only, never in the audit row. */
    const auditRow = captured.values[1];
    const strings =
      typeof auditRow === "object" && auditRow !== null
        ? Object.values(auditRow).filter((v) => typeof v === "string")
        : [];
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.join(" ")).not.toContain("sub-1");
  });

  test("a racing link that wins a unique index is sorted into a refusal", async () => {
    queues.select.push(
      [{ role: "member", hasSecondFactor: false }],
      [{ id: "ses_1" }],
      [],
    );
    queues.insert.push(uniqueViolation());
    queues.select.push([{ userId: "usr_2" }]);
    expect(await linkWith()).toMatchObject({ ok: false, reason: "already_linked" });

    queues.select.push(
      [{ role: "member", hasSecondFactor: false }],
      [{ id: "ses_1" }],
      [],
    );
    queues.insert.push(uniqueViolation());
    queues.select.push([]);
    expect(await linkWith()).toMatchObject({
      ok: false,
      reason: "provider_already_linked",
    });
  });
});

describe("unlinkSsoIdentity", () => {
  const recorded = (): { id: string; label: string } => ({ id: "corp", label: "Corp" });

  test("found first, then the budget and the password (a wrong one recorded), then removed with its sessions", async () => {
    queues.select.push([]);
    const untouched = limiter();
    expect(
      await links.unlinkSsoIdentity(
        { userId: USER_ID, linkId: "crd_x", password: PASSWORD },
        untouched,
        CLIENT,
        recorded,
      ),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(untouched.calls).toEqual([]);

    queues.select.push([{ provider: PROVIDER.key }]);
    expect(
      await links.unlinkSsoIdentity(
        { userId: USER_ID, linkId: "crd_1", password: PASSWORD },
        limiter(true),
        CLIENT,
        recorded,
      ),
    ).toEqual({ ok: false, reason: "rate_limited" });

    queues.select.push([{ provider: PROVIDER.key }], [{ secretHash: HASH }]);
    expect(
      await links.unlinkSsoIdentity(
        { userId: USER_ID, linkId: "crd_1", password: "wrong" },
        limiter(),
        CLIENT,
        recorded,
      ),
    ).toEqual({ ok: false, reason: "wrong_password" });
    /** A wrong password is recorded, as when linking (L5). */
    expect(captured.values).toContainEqual(
      expect.objectContaining({
        action: "auth.sso.unlink_refused",
        outcome: "failure",
        targetType: "sso_link",
        targetId: "crd_1",
        targetLabel: "Corp",
        metadata: { provider: "corp", reason: "wrong_password" },
      }),
    );
    captured.values = [];

    queues.select.push(
      [{ provider: PROVIDER.key }],
      [{ secretHash: HASH }],
      [{ provider: PROVIDER.key, name: "alice@example.com" }],
    );
    queues.delete.push([{ id: "ses_a" }, { id: "ses_b" }], []);
    const budget = limiter();
    expect(
      await links.unlinkSsoIdentity(
        { userId: USER_ID, linkId: "crd_1", password: PASSWORD },
        budget,
        CLIENT,
        recorded,
      ),
    ).toEqual({
      ok: true,
      provider: PROVIDER.key,
      name: "alice@example.com",
      sessionsRevoked: 2,
    });
    expect(budget.calls).toEqual(["take", "clear"]);
    expect(captured.values).toContainEqual(
      expect.objectContaining({
        action: "auth.sso.unlinked",
        targetId: "crd_1",
        targetLabel: "Corp",
        metadata: { provider: "corp", sessionsRevoked: 2 },
      }),
    );
  });
});

describe("removeSsoLinks (a completed reset, #224)", () => {
  test("every link of the account is deleted and returned, never the subject; nothing to remove gives an empty list", async () => {
    queues.delete.push([
      { id: "crd_1", provider: PROVIDER.key, name: "alice@example.com" },
      { id: "crd_2", provider: null, name: null },
    ]);
    /** The mocked `db`, typed as the real one: its transaction hands the fake over. */
    const { db } = await import("../../src/db/index.ts");
    const removed = await db.transaction((tx) => links.removeSsoLinks(tx, USER_ID));
    expect(removed).toEqual([
      { id: "crd_1", provider: PROVIDER.key, name: "alice@example.com" },
      { id: "crd_2", provider: "", name: null },
    ]);
    expect(JSON.stringify(removed)).not.toContain("sub-");

    queues.delete.push([]);
    expect(await db.transaction((tx) => links.removeSsoLinks(tx, USER_ID))).toEqual([]);
    /** One statement each: the sessions they opened go by the foreign key's cascade. */
    expect(queues.delete).toEqual([]);
  });
});
