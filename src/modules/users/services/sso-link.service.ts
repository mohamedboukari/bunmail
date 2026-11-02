import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { generateId } from "../../../utils/id.ts";
import { UserStoreError, withSanitizedErrors } from "../errors.ts";
import { sessions } from "../models/session.schema.ts";
import { users } from "../models/user.schema.ts";
import { hasSecondFactor, userCredentials } from "../models/user-credential.schema.ts";
import type {
  ActiveSession,
  AttemptLimiter,
  SessionClient,
} from "../types/user.types.ts";
import type {
  AuthorizeSsoLinkResult,
  LinkSsoIdentityResult,
  SsoLinkRefusal,
  SsoLinkSummary,
  UnlinkSsoIdentityResult,
} from "../types/sso.types.ts";
import { recordAuditEvent } from "../../audit/services/audit.service.ts";
import { verifyPassword } from "./password.service.ts";
import { lockLiveSession } from "./session.service.ts";
import { SSO_CREDENTIAL, ownerNeedsSecondFactor } from "./sso-link-policy.service.ts";
import { passwordHashOf } from "./two-factor.service.ts";

/**
 * Linking SSO identities to accounts and unlinking them (#224): the
 * explicit link from Account > Sign-in methods, while signed in.
 *
 * **Storage.** A link is a `user_credentials` row of type `oauth`:
 * `provider` = `oidc:<issuer>`, `provider_account_id` = the subject, `name`
 * = the provider email at link time (shown, never used to decide),
 * `secret_hash` null (no token is ever stored), `last_used_at` set by each
 * sign-in. The identity key is `(issuer, sub)`, never the email.
 *
 * **Rules.**
 * - Linking asks for the current password first, under the password
 *   change's budget (`password:user:<id>`, `password:ip:<bucket>`), as
 *   adding a passkey does: a stolen session alone cannot plant the thief's
 *   identity.
 * - The owner may link only while it has a BunMail second factor.
 * - One link per provider per account (`user_credentials_one_oauth_per_provider`),
 *   and an identity links to one account only
 *   (`user_credentials_provider_account_unique`).
 * - The link is written for the session that started it, still live and
 *   still the browser's session at the callback.
 * - Unlinking asks for the current password and signs out every session
 *   the identity opened.
 *
 * Every link, unlink and refused link is recorded in the audit log with
 * the provider's id and the link's row id, never the subject (some
 * providers use the email as the subject). Database errors leave this
 * module as `UserStoreError`.
 */

/** SQLSTATE of a unique violation: a racing link took the identity or the provider. */
const UNIQUE_VIOLATION = "23505";

/** The provider a link is for: its stored key, its id in `SSO_PROVIDERS` and its label. */
interface LinkProvider {
  /** `oidc:<issuer>`. */
  key: string;
  /** The id in `SSO_PROVIDERS`: what the audit log records. */
  id: string;
  /** The button text: the audit row's target label. */
  label: string;
}

/**
 * Records a refused link (`auth.sso.link_refused`) on its own: never fails
 * the caller. Also used by the callback for a failed provider round trip
 * (`flow_failed`) when the browser's live session names the account.
 */
export async function recordSsoLinkRefusal(
  userId: string | null,
  provider: Pick<LinkProvider, "id">,
  reason: SsoLinkRefusal | "flow_failed",
  client: SessionClient,
): Promise<void> {
  await recordAuditEvent({
    action: "auth.sso.link_refused",
    outcome: "failure",
    actor:
      userId === null
        ? { type: "user", id: null, label: null }
        : { type: "user", id: userId },
    ...client,
    metadata: { provider: provider.id, reason },
  });
}

/* ─── Listing ─── */

/** The account's SSO links for the Sign-in methods page, oldest first. Never the subject. */
export async function listSsoLinks(userId: string): Promise<SsoLinkSummary[]> {
  const rows = await withSanitizedErrors(() =>
    db
      .select({
        id: userCredentials.id,
        provider: userCredentials.provider,
        name: userCredentials.name,
        createdAt: userCredentials.createdAt,
        lastUsedAt: userCredentials.lastUsedAt,
      })
      .from(userCredentials)
      .where(
        and(eq(userCredentials.userId, userId), eq(userCredentials.type, SSO_CREDENTIAL)),
      )
      .orderBy(asc(userCredentials.createdAt), asc(userCredentials.id)),
  );
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider ?? "",
    name: row.name,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }));
}

/* ─── Linking ─── */

/**
 * The checks before the browser is sent to the provider to link an
 * identity. In order:
 *
 * 1. The password budget (`limiter`: the password change's keys): over
 *    budget is refused (`rate_limited`), then the attempt is counted with
 *    no await in between. First, so every refusal below, each of which
 *    writes an audit row, is paid for: a stolen session cannot write rows
 *    faster than it could guess the password.
 * 2. The owner rule (`second_factor_required`) and one link per provider
 *    (`provider_already_linked`), before the password work.
 * 3. Exactly one argon2id verify (`wrong_password`); the budget is cleared
 *    on success.
 *
 * Every refusal but `rate_limited` is recorded (`auth.sso.link_refused`).
 * Passing these does not link anything: the link is written by
 * {@link linkSsoIdentity} once the provider proved the identity.
 */
export async function authorizeSsoLink(
  input: { userId: string; provider: LinkProvider; password: string },
  limiter: AttemptLimiter,
  client: SessionClient,
): Promise<AuthorizeSsoLinkResult> {
  const { userId, provider } = input;
  if (await limiter.take()) return { ok: false, reason: "rate_limited" };
  const [[account], [existing]] = await withSanitizedErrors(() =>
    Promise.all([
      db
        .select({ role: users.role, hasSecondFactor: hasSecondFactor(users.id) })
        .from(users)
        .where(eq(users.id, userId)),
      db
        .select({ id: userCredentials.id })
        .from(userCredentials)
        .where(
          and(
            eq(userCredentials.userId, userId),
            eq(userCredentials.type, SSO_CREDENTIAL),
            eq(userCredentials.provider, provider.key),
          ),
        )
        .limit(1),
    ]),
  );
  let refusal: "second_factor_required" | "provider_already_linked" | null = null;
  if (account && ownerNeedsSecondFactor(account.role, account.hasSecondFactor)) {
    refusal = "second_factor_required";
  } else if (existing) {
    refusal = "provider_already_linked";
  }
  if (refusal !== null) {
    await recordSsoLinkRefusal(userId, provider, refusal, client);
    return { ok: false, reason: refusal };
  }

  const hash = await passwordHashOf(userId);
  if (hash === null || !(await verifyPassword(input.password, hash))) {
    await recordSsoLinkRefusal(userId, provider, "wrong_password", client);
    return { ok: false, reason: "wrong_password" };
  }
  await limiter.clear();
  return { ok: true };
}

/**
 * Why a link insert hit a unique index: the identity is another account's
 * (`already_linked`), else this account already has a link at the provider
 * (`provider_already_linked`). Read after the failed transaction, when the
 * racing link has committed.
 */
async function conflictOf(
  userId: string,
  providerKey: string,
  sub: string,
): Promise<"already_linked" | "provider_already_linked"> {
  const [owner] = await withSanitizedErrors(() =>
    db
      .select({ userId: userCredentials.userId })
      .from(userCredentials)
      .where(
        and(
          eq(userCredentials.provider, providerKey),
          eq(userCredentials.providerAccountId, sub),
        ),
      )
      .limit(1),
  );
  return owner && owner.userId !== userId ? "already_linked" : "provider_already_linked";
}

/**
 * Links a proven identity to the account of the session that started the
 * link (#224), after the provider round trip. In order:
 *
 * 1. `session` (the browser's live session, `findActiveSession` at the
 *    callback) must be the session that started the flow (`flowSessionId`)
 *    and not a superseded token past its grace period; otherwise
 *    `session_changed`.
 * 2. One transaction: the user row is locked first (the order of the
 *    other account writes: TOTP, passkeys, the ownership transfer lock the
 *    user before anything else) and the owner rule checked again
 *    (`second_factor_required`); then the session row is locked and must
 *    still be live with its user enabled (`session_changed`); the identity
 *    must not be linked to any account (`already_linked`, or
 *    `provider_already_linked` when it is this one's) and the account must
 *    have no link at the provider (`provider_already_linked`); then the
 *    row is inserted and `auth.sso.linked` recorded. A racing link that
 *    wins a unique index is sorted into one of the two refusals.
 *
 * Refusals are recorded (`auth.sso.link_refused`) after the transaction.
 */
export async function linkSsoIdentity(
  input: {
    flowSessionId: string;
    session: Pick<ActiveSession, "sessionId" | "userId" | "matched" | "graceOver"> | null;
    provider: LinkProvider;
    sub: string;
    name: string | null;
  },
  client: SessionClient,
): Promise<LinkSsoIdentityResult> {
  const { session, provider, sub } = input;
  const refuse = async (
    reason: SsoLinkRefusal,
    userId: string | null,
  ): Promise<LinkSsoIdentityResult> => {
    await recordSsoLinkRefusal(userId, provider, reason, client);
    return { ok: false, reason, userId };
  };

  if (
    session === null ||
    session.sessionId !== input.flowSessionId ||
    (session.matched === "previous" && session.graceOver)
  ) {
    return refuse("session_changed", session?.userId ?? null);
  }
  const userId = session.userId;
  const linkId = generateId("crd");

  let outcome: { ok: true } | { ok: false; reason: SsoLinkRefusal };
  try {
    outcome = await withSanitizedErrors(() =>
      db.transaction(async (tx): Promise<typeof outcome> => {
        const [account] = await tx
          .select({ role: users.role, hasSecondFactor: hasSecondFactor(users.id) })
          .from(users)
          .where(eq(users.id, userId))
          .for("update");
        if (!account) return { ok: false, reason: "session_changed" };
        if (!(await lockLiveSession(tx, session.sessionId, userId))) {
          return { ok: false, reason: "session_changed" };
        }
        if (ownerNeedsSecondFactor(account.role, account.hasSecondFactor)) {
          return { ok: false, reason: "second_factor_required" };
        }

        const existing = await tx
          .select({
            userId: userCredentials.userId,
            sub: userCredentials.providerAccountId,
          })
          .from(userCredentials)
          .where(
            and(
              eq(userCredentials.provider, provider.key),
              sql`(${userCredentials.providerAccountId} = ${sub} OR (${userCredentials.userId} = ${userId} AND ${userCredentials.type} = ${SSO_CREDENTIAL}))`,
            ),
          );
        if (existing.some((row) => row.sub === sub && row.userId !== userId)) {
          return { ok: false, reason: "already_linked" };
        }
        if (existing.length > 0) return { ok: false, reason: "provider_already_linked" };

        await tx.insert(userCredentials).values({
          id: linkId,
          userId,
          type: SSO_CREDENTIAL,
          provider: provider.key,
          providerAccountId: sub,
          name: input.name,
        });
        await tx
          .update(users)
          .set({ updatedAt: sql`now()` })
          .where(eq(users.id, userId));
        await recordAuditEvent(
          {
            action: "auth.sso.linked",
            actor: { type: "user", id: userId },
            ...client,
            target: { type: "sso_link", id: linkId, label: provider.label },
            metadata: { provider: provider.id },
          },
          tx,
        );
        return { ok: true };
      }),
    );
  } catch (error: unknown) {
    if (!(error instanceof UserStoreError) || error.sqlState !== UNIQUE_VIOLATION) {
      throw error;
    }
    outcome = { ok: false, reason: await conflictOf(userId, provider.key, sub) };
  }

  if (!outcome.ok) return refuse(outcome.reason, userId);
  return { ok: true, linkId, name: input.name };
}

/* ─── Unlinking ─── */

/**
 * Removes one of the account's SSO links, after the current password. In
 * order: a link that is not this account's is answered `not_found` at
 * once, before any password work; the password budget (`limiter`, the
 * password change's keys) is checked and counted; one argon2id verify (a
 * wrong password is recorded as `auth.sso.unlink_refused`, like a wrong
 * one when linking); then, in one transaction, every session the identity opened is signed
 * out (they are bound to it: the foreign key's cascade would end them
 * too, this counts them), the row is deleted and `auth.sso.unlinked`
 * recorded. `auditProvider` maps the stored `oidc:<issuer>` to what the
 * audit row records: the provider's id and label, never the link's name
 * (the provider email, which some providers use as the subject).
 */
export async function unlinkSsoIdentity(
  input: { userId: string; linkId: string; password: string },
  limiter: AttemptLimiter,
  client: SessionClient,
  auditProvider: (key: string) => { id: string; label: string },
): Promise<UnlinkSsoIdentityResult> {
  const { userId, linkId } = input;
  const ownLink = and(
    eq(userCredentials.id, linkId),
    eq(userCredentials.userId, userId),
    eq(userCredentials.type, SSO_CREDENTIAL),
  );
  const [found] = await withSanitizedErrors(() =>
    db
      .select({ provider: userCredentials.provider })
      .from(userCredentials)
      .where(ownLink),
  );
  if (!found) return { ok: false, reason: "not_found" };
  if (await limiter.take()) return { ok: false, reason: "rate_limited" };
  const hash = await passwordHashOf(userId);
  if (hash === null || !(await verifyPassword(input.password, hash))) {
    const recorded = auditProvider(found.provider ?? "");
    await recordAuditEvent({
      action: "auth.sso.unlink_refused",
      outcome: "failure",
      actor: { type: "user", id: userId },
      ...client,
      target: { type: "sso_link", id: linkId, label: recorded.label },
      metadata: { provider: recorded.id, reason: "wrong_password" },
    });
    return { ok: false, reason: "wrong_password" };
  }
  await limiter.clear();

  return withSanitizedErrors(() =>
    db.transaction(async (tx): Promise<UnlinkSsoIdentityResult> => {
      const [link] = await tx
        .select({ provider: userCredentials.provider, name: userCredentials.name })
        .from(userCredentials)
        .where(ownLink)
        .for("update");
      if (!link) return { ok: false, reason: "not_found" };
      const revoked = await tx
        .delete(sessions)
        .where(eq(sessions.credentialId, linkId))
        .returning({ id: sessions.id });
      await tx.delete(userCredentials).where(ownLink);
      await tx
        .update(users)
        .set({ updatedAt: sql`now()` })
        .where(eq(users.id, userId));
      const provider = link.provider ?? "";
      const recorded = auditProvider(provider);
      await recordAuditEvent(
        {
          action: "auth.sso.unlinked",
          actor: { type: "user", id: userId },
          ...client,
          target: { type: "sso_link", id: linkId, label: recorded.label },
          metadata: { provider: recorded.id, sessionsRevoked: revoked.length },
        },
        tx,
      );
      return {
        ok: true,
        provider,
        name: link.name,
        sessionsRevoked: revoked.length,
      };
    }),
  );
}
