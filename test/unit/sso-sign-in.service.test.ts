import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * `sso-sign-in.service.ts` (#224, part 3) without a database: every query
 * the service builds resolves from a queue per operation, in the order the
 * service awaits them, and a transaction runs its callback on the same
 * fake (the pattern of `sso-link.service.test.ts`). These pin the rules,
 * the assurance and what is written and recorded; the SQL is covered by
 * `test/integration/sso-sign-in.integration.test.ts`.
 */

type Op = "select" | "insert" | "update" | "delete";

/** What each operation's next awaited query answers. */
const queues: Record<Op, unknown[]> = { select: [], insert: [], update: [], delete: [] };
/** Every `.values(...)` and `.set(...)` argument, in order. */
const captured: { values: unknown[]; sets: unknown[] } = { values: [], sets: [] };
/** How many transactions were opened, and how many rows were locked. */
let transactions = 0;
let locks = 0;

/** A query builder: any method chains, arguments of interest are recorded. */
function query(op: Op): unknown {
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          const next = queues[op].shift() ?? [];
          return (resolve: (value: unknown) => void) => resolve(next);
        }
        return (arg: unknown) => {
          if (prop === "values") captured.values.push(arg);
          if (prop === "set") captured.sets.push(arg);
          if (prop === "for") locks += 1;
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

const signIn = await import("../../src/modules/users/services/sso-sign-in.service.ts");

const CLIENT = { ip: "203.0.113.7", userAgent: "test" };
const IDENTITY = { providerKey: "oidc:https://idp.example.com", sub: "sub-1" };

/** A linked account row as the lookup returns it. */
function account(
  overrides: Partial<{
    role: string;
    disabledAt: Date | null;
    hasSecondFactor: boolean;
  }> = {},
): Record<string, unknown> {
  return {
    linkId: "crd_link",
    userId: "usr_1",
    email: "member@example.com",
    role: "member",
    disabledAt: null,
    hasSecondFactor: false,
    ...overrides,
  };
}

/** The `.values(...)` rows that carry a field, by that field. */
function rowsWith(field: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const value of captured.values) {
    if (typeof value === "object" && value !== null && field in value) {
      rows.push(Object.fromEntries(Object.entries(value)));
    }
  }
  return rows;
}

beforeEach(() => {
  for (const op of ["select", "insert", "update", "delete"] as const) queues[op] = [];
  captured.values = [];
  captured.sets = [];
  transactions = 0;
  locks = 0;
});

describe("resolveSsoSignIn", () => {
  test("no linked account: unknown_identity, with no account named", async () => {
    queues.select.push([]);
    expect(await signIn.resolveSsoSignIn(IDENTITY)).toEqual({
      ok: false,
      reason: "unknown_identity",
      userId: null,
    });
  });

  test("a disabled account: deactivated, even for an owner without a second factor", async () => {
    queues.select.push([account({ role: "owner", disabledAt: new Date() })]);
    expect(await signIn.resolveSsoSignIn(IDENTITY)).toEqual({
      ok: false,
      reason: "deactivated",
      userId: "usr_1",
    });
  });

  test("the owner without a BunMail second factor is refused", async () => {
    queues.select.push([account({ role: "owner" })]);
    expect(await signIn.resolveSsoSignIn(IDENTITY)).toEqual({
      ok: false,
      reason: "owner_second_factor_required",
      userId: "usr_1",
    });
  });

  test("assurance: pending with a second factor (owner included), password without", async () => {
    queues.select.push([account({ role: "owner", hasSecondFactor: true })]);
    expect(await signIn.resolveSsoSignIn(IDENTITY)).toEqual({
      ok: true,
      userId: "usr_1",
      email: "member@example.com",
      linkId: "crd_link",
      assurance: "pending",
    });
    queues.select.push([account({ role: "admin" })]);
    expect(await signIn.resolveSsoSignIn(IDENTITY)).toMatchObject({
      ok: true,
      assurance: "password",
    });
    /** A read only: nothing locked, nothing written. */
    expect(locks).toBe(0);
    expect(captured.values).toEqual([]);
  });
});

describe("openSsoSession", () => {
  const input = { ...IDENTITY, providerId: "corp" };

  test("without a second factor: the link locked, last_used_at set, a password-level oauth session bound to the link, the sign-in recorded", async () => {
    queues.select.push([account()]);
    const opened = await signIn.openSsoSession(input, CLIENT);
    expect(opened).toMatchObject({
      ok: true,
      userId: "usr_1",
      linkId: "crd_link",
      assurance: "password",
    });
    expect(transactions).toBe(1);
    expect(locks).toBe(1);
    expect(captured.sets).toHaveLength(1);
    expect(Object.keys(captured.sets[0] ?? {})).toEqual(["lastUsedAt"]);
    expect(rowsWith("tokenHash")).toEqual([
      expect.objectContaining({
        userId: "usr_1",
        assurance: "password",
        authMethod: "oauth",
        credentialId: "crd_link",
        ip: "203.0.113.7",
      }),
    ]);
    const [audit] = rowsWith("action");
    expect(audit).toMatchObject({
      action: "auth.login.succeeded",
      outcome: "success",
      actorId: "usr_1",
      targetType: "session",
      metadata: { method: "oauth", provider: "corp" },
    });
    expect(opened.ok && audit?.["targetId"] === opened.sessionId).toBe(true);
    /** The audit row carries neither the subject nor the provider key (labels: live lookups). */
    const recorded = JSON.stringify(audit?.["metadata"]);
    expect(recorded).not.toContain("sub-1");
    expect(recorded).not.toContain("idp.example.com");
    expect(audit?.["targetLabel"]).toBeNull();
  });

  test("with a second factor: a pending session, recorded as two_factor_required", async () => {
    queues.select.push([account({ hasSecondFactor: true })]);
    expect(await signIn.openSsoSession(input, CLIENT)).toMatchObject({
      ok: true,
      assurance: "pending",
    });
    expect(rowsWith("tokenHash")).toEqual([
      expect.objectContaining({ assurance: "pending", authMethod: "oauth" }),
    ]);
    expect(rowsWith("action")).toEqual([
      expect.objectContaining({
        action: "auth.login.two_factor_required",
        metadata: { method: "oauth", provider: "corp" },
      }),
    ]);
  });

  test("a refusal under the lock changes nothing", async () => {
    queues.select.push([]);
    expect(await signIn.openSsoSession(input, CLIENT)).toEqual({
      ok: false,
      reason: "unknown_identity",
      userId: null,
    });
    queues.select.push([account({ role: "owner" })]);
    expect(await signIn.openSsoSession(input, CLIENT)).toMatchObject({
      ok: false,
      reason: "owner_second_factor_required",
    });
    expect(captured.values).toEqual([]);
    expect(captured.sets).toEqual([]);
  });
});

describe("recordSsoLoginFailure", () => {
  test("auth.login.failed with step sso, the reason and the provider id; an unknown identity names no account", async () => {
    await signIn.recordSsoLoginFailure(null, "corp", "unknown_identity", CLIENT);
    await signIn.recordSsoLoginFailure("usr_1", "corp", "state_mismatch", CLIENT);
    expect(
      rowsWith("action").map((row) => [
        row["action"],
        row["outcome"],
        row["actorId"],
        row["metadata"],
      ]),
    ).toEqual([
      [
        "auth.login.failed",
        "failure",
        null,
        { step: "sso", reason: "unknown_identity", provider: "corp" },
      ],
      [
        "auth.login.failed",
        "failure",
        "usr_1",
        { step: "sso", reason: "state_mismatch", provider: "corp" },
      ],
    ]);
  });
});
