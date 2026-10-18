/**
 * Owner bootstrap and the one-time setup link (#215), against real
 * Postgres: the state machine, the `bunmail:owner` advisory lock taken
 * through drizzle on bun-sql, single use, expiry on the database clock,
 * recovery, and the `reset-owner.ts` script itself.
 */
import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { join } from "path";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, seed, truncateAll } from "./_helpers.ts";
import { users } from "../../src/modules/users/models/user.schema.ts";
import { userCredentials } from "../../src/modules/users/models/user-credential.schema.ts";
import { userTokens } from "../../src/modules/users/models/user-token.schema.ts";
import {
  bootstrapOwner,
  completeOwnerSetup,
  findLiveOwnerSetup,
  issueOwnerSetupLink,
} from "../../src/modules/users/services/owner.service.ts";
import { OWNER_SETUP_TTL_MS } from "../../src/modules/users/services/owner-setup-policy.service.ts";
import { verifyPassword } from "../../src/modules/users/services/password.service.ts";
import { generateId } from "../../src/utils/id.ts";
import { hashToken, mintToken } from "../../src/modules/users/services/token.service.ts";

const OWNER_EMAIL = "owner@example.com";
const PASSWORD = "correct horse battery staple";

beforeEach(async () => {
  await truncateAll();
});

/** Every owner row. */
function owners(): Promise<Array<{ id: string; email: string; role: string }>> {
  return db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.role, "owner"));
}

/** Live `owner_setup` tokens (unspent, unrevoked, unexpired by the DB clock). */
function liveSetupTokens(): Promise<Array<{ userId: string | null; tokenHash: string }>> {
  return db
    .select({ userId: userTokens.userId, tokenHash: userTokens.tokenHash })
    .from(userTokens)
    .where(
      and(
        eq(userTokens.purpose, "owner_setup"),
        isNull(userTokens.usedAt),
        isNull(userTokens.revokedAt),
        gt(userTokens.expiresAt, sql`now()`),
      ),
    );
}

/** The stored password hashes of a user. */
async function passwordHashes(userId: string): Promise<string[]> {
  const rows = await db
    .select({ secretHash: userCredentials.secretHash })
    .from(userCredentials)
    .where(and(eq(userCredentials.userId, userId), eq(userCredentials.type, "password")));
  return rows.map((r) => r.secretHash ?? "");
}

/** Number of `user_tokens` rows of any state. */
async function tokenCount(): Promise<number> {
  return (await db.select({ id: userTokens.id }).from(userTokens)).length;
}

/** Bootstraps a fresh owner and returns its first raw token. */
async function freshOwnerToken(email: string = OWNER_EMAIL): Promise<string> {
  const result = await bootstrapOwner(email);
  if (result.kind !== "created") throw new Error(`expected created, got ${result.kind}`);
  return result.token;
}

/**
 * Holds the owner advisory lock in its own transaction until `release()`;
 * `held` resolves once the lock is taken, `done` when the transaction ends.
 */
function holdOwnerLock(): {
  held: Promise<void>;
  release: () => void;
  done: Promise<void>;
} {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal = (): void => {};
  const held = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const done = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('bunmail:owner'))`);
    signal();
    await gate;
  });
  return { held, release, done };
}

/** Polls `pg_locks` until some session waits on an advisory lock. */
async function waitForAdvisoryLockWaiter(timeoutMs: number = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.execute(
      sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
    );
    if (Number(rows[0]?.["n"]) > 0) return true;
    await Bun.sleep(20);
  }
  return false;
}

describe("fresh install", () => {
  test("creates exactly one lower-cased owner and one live hashed token", async () => {
    const now = new Date();
    const result = await bootstrapOwner("  Owner@Example.COM ", now);

    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    expect(result.email).toBe(OWNER_EMAIL);
    expect(result.expiresAt.getTime()).toBe(now.getTime() + OWNER_SETUP_TTL_MS);

    const rows = await owners();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe(OWNER_EMAIL);

    const live = await liveSetupTokens();
    expect(live).toHaveLength(1);
    expect(live[0]?.tokenHash).toBe(hashToken(result.token));
    expect(live[0]?.userId).toBe(rows[0]?.id ?? "");

    const [stored] = await db
      .select({ expiresAt: userTokens.expiresAt })
      .from(userTokens)
      .where(eq(userTokens.tokenHash, hashToken(result.token)));
    expect(stored?.expiresAt.getTime()).toBe(now.getTime() + OWNER_SETUP_TTL_MS);

    /** Setup through the logs does not prove mailbox control. */
    const [user] = await db
      .select({ emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.email, OWNER_EMAIL));
    expect(user?.emailVerifiedAt).toBeNull();
  });

  test("the token finds the owner, read-only", async () => {
    const token = await freshOwnerToken();
    const found = await findLiveOwnerSetup(token);
    expect(found?.email).toBe(OWNER_EMAIL);
    /** Looking it up does not spend it. */
    expect(await findLiveOwnerSetup(token)).not.toBeNull();
    expect(await liveSetupTokens()).toHaveLength(1);
  });
});

describe("restart before setup", () => {
  test("reissues: one owner, the old link revoked, exactly one live link", async () => {
    const first = await freshOwnerToken();
    const second = await bootstrapOwner(OWNER_EMAIL);

    expect(second.kind).toBe("reissued");
    if (second.kind !== "reissued") return;
    expect(second.token).not.toBe(first);
    expect(await owners()).toHaveLength(1);

    const [old] = await db
      .select({ revokedAt: userTokens.revokedAt })
      .from(userTokens)
      .where(eq(userTokens.tokenHash, hashToken(first)));
    expect(old?.revokedAt).not.toBeNull();

    const live = await liveSetupTokens();
    expect(live).toHaveLength(1);
    expect(live[0]?.tokenHash).toBe(hashToken(second.token));

    expect(await findLiveOwnerSetup(first)).toBeNull();
    expect(await completeOwnerSetup(first, PASSWORD)).toBeNull();
    expect(await findLiveOwnerSetup(second.token)).not.toBeNull();
  });

  test("a changed env email updates the stored email while setup is pending", async () => {
    await freshOwnerToken();
    const result = await bootstrapOwner("New.Owner@Example.org");

    expect(result.kind).toBe("reissued");
    if (result.kind !== "reissued") return;
    expect(result.email).toBe("new.owner@example.org");
    const rows = await owners();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe("new.owner@example.org");
    expect(await liveSetupTokens()).toHaveLength(1);
  });

  test("a pending owner never takes an email another account holds", async () => {
    await freshOwnerToken();
    await db.insert(users).values({
      id: generateId("usr"),
      email: "member@example.com",
      role: "member",
    });

    expect((await bootstrapOwner("member@example.com")).kind).toBe("email-taken");
    expect((await owners())[0]?.email).toBe(OWNER_EMAIL);
  });
});

describe("concurrency (advisory lock)", () => {
  test("five parallel bootstraps on an empty database: one owner, one live link", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => bootstrapOwner(OWNER_EMAIL)),
    );

    expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "reissued")).toHaveLength(4);
    expect(await owners()).toHaveLength(1);

    const live = await liveSetupTokens();
    expect(live).toHaveLength(1);
    /** The live one is one of the returned links; the other four are dead. */
    const liveTokens = results.filter(
      (r) =>
        (r.kind === "created" || r.kind === "reissued") &&
        hashToken(r.token) === live[0]?.tokenHash,
    );
    expect(liveTokens).toHaveLength(1);
  });

  test("two parallel completions of one token: exactly one wins", async () => {
    const token = await freshOwnerToken();
    const passwords = ["first password is long enough", "second password is long enough"];

    const results = await Promise.all(passwords.map((p) => completeOwnerSetup(token, p)));
    const winners = results.flatMap((r, i) => (r ? [i] : []));
    expect(winners).toHaveLength(1);

    const [owner] = await owners();
    const hashes = await passwordHashes(owner?.id ?? "");
    expect(hashes).toHaveLength(1);
    const winner = winners[0] ?? 0;
    expect(await verifyPassword(passwords[winner] ?? "", hashes[0] ?? "")).toBe(true);
    expect(await verifyPassword(passwords[1 - winner] ?? "", hashes[0] ?? "")).toBe(
      false,
    );
  });

  test("bootstrap racing completion never leaves a live link next to a password", async () => {
    for (let trial = 0; trial < 5; trial++) {
      await truncateAll();
      const token = await freshOwnerToken();

      await Promise.all([
        completeOwnerSetup(token, PASSWORD),
        bootstrapOwner(OWNER_EMAIL),
      ]);

      const [owner] = await owners();
      const hashes = await passwordHashes(owner?.id ?? "");
      const live = await liveSetupTokens();
      if (hashes.length > 0) {
        expect(live).toHaveLength(0);
      } else {
        /** Bootstrap won: the old link died, the new one is the only one. */
        expect(live).toHaveLength(1);
        expect(live[0]?.tokenHash).not.toBe(hashToken(token));
      }
    }
  });

  /**
   * Deterministic proof that the writes take the owner lock. The racing
   * test above cannot show it: argon2id makes completion reach its writes
   * long after a parallel bootstrap committed, so bootstrap always wins.
   * Here the lock is held by another transaction; each call must block on
   * it (visible in `pg_locks`) and finish only after the lock is released.
   */
  test.each([
    ["completeOwnerSetup", (token: string) => completeOwnerSetup(token, PASSWORD)],
    ["issueOwnerSetupLink", (_token: string) => issueOwnerSetupLink(OWNER_EMAIL)],
  ] as const)(
    "%s waits for the owner lock",
    async (_name, run) => {
      const token = await freshOwnerToken();
      const lock = holdOwnerLock();
      try {
        await lock.held;
        let settled = false;
        const call = run(token).then((result) => {
          settled = true;
          return result;
        });

        expect(await waitForAdvisoryLockWaiter()).toBe(true);
        expect(settled).toBe(false);

        lock.release();
        await lock.done;
        expect(await call).not.toBeNull();
      } finally {
        lock.release();
        await lock.done;
      }
    },
    30_000,
  );

  test("the lock is released after the transaction", async () => {
    await bootstrapOwner(OWNER_EMAIL);
    const rows = await db.transaction((tx) =>
      tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext('bunmail:owner')) AS got`),
    );
    expect(rows[0]?.["got"]).toBe(true);
  });
});

describe("expiry, single use, disabled owner", () => {
  test("an expired token is dead for both lookup and completion", async () => {
    const token = await freshOwnerToken();
    await db
      .update(userTokens)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(userTokens.tokenHash, hashToken(token)));

    expect(await findLiveOwnerSetup(token)).toBeNull();
    expect(await completeOwnerSetup(token, PASSWORD)).toBeNull();
  });

  test("a token works once and is marked used", async () => {
    const token = await freshOwnerToken();

    const done = await completeOwnerSetup(token, PASSWORD);
    expect(done?.email).toBe(OWNER_EMAIL);
    expect(await completeOwnerSetup(token, "another password, long enough")).toBeNull();
    expect(await findLiveOwnerSetup(token)).toBeNull();

    const [row] = await db
      .select({ usedAt: userTokens.usedAt })
      .from(userTokens)
      .where(eq(userTokens.tokenHash, hashToken(token)));
    expect(row?.usedAt).not.toBeNull();

    const hashes = await passwordHashes(done?.userId ?? "");
    expect(hashes).toHaveLength(1);
    expect(await verifyPassword(PASSWORD, hashes[0] ?? "")).toBe(true);
  });

  test("completion revokes the owner's other open tokens", async () => {
    const token = await freshOwnerToken();
    const [owner] = await owners();
    /** A stray open token of the owner (say a password reset). */
    const stray = mintToken();
    await db.insert(userTokens).values({
      id: generateId("utk"),
      userId: owner?.id ?? "",
      purpose: "password_reset",
      tokenHash: stray.hash,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await completeOwnerSetup(token, PASSWORD);

    const [row] = await db
      .select({ revokedAt: userTokens.revokedAt })
      .from(userTokens)
      .where(eq(userTokens.tokenHash, stray.hash));
    expect(row?.revokedAt).not.toBeNull();
  });

  test("a disabled owner's token is rejected", async () => {
    const token = await freshOwnerToken();
    await db
      .update(users)
      .set({ disabledAt: sql`now()` })
      .where(eq(users.role, "owner"));

    expect(await findLiveOwnerSetup(token)).toBeNull();
    expect(await completeOwnerSetup(token, PASSWORD)).toBeNull();
  });

  test("an owner disabled after the pre-check but before the write is still rejected", async () => {
    /**
     * The read-only pre-check passes, then completion hashes and waits on
     * the owner lock; the owner is disabled meanwhile. The check inside
     * the lock must catch it: no password, token not spent.
     */
    const token = await freshOwnerToken();
    const lock = holdOwnerLock();
    try {
      await lock.held;
      const call = completeOwnerSetup(token, PASSWORD);
      expect(await waitForAdvisoryLockWaiter()).toBe(true);

      await db
        .update(users)
        .set({ disabledAt: sql`now()` })
        .where(eq(users.role, "owner"));

      lock.release();
      await lock.done;
      expect(await call).toBeNull();

      const [owner] = await owners();
      expect(await passwordHashes(owner?.id ?? "")).toHaveLength(0);
      expect(await liveSetupTokens()).toHaveLength(1);
    } finally {
      lock.release();
      await lock.done;
    }
  }, 30_000);

  test("an unknown token never reaches argon2", async () => {
    await freshOwnerToken();
    const hashSpy = spyOn(Bun.password, "hash");
    try {
      expect(await completeOwnerSetup(mintToken().token, PASSWORD)).toBeNull();
      expect(hashSpy).not.toHaveBeenCalled();
    } finally {
      hashSpy.mockRestore();
    }
  });
});

describe("after setup", () => {
  test("same email in any case: complete, no new link", async () => {
    await completeOwnerSetup(await freshOwnerToken(), PASSWORD);
    const before = await tokenCount();

    expect((await bootstrapOwner("OWNER@example.com")).kind).toBe("complete");
    expect(await tokenCount()).toBe(before);
    expect(await liveSetupTokens()).toHaveLength(0);
  });

  test("a different email: mismatch, nothing changes", async () => {
    await completeOwnerSetup(await freshOwnerToken(), PASSWORD);
    const before = await tokenCount();

    const result = await bootstrapOwner("someone-else@example.com");
    expect(result).toEqual({ kind: "mismatch", storedEmail: OWNER_EMAIL });
    expect((await owners())[0]?.email).toBe(OWNER_EMAIL);
    expect(await tokenCount()).toBe(before);
  });

  test("no owner and a member holding the email: email-taken, no promotion", async () => {
    await db.insert(users).values({
      id: generateId("usr"),
      email: OWNER_EMAIL,
      role: "member",
    });

    expect((await bootstrapOwner(OWNER_EMAIL)).kind).toBe("email-taken");
    expect(await owners()).toHaveLength(0);
    const [member] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.email, OWNER_EMAIL));
    expect(member?.role).toBe("member");
    expect(await tokenCount()).toBe(0);
  });
});

describe("recovery (issueOwnerSetupLink)", () => {
  test("an owner with a password gets a fresh link and keeps the password until it is used", async () => {
    const { id } = await seed.owner({
      email: OWNER_EMAIL,
      password: "the old password, long",
    });
    const abandoned = await issueOwnerSetupLink(OWNER_EMAIL);
    const link = await issueOwnerSetupLink(OWNER_EMAIL);

    expect(link.email).toBe(OWNER_EMAIL);
    const live = await liveSetupTokens();
    expect(live).toHaveLength(1);
    expect(live[0]?.tokenHash).toBe(hashToken(link.token));
    expect(await findLiveOwnerSetup(abandoned.token)).toBeNull();

    /** The old password still works until the new link is completed. */
    const before = await passwordHashes(id);
    expect(await verifyPassword("the old password, long", before[0] ?? "")).toBe(true);

    expect(await completeOwnerSetup(link.token, "the new password, long")).not.toBeNull();
    const after = await passwordHashes(id);
    expect(after).toHaveLength(1);
    expect(await verifyPassword("the new password, long", after[0] ?? "")).toBe(true);
    expect(await verifyPassword("the old password, long", after[0] ?? "")).toBe(false);
  });

  test("a differing env email keeps the stored one", async () => {
    await seed.owner({ email: OWNER_EMAIL, password: PASSWORD });
    const link = await issueOwnerSetupLink("someone-else@example.com");
    expect(link.email).toBe(OWNER_EMAIL);
    expect((await owners())[0]?.email).toBe(OWNER_EMAIL);
  });

  test("no owner and an email: creates the owner", async () => {
    const link = await issueOwnerSetupLink("Owner@Example.com");
    expect(link.email).toBe(OWNER_EMAIL);
    expect(await owners()).toHaveLength(1);
    expect(await findLiveOwnerSetup(link.token)).not.toBeNull();
  });

  test("no owner and no email: throws", async () => {
    const error = await issueOwnerSetupLink(null).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("BUNMAIL_OWNER_EMAIL");
    expect(await owners()).toHaveLength(0);
  });
});

describe("src/db/reset-owner.ts", () => {
  const SCRIPT = join(import.meta.dir, "..", "..", "src", "db", "reset-owner.ts");

  /** Runs the script against the test database; returns exit code and output. */
  async function runScript(
    ownerEmail: string,
    logLevel: string = "info",
  ): Promise<{ code: number; output: string }> {
    const child = Bun.spawn([process.execPath, SCRIPT], {
      env: {
        ...process.env,
        BUNMAIL_ENV: "development",
        BUNMAIL_OWNER_EMAIL: ownerEmail,
        LOG_LEVEL: logLevel,
        APP_BASE_URL: "https://mail.example.com",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    /** The link goes to stdout, logger lines to stderr: read both streams. */
    return { code, output: out + err };
  }

  test("prints a link whose token is the only live one, exit 0", async () => {
    const { code, output } = await runScript(OWNER_EMAIL);
    expect(code).toBe(0);
    expect(output).toContain("Owner setup link");

    const match = output.match(
      /https:\/\/mail\.example\.com\/dashboard\/setup\?token=([A-Za-z0-9_-]{43})/,
    );
    const token = match?.[1] ?? "";
    expect(token).not.toBe("");

    const live = await liveSetupTokens();
    expect(live).toHaveLength(1);
    expect(live[0]?.tokenHash).toBe(hashToken(token));
    expect((await owners())[0]?.email).toBe(OWNER_EMAIL);
  });

  test("LOG_LEVEL=error cannot hide the link (it goes to stdout, not the logger)", async () => {
    const { code, output } = await runScript(OWNER_EMAIL, "error");
    expect(code).toBe(0);
    const match = output.match(
      /https:\/\/mail\.example\.com\/dashboard\/setup\?token=([A-Za-z0-9_-]{43})/,
    );
    const token = match?.[1] ?? "";
    expect(token).not.toBe("");
    const live = await liveSetupTokens();
    expect(live).toHaveLength(1);
    expect(live[0]?.tokenHash).toBe(hashToken(token));
  });

  test("with no owner and BUNMAIL_OWNER_EMAIL unset it exits 1", async () => {
    const { code, output } = await runScript("");
    expect(code).toBe(1);
    expect(output).toContain("Owner reset failed");
    expect(await owners()).toHaveLength(0);
  });
});
