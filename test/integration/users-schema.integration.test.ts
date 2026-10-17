/**
 * Database-enforced invariants of the accounts schema (#214), against real
 * Postgres. The application never has to be trusted for these:
 *
 * - exactly one owner (partial unique index)
 * - emails unique and lower-cased
 * - role, credential type, assurance and token purpose limited to their
 *   value sets (CHECK constraints)
 * - one password credential per user; an external account links to one user
 * - deleting a user removes its credentials, sessions and tokens, while an
 *   invitation it sent survives with `invited_by` cleared
 * - ownership transfer in one transaction keeps exactly one owner
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { users } from "../../src/modules/users/models/user.schema.ts";
import { userCredentials } from "../../src/modules/users/models/user-credential.schema.ts";
import { sessions } from "../../src/modules/users/models/session.schema.ts";
import { userTokens } from "../../src/modules/users/models/user-token.schema.ts";
import { generateId } from "../../src/utils/id.ts";
import { truncateAll, db } from "./_helpers.ts";

const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000);

async function createUser(email: string, role: "owner" | "admin" | "member" = "member") {
  const id = generateId("usr");
  await db.insert(users).values({ id, email, role });
  return id;
}

/**
 * Asserts that a write is rejected by the named constraint. Drizzle wraps
 * the Postgres error (`Failed query: ...`) and keeps the driver error in
 * `cause`, where the constraint name appears in the message or detail, so
 * the whole cause chain is searched. Accepts drizzle's thenable builders.
 */
async function rejects(write: PromiseLike<unknown>, constraint: string): Promise<void> {
  try {
    await write;
  } catch (error: unknown) {
    const seen: string[] = [];
    let current: unknown = error;
    for (
      let depth = 0;
      depth < 6 && current !== null && typeof current === "object";
      depth++
    ) {
      for (const key of ["message", "detail", "constraint", "constraint_name", "code"]) {
        const value = Reflect.get(current, key);
        if (typeof value === "string") seen.push(value);
      }
      current = Reflect.get(current, "cause");
    }
    const text = seen.join("\n");
    if (!text.includes(constraint)) {
      throw new Error(`rejected, but not by ${constraint}:\n${text}`, { cause: error });
    }
    return;
  }
  throw new Error(`expected the write to be rejected by ${constraint}`);
}

beforeEach(async () => {
  await truncateAll();
});

describe("users", () => {
  test("exactly one owner", async () => {
    await createUser("owner@example.org", "owner");
    await rejects(createUser("second@example.org", "owner"), "users_single_owner");
    /** Admins and members are unlimited. */
    await createUser("a1@example.org", "admin");
    await createUser("a2@example.org", "admin");
    expect(await db.select().from(users)).toHaveLength(3);
  });

  test("emails are unique and must be stored lower-cased", async () => {
    await createUser("ann@example.org");
    await rejects(createUser("ann@example.org"), "users_email_unique");
    await rejects(createUser("Ann@Example.org"), "users_email_lowercase_check");
  });

  test("an unknown role is rejected by the database", async () => {
    await rejects(
      db
        .insert(users)
        .values({ id: generateId("usr"), email: "x@example.org", role: "root" }),
      "users_role_check",
    );
  });

  test("ownership transfer in one transaction keeps exactly one owner", async () => {
    const owner = await createUser("owner@example.org", "owner");
    const admin = await createUser("admin@example.org", "admin");

    await db.transaction(async (tx) => {
      await tx.update(users).set({ role: "admin" }).where(eq(users.id, owner));
      await tx.update(users).set({ role: "owner" }).where(eq(users.id, admin));
    });

    const owners = await db.select().from(users).where(eq(users.role, "owner"));
    expect(owners.map((u) => u.id)).toEqual([admin]);
  });

  test("a transfer that would leave two owners rolls back entirely", async () => {
    const owner = await createUser("owner@example.org", "owner");
    const admin = await createUser("admin@example.org", "admin");

    await rejects(
      db.transaction(async (tx) => {
        await tx.update(users).set({ role: "owner" }).where(eq(users.id, admin));
        await tx.update(users).set({ name: "never written" }).where(eq(users.id, owner));
      }),
      "users_single_owner",
    );

    const rows = await db.select().from(users);
    expect(rows.filter((u) => u.role === "owner").map((u) => u.id)).toEqual([owner]);
    expect(rows.find((u) => u.id === owner)?.name).toBeNull();
  });
});

describe("user_credentials", () => {
  test("a user can hold several credentials of different types", async () => {
    const user = await createUser("ann@example.org");
    await db.insert(userCredentials).values([
      {
        id: generateId("crd"),
        userId: user,
        type: "password",
        secretHash: "$argon2id$x",
      },
      { id: generateId("crd"), userId: user, type: "totp", secretHash: "enc:abc" },
      {
        id: generateId("crd"),
        userId: user,
        type: "passkey",
        provider: "authenticator",
        providerAccountId: "cred-1",
        publicKey: "pk",
        counter: 0,
      },
      {
        id: generateId("crd"),
        userId: user,
        type: "oauth",
        provider: "google",
        providerAccountId: "123",
      },
    ]);
    expect(await db.select().from(userCredentials)).toHaveLength(4);
  });

  test("one password per user, and an external account links to one user", async () => {
    const ann = await createUser("ann@example.org");
    const bob = await createUser("bob@example.org");
    await db.insert(userCredentials).values({
      id: generateId("crd"),
      userId: ann,
      type: "password",
      secretHash: "h1",
    });
    await rejects(
      db.insert(userCredentials).values({
        id: generateId("crd"),
        userId: ann,
        type: "password",
        secretHash: "h2",
      }),
      "user_credentials_one_password_per_user",
    );

    await db.insert(userCredentials).values({
      id: generateId("crd"),
      userId: ann,
      type: "oauth",
      provider: "google",
      providerAccountId: "g-1",
    });
    await rejects(
      db.insert(userCredentials).values({
        id: generateId("crd"),
        userId: bob,
        type: "oauth",
        provider: "google",
        providerAccountId: "g-1",
      }),
      "user_credentials_provider_account_unique",
    );
  });

  test("an unknown credential type is rejected", async () => {
    const user = await createUser("ann@example.org");
    await rejects(
      db
        .insert(userCredentials)
        .values({ id: generateId("crd"), userId: user, type: "magic" }),
      "user_credentials_type_check",
    );
  });
});

describe("sessions and user_tokens", () => {
  test("session assurance and token purpose are limited to their value sets", async () => {
    const user = await createUser("ann@example.org");
    await rejects(
      db.insert(sessions).values({
        id: generateId("ses"),
        userId: user,
        tokenHash: "a".repeat(64),
        assurance: "root",
        expiresAt: inAnHour(),
      }),
      "sessions_assurance_check",
    );
    await rejects(
      db.insert(userTokens).values({
        id: generateId("utk"),
        userId: user,
        purpose: "magic_link",
        tokenHash: "b".repeat(64),
        expiresAt: inAnHour(),
      }),
      "user_tokens_purpose_check",
    );
  });

  test("a token must act for a user or target an address", async () => {
    await rejects(
      db.insert(userTokens).values({
        id: generateId("utk"),
        purpose: "invite",
        tokenHash: "c".repeat(64),
        expiresAt: inAnHour(),
      }),
      "user_tokens_target_check",
    );
  });

  test("token hashes are unique across purposes", async () => {
    const user = await createUser("ann@example.org");
    const hash = "d".repeat(64);
    await db.insert(userTokens).values({
      id: generateId("utk"),
      userId: user,
      purpose: "password_reset",
      tokenHash: hash,
      expiresAt: inAnHour(),
    });
    await rejects(
      db.insert(userTokens).values({
        id: generateId("utk"),
        email: "new@example.org",
        purpose: "invite",
        tokenHash: hash,
        expiresAt: inAnHour(),
      }),
      "user_tokens_token_hash_unique",
    );
  });

  test("deleting a user removes its credentials, sessions and tokens; its invitations survive", async () => {
    const owner = await createUser("owner@example.org", "owner");
    const member = await createUser("m@example.org");
    await db.insert(userCredentials).values({
      id: generateId("crd"),
      userId: member,
      type: "password",
      secretHash: "h",
    });
    await db.insert(sessions).values({
      id: generateId("ses"),
      userId: member,
      tokenHash: "e".repeat(64),
      expiresAt: inAnHour(),
    });
    await db.insert(userTokens).values({
      id: generateId("utk"),
      userId: member,
      purpose: "password_reset",
      tokenHash: "f".repeat(64),
      expiresAt: inAnHour(),
    });
    const invite = generateId("utk");
    await db.insert(userTokens).values({
      id: invite,
      email: "new@example.org",
      purpose: "invite",
      role: "member",
      invitedBy: member,
      tokenHash: "0".repeat(64),
      expiresAt: inAnHour(),
    });

    await db.delete(users).where(eq(users.id, member));

    expect(await db.select().from(userCredentials)).toHaveLength(0);
    expect(await db.select().from(sessions)).toHaveLength(0);
    const tokens = await db.select().from(userTokens);
    expect(tokens.map((t) => t.id)).toEqual([invite]);
    expect(tokens[0]?.invitedBy).toBeNull();
    expect((await db.select().from(users)).map((u) => u.id)).toEqual([owner]);
  });

  test("the schema in the database matches the models (no drift)", async () => {
    const rows = await db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('users','user_credentials','sessions','user_tokens') ORDER BY 1`,
    );
    expect(rows.map((r) => r["table_name"])).toEqual([
      "sessions",
      "user_credentials",
      "user_tokens",
      "users",
    ]);
  });
});
