import { and, eq, gt, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { withSanitizedErrors } from "../errors.ts";
import { generateId } from "../../../utils/id.ts";
import { users } from "../models/user.schema.ts";
import { userCredentials } from "../models/user-credential.schema.ts";
import { userTokens } from "../models/user-token.schema.ts";
import type {
  CompletedOwnerSetup,
  OwnerBootstrapResult,
  OwnerSetupLink,
  SessionClient,
  TokenPurpose,
  Tx,
} from "../types/user.types.ts";
import { setupTokenExpiry } from "./owner-setup-policy.service.ts";
import { hashPassword } from "./password.service.ts";
import { createSession, revokeAllUserSessions } from "./session.service.ts";
import { normalizeLoginEmail } from "./session-policy.service.ts";
import { hashToken, mintToken } from "./token.service.ts";

/**
 * The dashboard owner account and its one-time setup link (#215).
 *
 * `BUNMAIL_OWNER_EMAIL` names the owner. On boot `bootstrapOwner` creates
 * the account (or replaces a pending link) and hands back a raw token for
 * the caller to log; `/dashboard/setup` reads it with `findLiveOwnerSetup`
 * and spends it with `completeOwnerSetup`, which also signs the owner in
 * (#216); `src/db/reset-owner.ts` mints a fresh link with
 * `issueOwnerSetupLink`, which signs the owner out everywhere.
 *
 * Every write runs in one transaction under a Postgres advisory lock, so
 * replicas, crash loops, the reset script and a setup submission all
 * serialize: no unique violation on `users_single_owner` reaches the boot,
 * at most one live link exists, and a bootstrap racing a completion cannot
 * leave a live token next to a freshly set password (that token would work
 * as a password reset).
 *
 * Session changes (#216) run inside the same locked transaction: setup
 * completion and reset-owner delete every session of the owner, and
 * completion then opens the owner's new session, so no crash can leave an
 * old session alive next to a new password.
 *
 * Never logs the token or its hash; callers decide what to log. Database
 * errors leave this module as `UserStoreError` (SQLSTATE only), never as
 * drizzle's `Failed query ... params:` message, which would carry the
 * password hash, token hashes and the owner email into the logs.
 */

/**
 * Advisory-lock key for owner mutations. Namespaced like
 * `bunmail:migrations` (`src/db/migrate.ts`) and distinct from it.
 */
const OWNER_LOCK_KEY = "bunmail:owner";

/** The token purpose this service mints and spends. */
const OWNER_SETUP: TokenPurpose = "owner_setup";

/** The owner role value (`USER_ROLES`); exactly one row may carry it. */
const OWNER_ROLE = "owner";

/** The credential type the setup form writes. */
const PASSWORD_CREDENTIAL = "password";

/** The live owner a setup token acts for. */
interface OwnerSetupTarget {
  /** `users.id` of the owner. */
  userId: string;
  /** The owner's stored (lower-cased) email. */
  email: string;
}

/**
 * Runs `fn` in a transaction that first takes the owner advisory lock.
 * `pg_advisory_xact_lock` is transaction-scoped: Postgres releases it on
 * commit or rollback, so no unlock path can be missed.
 */
function withOwnerLock<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withSanitizedErrors(() =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${OWNER_LOCK_KEY}))`);
      return fn(tx);
    }),
  );
}

/**
 * The live-token predicate: this hash, an `owner_setup` token, not spent,
 * not revoked, not expired. Expiry is checked against the database clock
 * (`now()`), so replicas with skewed clocks agree.
 */
function liveSetupToken(tokenHash: string): SQL | undefined {
  return and(
    eq(userTokens.tokenHash, tokenHash),
    eq(userTokens.purpose, OWNER_SETUP),
    isNull(userTokens.usedAt),
    isNull(userTokens.revokedAt),
    gt(userTokens.expiresAt, sql`now()`),
  );
}

/** The owner row (`role = 'owner'`), if one exists. */
async function findOwner(tx: Tx): Promise<{ id: string; email: string } | undefined> {
  const [owner] = await tx
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.role, OWNER_ROLE))
    .limit(1);
  return owner;
}

/** True when the user already holds a `password` credential (setup done). */
async function hasPassword(tx: Tx, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: userCredentials.id })
    .from(userCredentials)
    .where(
      and(
        eq(userCredentials.userId, userId),
        eq(userCredentials.type, PASSWORD_CREDENTIAL),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * True when a user other than `exceptUserId` already holds `email`. Used
 * so the env value never takes over, or promotes, an existing account.
 */
async function emailHeldByOther(
  tx: Tx,
  email: string,
  exceptUserId?: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      exceptUserId === undefined
        ? eq(users.email, email)
        : and(eq(users.email, email), ne(users.id, exceptUserId)),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Revokes every open `owner_setup` token (there is one owner, so this is
 * "the owner's pending links", plus any stray row) and inserts a fresh
 * one for `userId`. Must run under the owner lock, which is what keeps
 * "at most one live link" true: the schema has no such constraint.
 */
async function replaceSetupToken(
  tx: Tx,
  userId: string,
  email: string,
  now: Date,
): Promise<OwnerSetupLink> {
  await tx
    .update(userTokens)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(userTokens.purpose, OWNER_SETUP),
        isNull(userTokens.usedAt),
        isNull(userTokens.revokedAt),
      ),
    );

  const { token, hash } = mintToken();
  const expiresAt = setupTokenExpiry(now);
  await tx.insert(userTokens).values({
    id: generateId("utk"),
    userId,
    purpose: OWNER_SETUP,
    tokenHash: hash,
    expiresAt,
  });
  return { token, email, expiresAt };
}

/**
 * Creates the owner row for `email` and its first setup token. Caller has
 * already checked that no owner exists and nobody else holds the email.
 * `email_verified_at` stays null: the link arrives through server logs,
 * which does not prove control of the mailbox.
 */
async function createOwner(tx: Tx, email: string, now: Date): Promise<OwnerSetupLink> {
  const userId = generateId("usr");
  await tx.insert(users).values({ id: userId, email, role: OWNER_ROLE });
  return replaceSetupToken(tx, userId, email, now);
}

/**
 * Boot-time owner bootstrap (#215), idempotent across restarts and safe
 * across replicas. See `OwnerBootstrapResult` for the outcomes:
 *
 * - No owner: create it (unless a non-owner already holds the email) and
 *   mint a link: `created`.
 * - Owner without a password (setup pending): if the configured email
 *   changed, update the stored one (nobody has claimed the account yet, so
 *   fixing a typo should not need SQL); then replace the link: `reissued`.
 * - Owner with a password: `complete` when the email matches, `mismatch`
 *   otherwise. Nothing changes after setup; the database is the source of
 *   truth.
 *
 * The caller logs the link only after this resolves, i.e. after commit, so
 * a rolled-back token is never printed.
 *
 * @param ownerEmail - `BUNMAIL_OWNER_EMAIL`; normalized again here.
 * @param now        - Clock for the token expiry (tests pin it).
 */
export async function bootstrapOwner(
  ownerEmail: string,
  now: Date = new Date(),
): Promise<OwnerBootstrapResult> {
  const email = normalizeLoginEmail(ownerEmail);

  return withOwnerLock(async (tx) => {
    const owner = await findOwner(tx);

    if (!owner) {
      if (await emailHeldByOther(tx, email)) return { kind: "email-taken" };
      return { kind: "created", ...(await createOwner(tx, email, now)) };
    }

    if (await hasPassword(tx, owner.id)) {
      return owner.email === email
        ? { kind: "complete" }
        : { kind: "mismatch", storedEmail: owner.email };
    }

    /** Setup pending: follow an edited env email before reissuing. */
    if (owner.email !== email) {
      if (await emailHeldByOther(tx, email, owner.id)) return { kind: "email-taken" };
      await tx
        .update(users)
        .set({ email, updatedAt: sql`now()` })
        .where(eq(users.id, owner.id));
    }

    return { kind: "reissued", ...(await replaceSetupToken(tx, owner.id, email, now)) };
  });
}

/**
 * Mints a fresh owner setup link for the recovery script
 * (`src/db/reset-owner.ts`). Always replaces, never reuses:
 *
 * - Owner exists: revoke every open token of that user (any purpose),
 *   delete every dashboard session of the owner (#216: an operator who
 *   runs reset-owner usually suspects a compromise, so it is an immediate
 *   kill switch), and mint a new `owner_setup` token. The stored email
 *   and the current password are kept until the new link is completed,
 *   so an abandoned reset cannot lock the owner out; until then the old
 *   password can still sign in. The caller compares the returned email
 *   with the configured one and warns on a difference.
 * - No owner: create it from `ownerEmail`, as the bootstrap does.
 *
 * @throws when there is no owner and `ownerEmail` is null, or when a
 *         non-owner account already holds `ownerEmail`.
 */
export async function issueOwnerSetupLink(
  ownerEmail: string | null,
  now: Date = new Date(),
): Promise<OwnerSetupLink> {
  return withOwnerLock(async (tx) => {
    const owner = await findOwner(tx);

    if (owner) {
      await tx
        .update(userTokens)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(userTokens.userId, owner.id),
            isNull(userTokens.usedAt),
            isNull(userTokens.revokedAt),
          ),
        );
      await revokeAllUserSessions(owner.id, tx);
      return replaceSetupToken(tx, owner.id, owner.email, now);
    }

    if (ownerEmail === null) {
      throw new Error(
        "No owner account exists and BUNMAIL_OWNER_EMAIL is not set: set it and run again",
      );
    }
    const email = normalizeLoginEmail(ownerEmail);
    if (await emailHeldByOther(tx, email)) {
      throw new Error(
        "BUNMAIL_OWNER_EMAIL already belongs to a non-owner account; it is never promoted",
      );
    }
    return createOwner(tx, email, now);
  });
}

/**
 * Looks up a live setup token for the enabled owner. Read-only: `GET
 * /dashboard/setup` uses it to render the form without spending the
 * token, so link scanners and prefetchers cannot burn it. Returns `null`
 * for every invalid case (unknown, expired, used, revoked, not the owner,
 * disabled owner) so callers cannot tell them apart.
 */
export async function findLiveOwnerSetup(
  token: string,
): Promise<OwnerSetupTarget | null> {
  const [row] = await withSanitizedErrors(() =>
    db
      .select({ userId: users.id, email: users.email })
      .from(userTokens)
      .innerJoin(users, eq(users.id, userTokens.userId))
      .where(
        and(
          liveSetupToken(hashToken(token)),
          eq(users.role, OWNER_ROLE),
          isNull(users.disabledAt),
        ),
      )
      .limit(1),
  );
  return row ?? null;
}

/**
 * Spends a setup token and sets the owner password. Order matters on this
 * unauthenticated path:
 *
 * 1. A cheap indexed lookup first: a bogus token never reaches argon2id,
 *    so the route cannot be used to drive CPU-heavy hashing.
 * 2. `hashPassword` outside the transaction, so the owner lock is never
 *    held during argon2id.
 * 3. Under the lock: a conditional `UPDATE ... SET used_at = now()` on the
 *    live predicate, `RETURNING` the user. A concurrent second submission
 *    re-checks the predicate after the first commits and gets no row. Then
 *    the `password` credential is replaced (one per user, enforced by
 *    `user_credentials_one_password_per_user`), every other open token of
 *    the user is revoked, every session of the user is deleted, the new
 *    session is created (#216: the delete runs first, so the new session
 *    survives), and `users.updated_at` is touched.
 *
 * All or nothing: a failure rolls back every step, sessions included.
 *
 * @param client - Request metadata stored with the new session.
 * @returns the owner and the raw token of the new session, or `null` when
 *          the setup token is no longer live.
 */
export async function completeOwnerSetup(
  token: string,
  password: string,
  client: SessionClient = { ip: null, userAgent: null },
): Promise<CompletedOwnerSetup | null> {
  if (!(await findLiveOwnerSetup(token))) return null;

  const secretHash = await hashPassword(password);
  const tokenHash = hashToken(token);

  return withOwnerLock(async (tx) => {
    const liveOwnerIds = tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, OWNER_ROLE), isNull(users.disabledAt)));

    const [spent] = await tx
      .update(userTokens)
      .set({ usedAt: sql`now()` })
      .where(and(liveSetupToken(tokenHash), inArray(userTokens.userId, liveOwnerIds)))
      .returning({ userId: userTokens.userId });
    const userId = spent?.userId;
    if (!userId) return null;

    await tx
      .delete(userCredentials)
      .where(
        and(
          eq(userCredentials.userId, userId),
          eq(userCredentials.type, PASSWORD_CREDENTIAL),
        ),
      );
    await tx.insert(userCredentials).values({
      id: generateId("crd"),
      userId,
      type: PASSWORD_CREDENTIAL,
      secretHash,
    });

    await tx
      .update(userTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(userTokens.userId, userId),
          isNull(userTokens.usedAt),
          isNull(userTokens.revokedAt),
        ),
      );

    await revokeAllUserSessions(userId, tx);
    const { token: sessionToken } = await createSession(
      { userId, assurance: "password", authMethod: PASSWORD_CREDENTIAL, ...client },
      tx,
    );

    const [owner] = await tx
      .update(users)
      .set({ updatedAt: sql`now()` })
      .where(eq(users.id, userId))
      .returning({ userId: users.id, email: users.email });
    return owner ? { ...owner, sessionToken } : null;
  });
}
