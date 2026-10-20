import {
  describe,
  test,
  expect,
  mock,
  beforeEach,
  setSystemTime,
  afterEach,
} from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import { TestAuthenticator } from "../integration/_webauthn.ts";

/**
 * `passkey.service.ts` (#223) without a database: every query the service
 * builds resolves from a queue per operation (`select`, `insert`,
 * `update`, `delete`), in the order the service awaits them, and a
 * transaction runs its callback on the same fake. The WebAuthn side is
 * real: a software authenticator (`_webauthn.ts`) signs, and
 * `@simplewebauthn/server` verifies. The SQL itself is covered by
 * `test/integration/passkeys.integration.test.ts`.
 */

type Op = "select" | "insert" | "update" | "delete";

/** What each operation's next awaited query answers; an `Error` rejects. */
const queues: Record<Op, unknown[]> = { select: [], insert: [], update: [], delete: [] };
/** Every `.values(...)` and `.set(...)` argument, in order. */
const captured: { values: unknown[]; set: unknown[] } = { values: [], set: [] };

/** A query builder: any method chains, `values` and `set` are recorded, awaiting answers from the queue. */
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
          if (prop === "set") captured.set.push(arg);
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
  transaction: (run: (tx: unknown) => Promise<unknown>) => run(fakeDb),
};

void mock.module("../../src/db/index.ts", () => ({ db: fakeDb }));

const passkeys = await import("../../src/modules/users/services/passkey.service.ts");
const { passkeyChallenges } =
  await import("../../src/modules/users/services/passkey-challenge.service.ts");
const { hashPassword } =
  await import("../../src/modules/users/services/password.service.ts");
const { UserStoreError } = await import("../../src/modules/users/errors.ts");

const ORIGIN = "http://localhost";
const RP = { rpID: "localhost", origin: ORIGIN };
const USER = { userId: "usr_1", email: "member@example.com", sessionId: "ses_1" };
const PASSWORD = "the account password, long enough";
const HASH = await hashPassword(PASSWORD);
const PENDING = { sessionId: "ses_pending", userId: USER.userId, email: USER.email };

/** A limiter that counts calls and limits on demand. */
function limiter(limited = false): {
  isLimited: () => boolean;
  record: () => void;
  clear: () => void;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    isLimited: () => {
      calls.push("isLimited");
      return limited;
    },
    record: () => {
      calls.push("record");
    },
    clear: () => {
      calls.push("clear");
    },
  };
}

beforeEach(() => {
  for (const op of ["select", "insert", "update", "delete"] as const) queues[op] = [];
  captured.values = [];
  captured.set = [];
  passkeyChallenges.clear();
});

afterEach(() => {
  setSystemTime();
});

/** The row the service stored for a registration (the first `values` with a public key). */
function storedRow(counter = 0): {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  name: string;
  transports: string | null;
} {
  for (const value of captured.values) {
    if (typeof value !== "object" || value === null) continue;
    const credentialId: unknown = Reflect.get(value, "providerAccountId");
    const publicKey: unknown = Reflect.get(value, "publicKey");
    if (typeof credentialId === "string" && typeof publicKey === "string") {
      return {
        id: "crd_1",
        userId: USER.userId,
        credentialId,
        publicKey,
        counter,
        name: "Laptop",
        transports: "internal",
      };
    }
  }
  throw new Error("no passkey row was stored");
}

/** Registers a software authenticator through the service; returns it and the stored row. */
async function registered(
  options: { counter?: number; hadSecondFactor?: boolean } = {},
): Promise<{ authenticator: TestAuthenticator; row: ReturnType<typeof storedRow> }> {
  const authenticator = await TestAuthenticator.create(ORIGIN, {
    counter: options.counter,
  });
  queues.select.push([{ secretHash: HASH }], []);
  const started = await passkeys.startRegistration(
    { ...USER, password: PASSWORD, name: "Laptop" },
    limiter(),
    RP,
  );
  if (!started.ok) throw new Error(started.reason);
  queues.select.push([{ had: options.hadSecondFactor ?? false }]);
  queues.delete.push([{ id: "ses_other" }]);
  const finished = await passkeys.finishRegistration(
    {
      userId: USER.userId,
      sessionId: USER.sessionId,
      response: await authenticator.register(started.options),
    },
    RP,
  );
  if (!finished.ok) throw new Error(finished.reason);
  const row = storedRow(options.counter ?? 0);
  captured.values = [];
  captured.set = [];
  return { authenticator, row };
}

describe("startRegistration", () => {
  test("the name first, then the budget, then one password check", async () => {
    const bad = await passkeys.startRegistration(
      { ...USER, password: PASSWORD, name: "" },
      limiter(),
      RP,
    );
    expect(bad).toEqual({
      ok: false,
      reason: "invalid_name",
      problem: "Give the passkey a name.",
    });

    const limited = limiter(true);
    expect(
      await passkeys.startRegistration(
        { ...USER, password: PASSWORD, name: "Key" },
        limited,
        RP,
      ),
    ).toEqual({ ok: false, reason: "rate_limited" });
    expect(limited.calls).toEqual(["isLimited"]);

    const wrong = limiter();
    queues.select.push([{ secretHash: HASH }]);
    expect(
      await passkeys.startRegistration(
        { ...USER, password: "not it", name: "Key" },
        wrong,
        RP,
      ),
    ).toEqual({ ok: false, reason: "wrong_password" });
    expect(wrong.calls).toEqual(["isLimited", "record"]);

    queues.select.push([]);
    expect(
      await passkeys.startRegistration(
        { ...USER, password: PASSWORD, name: "Key" },
        limiter(),
        RP,
      ),
    ).toEqual({ ok: false, reason: "wrong_password" });
  });

  test("options: discoverable, user verification required, no attestation, existing passkeys excluded", async () => {
    const ok = limiter();
    queues.select.push(
      [{ secretHash: HASH }],
      [
        {
          id: "crd_old",
          userId: USER.userId,
          credentialId: "b2xk",
          publicKey: "a2V5",
          counter: null,
          name: null,
          transports: "usb",
        },
        /** A broken row (no key) is skipped. */
        {
          id: "crd_bad",
          userId: USER.userId,
          credentialId: null,
          publicKey: null,
          counter: 0,
          name: "x",
          transports: null,
        },
      ],
    );
    const result = await passkeys.startRegistration(
      { ...USER, password: PASSWORD, name: "Key" },
      ok,
      RP,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(ok.calls).toEqual(["isLimited", "record", "clear"]);
    expect(result.options.rp).toEqual({ name: "BunMail", id: "localhost" });
    expect(result.options.attestation).toBe("none");
    expect(result.options.authenticatorSelection).toEqual({
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    });
    expect(result.options.excludeCredentials).toEqual([
      { id: "b2xk", type: "public-key", transports: ["usb"] },
    ]);
    expect(Buffer.from(result.options.user.id, "base64url").toString()).toBe(USER.userId);
    expect(passkeyChallenges.take("register", USER.sessionId)?.challenge).toBe(
      result.options.challenge,
    );
  });
});

describe("finishRegistration", () => {
  test("the first second factor: stored, other sessions signed out, this one raised, audited", async () => {
    const authenticator = await TestAuthenticator.create(ORIGIN);
    queues.select.push([{ secretHash: HASH }], []);
    const started = await passkeys.startRegistration(
      { ...USER, password: PASSWORD, name: "Laptop" },
      limiter(),
      RP,
    );
    if (!started.ok) throw new Error(started.reason);
    queues.select.push([{ had: false }]);
    queues.delete.push([{ id: "ses_a" }, { id: "ses_b" }]);
    const result = await passkeys.finishRegistration(
      {
        userId: USER.userId,
        sessionId: USER.sessionId,
        response: await authenticator.register(started.options),
      },
      RP,
      { ip: "203.0.113.1", userAgent: "UA" },
    );
    expect(result).toEqual({
      ok: true,
      credentialId: expect.stringMatching(/^crd_/),
      name: "Laptop",
      sessionsRevoked: 2,
    });
    expect(storedRow().credentialId).toBe(authenticator.credentialId);
    expect(captured.set).toContainEqual({ assurance: "mfa" });
    const audit = captured.values.find(
      (v) =>
        typeof v === "object" &&
        v !== null &&
        Reflect.get(v, "action") === "auth.passkey.added",
    );
    expect(audit).toBeDefined();
  });

  test("not the first second factor: no session is signed out", async () => {
    const authenticator = await TestAuthenticator.create(ORIGIN);
    queues.select.push([{ secretHash: HASH }], []);
    const started = await passkeys.startRegistration(
      { ...USER, password: PASSWORD, name: "Laptop" },
      limiter(),
      RP,
    );
    if (!started.ok) throw new Error(started.reason);
    queues.select.push([{ had: true }]);
    const result = await passkeys.finishRegistration(
      {
        userId: USER.userId,
        sessionId: USER.sessionId,
        response: await authenticator.register(started.options),
      },
      RP,
    );
    expect(result.ok && result.sessionsRevoked).toBe(0);
  });

  test("no challenge, another account's challenge, a malformed or unverifiable response, a gone account, a duplicate", async () => {
    expect(
      await passkeys.finishRegistration(
        { userId: USER.userId, sessionId: "ses_none", response: null },
        RP,
      ),
    ).toEqual({ ok: false, reason: "no_challenge" });

    passkeyChallenges.issue("register", USER.sessionId, {
      userId: "usr_other",
      name: "x",
    });
    expect(
      await passkeys.finishRegistration(
        { userId: USER.userId, sessionId: USER.sessionId, response: null },
        RP,
      ),
    ).toEqual({ ok: false, reason: "no_challenge" });

    passkeyChallenges.issue("register", USER.sessionId, {
      userId: USER.userId,
      name: "x",
    });
    expect(
      await passkeys.finishRegistration(
        { userId: USER.userId, sessionId: USER.sessionId, response: null },
        RP,
      ),
    ).toEqual({ ok: false, reason: "rejected" });

    const authenticator = await TestAuthenticator.create(ORIGIN);
    for (const overrides of [
      { origin: "https://evil.example" },
      { userVerified: false },
    ]) {
      queues.select.push([{ secretHash: HASH }], []);
      const started = await passkeys.startRegistration(
        { ...USER, password: PASSWORD, name: "Laptop" },
        limiter(),
        RP,
      );
      if (!started.ok) throw new Error(started.reason);
      expect(
        await passkeys.finishRegistration(
          {
            userId: USER.userId,
            sessionId: USER.sessionId,
            response: await authenticator.register(started.options, overrides),
          },
          RP,
        ),
      ).toEqual({ ok: false, reason: "rejected" });
    }

    for (const [select, insert, expected] of [
      [[], undefined, "no_challenge"],
      [
        [{ had: false }],
        new DrizzleQueryError(
          "insert",
          [],
          Object.assign(new Error("dup"), { errno: "23505" }),
        ),
        "already_registered",
      ],
    ] as const) {
      queues.select.push([{ secretHash: HASH }], []);
      const started = await passkeys.startRegistration(
        { ...USER, password: PASSWORD, name: "Laptop" },
        limiter(),
        RP,
      );
      if (!started.ok) throw new Error(started.reason);
      queues.select.push(select);
      if (insert) queues.insert.push(insert);
      const result = await passkeys.finishRegistration(
        {
          userId: USER.userId,
          sessionId: USER.sessionId,
          response: await authenticator.register(started.options),
        },
        RP,
      );
      expect(result).toEqual({ ok: false, reason: expected });
    }

    /** Any other database error leaves sanitized. */
    queues.select.push([{ secretHash: HASH }], []);
    const started = await passkeys.startRegistration(
      { ...USER, password: PASSWORD, name: "Laptop" },
      limiter(),
      RP,
    );
    if (!started.ok) throw new Error(started.reason);
    queues.select.push([{ had: false }]);
    queues.insert.push(
      new DrizzleQueryError(
        "insert",
        ["secret"],
        Object.assign(new Error("x"), { errno: "XX000" }),
      ),
    );
    const failed = passkeys.finishRegistration(
      {
        userId: USER.userId,
        sessionId: USER.sessionId,
        response: await authenticator.register(started.options),
      },
      RP,
    );
    let thrown: unknown = null;
    try {
      await failed;
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UserStoreError);
  });
});

describe("passwordless sign-in", () => {
  test("a verified assertion signs in; the counter is stored", async () => {
    const { authenticator, row } = await registered({ counter: 1 });
    const { binding, options } = await passkeys.startPasskeySignIn(RP);
    expect(binding).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(options.allowCredentials ?? []).toEqual([]);
    expect(options.userVerification).toBe("required");
    queues.select.push([row], [{ email: USER.email, disabledAt: null }]);
    const result = await passkeys.completePasskeySignIn(
      binding,
      await authenticator.assert(options),
      RP,
    );
    expect(result).toEqual({
      ok: true,
      userId: USER.userId,
      email: USER.email,
      credentialId: "crd_1",
    });
    expect(captured.set[0]).toMatchObject({ counter: 2 });
  });

  test("each refusal", async () => {
    const { authenticator, row } = await registered({ counter: 5 });
    expect(await passkeys.completePasskeySignIn("x".repeat(43), null, RP)).toEqual({
      ok: false,
      reason: "no_challenge",
    });

    const start = async (): Promise<{ binding: string; challenge: string }> => {
      const { binding, options } = await passkeys.startPasskeySignIn(RP);
      return { binding, challenge: options.challenge };
    };

    let s = await start();
    expect(await passkeys.completePasskeySignIn(s.binding, null, RP)).toEqual({
      ok: false,
      reason: "rejected",
    });

    s = await start();
    const noHandle = await authenticator.assert(
      { challenge: s.challenge, rpId: "localhost" },
      { userHandle: null },
    );
    expect(await passkeys.completePasskeySignIn(s.binding, noHandle, RP)).toEqual({
      ok: false,
      reason: "rejected",
    });

    s = await start();
    queues.select.push([]);
    expect(
      await passkeys.completePasskeySignIn(
        s.binding,
        await authenticator.assert({ challenge: s.challenge, rpId: "localhost" }),
        RP,
      ),
    ).toEqual({ ok: false, reason: "unknown_credential" });

    for (const overrides of [
      { badSignature: true },
      { origin: "https://evil.example" },
      { rpID: "evil.example" },
      { userHandle: Buffer.from("usr_other").toString("base64url") },
    ]) {
      s = await start();
      queues.select.push([row]);
      expect(
        await passkeys.completePasskeySignIn(
          s.binding,
          await authenticator.assert(
            { challenge: s.challenge, rpId: "localhost" },
            overrides,
          ),
          RP,
        ),
      ).toEqual({ ok: false, reason: "rejected", userId: USER.userId });
    }

    s = await start();
    queues.select.push([row], [{ email: USER.email, disabledAt: new Date() }]);
    expect(
      await passkeys.completePasskeySignIn(
        s.binding,
        await authenticator.assert(
          { challenge: s.challenge, rpId: "localhost" },
          { counter: 9 },
        ),
        RP,
      ),
    ).toEqual({ ok: false, reason: "account_disabled", userId: USER.userId });

    s = await start();
    queues.select.push([row], [{ email: USER.email }]);
    const regressed = await passkeys.completePasskeySignIn(
      s.binding,
      await authenticator.assert(
        { challenge: s.challenge, rpId: "localhost" },
        { counter: 4 },
      ),
      RP,
      { ip: "203.0.113.9", userAgent: null },
    );
    expect(regressed).toEqual({
      ok: false,
      reason: "counter_regressed",
      userId: USER.userId,
      passkey: { id: "crd_1", name: "Laptop", userId: USER.userId, email: USER.email },
    });
    expect(captured.values).toContainEqual(
      expect.objectContaining({
        action: "auth.passkey.counter_regressed",
        metadata: { storedCounter: 5, receivedCounter: 4 },
      }),
    );
  });

  test("an expired challenge is refused", async () => {
    setSystemTime(new Date(Date.UTC(2027, 0, 1)));
    const { binding } = await passkeys.startPasskeySignIn(RP);
    setSystemTime(new Date(Date.UTC(2027, 0, 1, 0, 5, 0)));
    expect(await passkeys.completePasskeySignIn(binding, null, RP)).toEqual({
      ok: false,
      reason: "no_challenge",
    });
  });

  test("openPasskeySession opens an mfa session bound to the passkey", async () => {
    const session = await passkeys.openPasskeySession("usr_1", "crd_1", {
      ip: "203.0.113.1",
      userAgent: "UA",
    });
    expect(session.sessionId).toMatch(/^ses_/);
    expect(captured.values[0]).toMatchObject({
      userId: "usr_1",
      assurance: "mfa",
      authMethod: "passkey",
      credentialId: "crd_1",
    });
  });
});

describe("the second login step", () => {
  test("options list the account's passkeys; none: null", async () => {
    expect(await passkeys.startPasskeyTwoFactor(PENDING, RP)).toBeNull();
    const { row } = await registered();
    queues.select.push([row]);
    const options = await passkeys.startPasskeyTwoFactor(PENDING, RP);
    expect(options?.allowCredentials).toEqual([
      { id: row.credentialId, type: "public-key", transports: ["internal"] },
    ]);
  });

  test("a verified assertion completes the pending session", async () => {
    const { authenticator, row } = await registered();
    queues.select.push([row]);
    const options = await passkeys.startPasskeyTwoFactor(PENDING, RP);
    if (!options) throw new Error("no options");
    queues.select.push([{ id: PENDING.sessionId }], [row]);
    queues.update.push([], [{ maxAgeSec: 600 }]);
    const budget = limiter();
    const result = await passkeys.completePasskeyTwoFactor(
      PENDING,
      "t".repeat(43),
      await authenticator.assert(options),
      budget,
      RP,
    );
    expect(result).toEqual({
      ok: true,
      credentialId: "crd_1",
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      maxAgeSec: 600,
    });
    expect(budget.calls).toEqual(["isLimited", "record"]);
    expect(captured.set[1]).toMatchObject({ assurance: "mfa" });
  });

  test("each refusal, the budget counted first", async () => {
    const { authenticator, row } = await registered({ counter: 3 });
    const token = "t".repeat(43);
    expect(
      await passkeys.completePasskeyTwoFactor(PENDING, token, null, limiter(true), RP),
    ).toEqual({ ok: false, reason: "rate_limited" });
    expect(
      await passkeys.completePasskeyTwoFactor(PENDING, token, null, limiter(), RP),
    ).toEqual({
      ok: false,
      reason: "no_challenge",
    });

    const start = async (): Promise<string> => {
      queues.select.push([row]);
      const options = await passkeys.startPasskeyTwoFactor(PENDING, RP);
      if (!options) throw new Error("no options");
      return options.challenge;
    };

    await start();
    expect(
      await passkeys.completePasskeyTwoFactor(PENDING, token, null, limiter(), RP),
    ).toEqual({
      ok: false,
      reason: "rejected",
    });

    let challenge = await start();
    queues.select.push([]);
    expect(
      await passkeys.completePasskeyTwoFactor(
        PENDING,
        token,
        await authenticator.assert({ challenge, rpId: "localhost" }),
        limiter(),
        RP,
      ),
    ).toEqual({ ok: false, reason: "session_gone" });

    challenge = await start();
    queues.select.push([{ id: PENDING.sessionId }], []);
    expect(
      await passkeys.completePasskeyTwoFactor(
        PENDING,
        token,
        await authenticator.assert({ challenge, rpId: "localhost" }),
        limiter(),
        RP,
      ),
    ).toEqual({ ok: false, reason: "unknown_credential" });

    challenge = await start();
    queues.select.push([{ id: PENDING.sessionId }], [row]);
    expect(
      await passkeys.completePasskeyTwoFactor(
        PENDING,
        token,
        await authenticator.assert(
          { challenge, rpId: "localhost" },
          { userVerified: false },
        ),
        limiter(),
        RP,
      ),
    ).toEqual({ ok: false, reason: "rejected" });

    challenge = await start();
    queues.select.push([{ id: PENDING.sessionId }], [row], [{ email: USER.email }]);
    const regressed = await passkeys.completePasskeyTwoFactor(
      PENDING,
      token,
      await authenticator.assert({ challenge, rpId: "localhost" }, { counter: 3 }),
      limiter(),
      RP,
    );
    expect(regressed).toMatchObject({ ok: false, reason: "counter_regressed" });
  });
});

describe("managing", () => {
  test("listPasskeys: name, dates; a missing name reads as Passkey", async () => {
    const createdAt = new Date();
    queues.select.push([
      { id: "crd_1", name: "Laptop", createdAt, lastUsedAt: null },
      { id: "crd_2", name: null, createdAt, lastUsedAt: createdAt },
    ]);
    expect(await passkeys.listPasskeys(USER.userId)).toEqual([
      { id: "crd_1", name: "Laptop", createdAt, lastUsedAt: null },
      { id: "crd_2", name: "Passkey", createdAt, lastUsedAt: createdAt },
    ]);
  });

  test("renamePasskey: the policy, then the owner's row only", async () => {
    expect(await passkeys.renamePasskey(USER.userId, "crd_1", "x".repeat(65))).toEqual({
      ok: false,
      reason: "invalid_name",
      problem: "The name can be at most 64 characters.",
    });
    queues.update.push([]);
    expect(await passkeys.renamePasskey(USER.userId, "crd_1", "Desk")).toEqual({
      ok: false,
      reason: "not_found",
    });
    queues.update.push([{ id: "crd_1" }]);
    expect(await passkeys.renamePasskey(USER.userId, "crd_1", "Desk")).toEqual({
      ok: true,
    });
    expect(captured.set.at(-1)).toMatchObject({ name: "Desk" });
  });

  test("deletePasskey: found first, then the budget and the password, then removed and audited", async () => {
    queues.select.push([]);
    const untouched = limiter();
    expect(
      await passkeys.deletePasskey(USER.userId, "crd_x", PASSWORD, untouched),
    ).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(untouched.calls).toEqual([]);

    queues.select.push([{ id: "crd_1" }]);
    expect(
      await passkeys.deletePasskey(USER.userId, "crd_1", PASSWORD, limiter(true)),
    ).toEqual({
      ok: false,
      reason: "rate_limited",
    });

    queues.select.push([{ id: "crd_1" }], [{ secretHash: HASH }]);
    expect(
      await passkeys.deletePasskey(USER.userId, "crd_1", "wrong", limiter()),
    ).toEqual({
      ok: false,
      reason: "wrong_password",
    });

    queues.select.push([{ id: "crd_1" }], [{ secretHash: HASH }]);
    queues.delete.push([]);
    expect(
      await passkeys.deletePasskey(USER.userId, "crd_1", PASSWORD, limiter()),
    ).toEqual({
      ok: false,
      reason: "not_found",
    });

    queues.select.push([{ id: "crd_1" }], [{ secretHash: HASH }]);
    queues.delete.push([{ name: null }]);
    const budget = limiter();
    expect(await passkeys.deletePasskey(USER.userId, "crd_1", PASSWORD, budget)).toEqual({
      ok: true,
      name: "Passkey",
    });
    expect(budget.calls).toEqual(["isLimited", "record", "clear"]);
    expect(captured.values).toContainEqual(
      expect.objectContaining({ action: "auth.passkey.removed", targetId: "crd_1" }),
    );
  });
});
