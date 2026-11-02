import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { withSanitizedErrors } from "../errors.ts";
import { users } from "../models/user.schema.ts";
import { hasSecondFactor, userCredentials } from "../models/user-credential.schema.ts";
import type { DbExecutor, SessionClient, Tx } from "../types/user.types.ts";
import type {
  OpenSsoSessionResult,
  SsoAutoLinkRefusal,
  SsoFailureReason,
  SsoSignInDecision,
  SsoSignInRefusal,
} from "../types/sso.types.ts";
import { recordAuditEvent } from "../../audit/services/audit.service.ts";
import type { AuditActor, AuditTarget } from "../../audit/types/audit.types.ts";
import { firstFactorAssurance } from "./login.service.ts";
import { createSession } from "./session.service.ts";
import { SSO_CREDENTIAL, ssoSignInRefusal } from "./sso-link-policy.service.ts";

/**
 * Signing in with a linked SSO identity (#224, part 3): which account an
 * identity proven at the provider opens, and the session it gets.
 *
 * **Identity.** Only by `(issuer, sub)`: the link row of type `oauth`
 * whose `provider` is `oidc:<issuer>` and whose `provider_account_id` is
 * the subject. Never by email, never by creating an account or accepting
 * an invitation (invite-only, #225). An unknown identity may first be
 * linked by its verified email when the provider opts in
 * (`sso-auto-link.service.ts`); it then signs in through the same writes
 * ({@link openLinkedSession}).
 *
 * **Assurance.** SSO is a first factor, like the password
 * (`firstFactorAssurance`): an account with a BunMail second factor gets a
 * `pending` session and the existing second step; one without gets a
 * `password`-level (single factor) session. `oauth` is never a second
 * factor, and the provider's `amr`/`acr` are not read. The session is
 * bound to the link (`auth_method = 'oauth'`, `credential_id` = the link
 * row), so unlinking it (or removing the account) ends the session too.
 *
 * Audit rows carry the provider's id in `SSO_PROVIDERS` and the session's
 * id, never the subject, the provider email, the code or a token.
 * Database errors leave this module as `UserStoreError`.
 */

/** An identity to sign in with: the stored provider key and the subject. */
interface SsoSignInIdentity {
  /** `oidc:<issuer>` (`ssoProviderKey`). */
  providerKey: string;
  /** The ID token's `sub`. Never logged. */
  sub: string;
}

/** The linked account as the sign-in rules read it. */
interface LinkedAccount {
  linkId: string;
  userId: string;
  email: string;
  role: string;
  disabledAt: Date | null;
  hasSecondFactor: boolean;
}

/**
 * The account linked to an identity, or `null`. With `lock`, the link row
 * is locked (`FOR UPDATE OF user_credentials`) in the caller's
 * transaction: an unlink racing the sign-in waits for it, and one that
 * committed first leaves nothing to find. The pair is unique
 * (`user_credentials_provider_account_unique`).
 */
async function linkedAccount(
  executor: DbExecutor,
  identity: SsoSignInIdentity,
  lock: boolean,
): Promise<LinkedAccount | null> {
  const query = executor
    .select({
      linkId: userCredentials.id,
      userId: users.id,
      email: users.email,
      role: users.role,
      disabledAt: users.disabledAt,
      hasSecondFactor: hasSecondFactor(users.id),
    })
    .from(userCredentials)
    .innerJoin(users, eq(users.id, userCredentials.userId))
    .where(
      and(
        eq(userCredentials.type, SSO_CREDENTIAL),
        eq(userCredentials.provider, identity.providerKey),
        eq(userCredentials.providerAccountId, identity.sub),
      ),
    );
  const [row] = lock ? await query.for("update", { of: userCredentials }) : await query;
  return row ?? null;
}

/** The rules of `ssoSignInRefusal` applied to a linked account, with the assurance. */
function decide(account: LinkedAccount | null): SsoSignInDecision {
  if (account === null) return { ok: false, reason: "unknown_identity", userId: null };
  const refusal = ssoSignInRefusal({
    disabled: account.disabledAt !== null,
    role: account.role,
    hasSecondFactor: account.hasSecondFactor,
  });
  if (refusal !== null) return { ok: false, reason: refusal, userId: account.userId };
  return {
    ok: true,
    userId: account.userId,
    email: account.email,
    linkId: account.linkId,
    assurance: firstFactorAssurance(account.hasSecondFactor),
  };
}

/**
 * Whether an identity may sign in, and with which assurance: a read
 * before anything changes (the callback replaces the browser's previous
 * session only after this passes). {@link openSsoSession} decides again
 * under the link's lock.
 */
export async function resolveSsoSignIn(
  identity: SsoSignInIdentity,
): Promise<SsoSignInDecision> {
  return decide(await withSanitizedErrors(() => linkedAccount(db, identity, false)));
}

/**
 * Opens the session of an SSO sign-in, in one transaction: the link row is
 * locked and every rule decided again (a link removed, an account disabled
 * or a second factor added since {@link resolveSsoSignIn} counts); then
 * the link's `last_used_at` is set, the session inserted (`pending` or
 * `password`, `auth_method = 'oauth'`, bound to the link) and the sign-in
 * recorded: `auth.login.two_factor_required` for a `pending` session,
 * `auth.login.succeeded` otherwise, both `{ method: "oauth", provider }`.
 * A refusal changes nothing and is the caller's to record.
 */
export async function openSsoSession(
  input: SsoSignInIdentity & { providerId: string },
  client: SessionClient,
): Promise<OpenSsoSessionResult> {
  return withSanitizedErrors(() =>
    db.transaction(async (tx): Promise<OpenSsoSessionResult> => {
      const decision = decide(await linkedAccount(tx, input, true));
      if (!decision.ok) return decision;
      const opened = await openLinkedSession(tx, decision, input.providerId, client);
      return { ...decision, ...opened };
    }),
  );
}

/**
 * The writes of a linked sign-in, inside the caller's transaction once
 * the rules passed under its lock: the link's `last_used_at`, the session
 * (`pending` or `password`, `auth_method = 'oauth'`, bound to the link)
 * and the record, `auth.login.two_factor_required` for a `pending`
 * session, `auth.login.succeeded` otherwise, both `{ method: "oauth",
 * provider }`. Shared by {@link openSsoSession} and the link by verified
 * email (`autoLinkSsoIdentity`), so both sign in the same way.
 */
export async function openLinkedSession(
  tx: Tx,
  decision: Pick<
    Extract<SsoSignInDecision, { ok: true }>,
    "userId" | "linkId" | "assurance"
  >,
  providerId: string,
  client: SessionClient,
): Promise<{ sessionId: string; token: string }> {
  await tx
    .update(userCredentials)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(userCredentials.id, decision.linkId));
  const { sessionId, token } = await createSession(
    {
      userId: decision.userId,
      assurance: decision.assurance,
      authMethod: SSO_CREDENTIAL,
      credentialId: decision.linkId,
      ...client,
    },
    tx,
  );
  const actor = { type: "user", id: decision.userId } satisfies AuditActor;
  const target = {
    type: "session",
    id: sessionId,
    label: null,
  } satisfies AuditTarget;
  if (decision.assurance === "pending") {
    await recordAuditEvent(
      {
        action: "auth.login.two_factor_required",
        actor,
        ...client,
        target,
        metadata: { method: "oauth", provider: providerId },
      },
      tx,
    );
  } else {
    await recordAuditEvent(
      {
        action: "auth.login.succeeded",
        actor,
        ...client,
        target,
        metadata: { method: "oauth", provider: providerId },
      },
      tx,
    );
  }
  return { sessionId, token };
}

/**
 * Records a refused SSO sign-in (`auth.login.failed`, `step: "sso"`) on its
 * own: never fails the caller. `userId` is the linked account when the
 * identity matched one, else `null` (no id, no label: the provider email
 * and the subject are never stored).
 */
export async function recordSsoLoginFailure(
  userId: string | null,
  providerId: string,
  reason: SsoFailureReason | SsoSignInRefusal | SsoAutoLinkRefusal,
  client: SessionClient,
): Promise<void> {
  await recordAuditEvent({
    action: "auth.login.failed",
    outcome: "failure",
    actor:
      userId === null
        ? { type: "user", id: null, label: null }
        : { type: "user", id: userId },
    ...client,
    metadata: { step: "sso", reason, provider: providerId },
  });
}
