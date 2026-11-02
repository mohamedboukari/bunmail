import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { generateId } from "../../../utils/id.ts";
import { UserStoreError, withSanitizedErrors } from "../errors.ts";
import { users } from "../models/user.schema.ts";
import { hasSecondFactor, userCredentials } from "../models/user-credential.schema.ts";
import type { DbExecutor, SessionClient } from "../types/user.types.ts";
import type {
  AutoLinkSsoResult,
  SsoAutoLinkDecision,
  SsoAutoLinkRefusal,
} from "../types/sso.types.ts";
import { recordAuditEvent } from "../../audit/services/audit.service.ts";
import { firstFactorAssurance } from "./login.service.ts";
import { SSO_CREDENTIAL, ssoAutoLinkRefusal } from "./sso-link-policy.service.ts";
import { openLinkedSession } from "./sso-sign-in.service.ts";

/**
 * Linking an unknown SSO identity by its verified email (#224, part 4),
 * when the provider opts in (`SSO_<ID>_AUTO_LINK=true`, which needs
 * `SSO_<ID>_ALLOWED_DOMAINS`). Off by default; the explicit link on
 * Account > Sign-in methods is always available.
 *
 * The claims are checked first, without the database
 * (`ssoAutoLinkEmail`: `email_verified` is the boolean `true`, the domain
 * and Google's `hd` are allowed). Then the address must match exactly one
 * account: an enabled member (never the owner or an admin) without a
 * BunMail second factor and with no identity at this provider yet, and
 * the identity must not be linked anywhere. An account with a second
 * factor is refused: the link would be written before that factor is
 * passed and would outlive it, so it links explicitly instead (Account >
 * Sign-in methods, behind the password). The link row is the one an
 * explicit link writes (type `oauth`, `oidc:<issuer>`, the subject, the
 * provider email as its label, no secret), under the same unique indexes,
 * and the session is opened by the same writes as a linked sign-in
 * (`openLinkedSession`).
 *
 * Audit rows carry the provider's id and the link's row id, never the
 * subject or the provider email. Database errors leave this module as
 * `UserStoreError`.
 */

/** SQLSTATE of a unique violation: a racing link took the identity or the provider. */
const UNIQUE_VIOLATION = "23505";

/** What an unknown identity would be linked by: the stored provider key, the subject, the email. */
interface AutoLinkTarget {
  /** `oidc:<issuer>` (`ssoProviderKey`). */
  providerKey: string;
  /** The ID token's `sub`. Never logged. */
  sub: string;
  /** The verified email, ASCII lower-cased (`ssoAutoLinkEmail`). PII: never logged raw. */
  email: string;
}

/** The account an address matched, as the rules read it. */
interface AutoLinkAccount {
  userId: string;
  role: string;
  disabledAt: Date | null;
  hasSecondFactor: boolean;
}

/** The accounts matching `where`, with what the rules read (at most two). */
function accountRows(executor: DbExecutor, where: SQL): Promise<AutoLinkAccount[]> {
  return executor
    .select({
      userId: users.id,
      role: users.role,
      disabledAt: users.disabledAt,
      hasSecondFactor: hasSecondFactor(users.id),
    })
    .from(users)
    .where(where)
    .limit(2);
}

/**
 * Reads what the rules of {@link ssoAutoLinkRefusal} need: the accounts
 * with the address (at most two are read: emails are unique, and anything
 * but one is refused), then, for exactly one, the links at this provider
 * that are this account's or this identity's.
 *
 * With `lock`, the account's `users` row is locked first, **in a statement
 * of its own** (`SELECT id ... WHERE email = $1 LIMIT 2 FOR UPDATE`, in the
 * caller's transaction): the first lock of every account write (an
 * explicit link, a reset, TOTP, passkeys, the ownership transfer). Only
 * the next statements read the role, the disabled flag, the second
 * factors and the links. Under read committed, a statement that waits for
 * a row lock still evaluates its subqueries on the snapshot it started
 * with, so a second factor or a link committed while it waited would be
 * missed if read in the locking statement; a new statement started after
 * the lock is granted sees everything committed before it.
 */
async function readAutoLinkTarget(
  executor: DbExecutor,
  target: AutoLinkTarget,
  lock: boolean,
): Promise<{ account: AutoLinkAccount | null; refusal: SsoAutoLinkRefusal | null }> {
  const byEmail = eq(users.email, target.email);
  let accounts: AutoLinkAccount[];
  if (lock) {
    const locked = await executor
      .select({ userId: users.id })
      .from(users)
      .where(byEmail)
      .limit(2)
      .for("update");
    const [only] = locked;
    if (only === undefined || locked.length !== 1) {
      return { account: null, refusal: "no_account_for_email" };
    }
    accounts = await accountRows(executor, eq(users.id, only.userId));
  } else {
    accounts = await accountRows(executor, byEmail);
  }
  const account = accounts.length === 1 ? (accounts[0] ?? null) : null;
  const existing =
    account === null
      ? []
      : await executor
          .select({
            userId: userCredentials.userId,
            sub: userCredentials.providerAccountId,
          })
          .from(userCredentials)
          .where(
            and(
              eq(userCredentials.provider, target.providerKey),
              sql`(${userCredentials.providerAccountId} = ${target.sub} OR (${userCredentials.userId} = ${account.userId} AND ${userCredentials.type} = ${SSO_CREDENTIAL}))`,
            ),
          );
  const refusal = ssoAutoLinkRefusal(
    accounts.map((row) => ({
      disabled: row.disabledAt !== null,
      role: row.role,
      hasSecondFactor: row.hasSecondFactor,
    })),
    {
      providerLinked: existing.some((row) => row.userId === account?.userId),
      identityLinkedElsewhere: existing.some(
        (row) => row.sub === target.sub && row.userId !== account?.userId,
      ),
    },
  );
  return { account, refusal };
}

/**
 * Whether an unknown identity may be linked by its email: a read before
 * anything changes (the callback replaces the browser's previous session
 * only after this passes). {@link autoLinkSsoIdentity} decides again under
 * the account's lock.
 */
export async function resolveSsoAutoLink(
  target: AutoLinkTarget,
): Promise<SsoAutoLinkDecision> {
  const { account, refusal } = await withSanitizedErrors(() =>
    readAutoLinkTarget(db, target, false),
  );
  if (refusal !== null || account === null) {
    return {
      ok: false,
      reason: refusal ?? "no_account_for_email",
      userId: account?.userId ?? null,
    };
  }
  return { ok: true, userId: account.userId };
}

/**
 * Links an unknown identity to the account its verified email matched and
 * opens the sign-in's session, in one transaction:
 *
 * 1. The account's `users` row is locked (`FOR UPDATE`, a statement of its
 *    own), then every rule decided again from statements started after
 *    the lock: exactly one account, an enabled member, no second factor,
 *    no identity at this provider, the identity linked nowhere (a disable,
 *    a role change, a factor added, a reset or a link that committed
 *    meanwhile counts).
 * 2. The link row is inserted (the explicit link's shape and unique
 *    indexes), the account's `updated_at` touched and `auth.sso.auto_linked`
 *    recorded (`provider`, the link as target).
 * 3. The session, as a linked sign-in (`openLinkedSession`): `password`
 *    (the account has no second factor, checked under the lock; the
 *    assurance still comes from `firstFactorAssurance`); `last_used_at`;
 *    the `auth.login.*` record.
 *
 * A racing link that wins a unique index (an explicit link of this
 * identity to another account, which does not wait for this account's
 * lock) rolls everything back and is answered as a refusal, read again
 * after the failed transaction (`already_linked` when the read finds
 * nothing more precise): never an error. A refusal changes nothing and is
 * the caller's to record.
 */
export async function autoLinkSsoIdentity(
  input: AutoLinkTarget & {
    /** The provider's id in `SSO_PROVIDERS` (audit metadata) and its label (audit target). */
    provider: { id: string; label: string };
    /** The label kept with the link (`ssoLinkName`). */
    name: string | null;
  },
  client: SessionClient,
): Promise<AutoLinkSsoResult> {
  const linkId = generateId("crd");
  try {
    return await withSanitizedErrors(() =>
      db.transaction(async (tx): Promise<AutoLinkSsoResult> => {
        const { account, refusal } = await readAutoLinkTarget(tx, input, true);
        if (refusal !== null || account === null) {
          return {
            ok: false,
            reason: refusal ?? "no_account_for_email",
            userId: account?.userId ?? null,
          };
        }
        const { userId } = account;
        await tx.insert(userCredentials).values({
          id: linkId,
          userId,
          type: SSO_CREDENTIAL,
          provider: input.providerKey,
          providerAccountId: input.sub,
          name: input.name,
        });
        await tx
          .update(users)
          .set({ updatedAt: sql`now()` })
          .where(eq(users.id, userId));
        await recordAuditEvent(
          {
            action: "auth.sso.auto_linked",
            actor: { type: "user", id: userId },
            ...client,
            target: { type: "sso_link", id: linkId, label: input.provider.label },
            metadata: { provider: input.provider.id },
          },
          tx,
        );
        const assurance = firstFactorAssurance(account.hasSecondFactor);
        const opened = await openLinkedSession(
          tx,
          { userId, linkId, assurance },
          input.provider.id,
          client,
        );
        return {
          ok: true,
          userId,
          email: input.email,
          linkId,
          assurance,
          ...opened,
          autoLinked: { name: input.name },
        };
      }),
    );
  } catch (error: unknown) {
    if (!(error instanceof UserStoreError) || error.sqlState !== UNIQUE_VIOLATION) {
      throw error;
    }
    const after = await withSanitizedErrors(() => readAutoLinkTarget(db, input, false));
    return {
      ok: false,
      reason: after.refusal ?? "already_linked",
      userId: after.account?.userId ?? null,
    };
  }
}
