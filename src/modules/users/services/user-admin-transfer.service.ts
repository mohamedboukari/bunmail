import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { withSanitizedErrors } from "../errors.ts";
import { recordAuditEvent } from "../../audit/services/audit.service.ts";
import { users } from "../models/user.schema.ts";
import { userCredentials } from "../models/user-credential.schema.ts";
import { userTokens } from "../models/user-token.schema.ts";
import type {
  AccountAction,
  AccountActionResult,
  AttemptLimiter,
  SessionClient,
} from "../types/user.types.ts";
import { revokeInvitesIssuedBy } from "./invite.service.ts";
import { revokeResetLinks } from "./password-reset.service.ts";
import { verifyPassword } from "./password.service.ts";
import { moveOwnerRecords } from "./record-ownership.service.ts";
import { ssoLinkWithoutSecondFactor } from "./sso-owner-rule.service.ts";
import { accountActionRefusal } from "./user-admin-policy.service.ts";
import {
  ACCOUNT_COLUMNS,
  NO_CLIENT,
  logRefusal,
  runAccountAction,
  toAccountRow,
  type AccountRow,
} from "./user-admin-action.service.ts";

/**
 * Ownership transfer (#218): the early checks, the throttled password
 * check, then the locked transfer. The public surface is
 * `user-admin.service.ts`.
 */

/** The actor's `password` credential hash, or `null` when it has none. */
async function passwordHashOf(userId: string): Promise<string | null> {
  const [row] = await withSanitizedErrors(() =>
    db
      .select({ secretHash: userCredentials.secretHash })
      .from(userCredentials)
      .where(
        and(eq(userCredentials.userId, userId), eq(userCredentials.type, "password")),
      )
      .limit(1),
  );
  return row?.secretHash ?? null;
}

/** Reads an account without locking it, for the checks before argon2id. */
async function readAccount(id: string): Promise<AccountRow | null> {
  const [row] = await withSanitizedErrors(() =>
    db.select(ACCOUNT_COLUMNS).from(users).where(eq(users.id, id)).limit(1),
  );
  return toAccountRow(row);
}

/**
 * Makes an active admin the owner (owner only), confirmed with the
 * owner's current password. In order:
 *
 * 1. The rules, on rows read without a lock: a request that would be
 *    refused anyway never reaches argon2id. Among them the owner rule of
 *    SSO (#224): a target holding an SSO link without a BunMail second
 *    factor is refused (`sso_link_without_second_factor`), since an owner
 *    with a link must keep one; checked again under the lock.
 * 2. The failed-attempt budget (`limiter`, per actor and per client IP,
 *    built by the route from the login limiter): over budget is refused
 *    (`rate_limited`) with no argon2id work. Otherwise the attempt is
 *    counted at once, before the verify, in the same atomic step as the
 *    check (#185), so a parallel burst cannot run more verifies than the
 *    budget allows.
 * 3. The password, checked outside the lock so it is never held during
 *    argon2id. Wrong (or no password credential): refused, nothing changes.
 * 4. Under the owner lock, the rules again on the locked live rows (a
 *    concurrent transfer or deactivation may have won), then: revoke the
 *    open password reset links the owner issued for admins and every open
 *    reset link of the target, whoever issued it (#277; they would
 *    otherwise come back to life if ownership returned), demote the
 *    owner to admin, promote the target to owner (in that order, so the
 *    single-owner index holds at every statement), revoke the previous
 *    owner's open `admin` invitations, and revoke every open owner setup
 *    link (one minted for the previous owner by `reset-owner` would
 *    otherwise come back to life if ownership ever returned to it), and
 *    move the previous owner's templates, domains and webhooks (and rows
 *    with no creator, which were the owner's) to the new owner (#219;
 *    API keys stay with their creator). Sessions are untouched: both accounts stay signed in, with
 *    their new roles from the next request.
 * 5. A completed transfer clears the budget.
 */
export async function transferOwnership(
  actorId: string,
  targetId: string,
  password: string,
  limiter: AttemptLimiter,
  client: SessionClient = NO_CLIENT,
): Promise<AccountActionResult> {
  const action: AccountAction = "transfer_ownership";
  const [actor, target] = await Promise.all([
    readAccount(actorId),
    readAccount(targetId),
  ]);
  if (!actor || actor.disabled) {
    logRefusal(action, actorId, targetId, { reason: "actor_inactive" });
    return { ok: false, reason: "actor_inactive" };
  }
  if (!target) {
    logRefusal(action, actorId, targetId, { reason: "not_found", actorRole: actor.role });
    return { ok: false, reason: "not_found" };
  }
  const early =
    accountActionRefusal(action, actor, target) ??
    ((await withSanitizedErrors(() => ssoLinkWithoutSecondFactor(db, targetId)))
      ? "sso_link_without_second_factor"
      : null);
  if (early) {
    logRefusal(action, actorId, targetId, {
      reason: early,
      actorRole: actor.role,
      targetRole: target.role,
    });
    return { ok: false, reason: early };
  }

  /** Checked and counted in one atomic step (see step 2 above). */
  if (await limiter.take()) {
    logRefusal(action, actorId, targetId, {
      reason: "rate_limited",
      actorRole: actor.role,
      targetRole: target.role,
    });
    return { ok: false, reason: "rate_limited" };
  }

  const hash = await passwordHashOf(actorId);
  if (hash === null || !(await verifyPassword(password, hash))) {
    logRefusal(action, actorId, targetId, {
      reason: "wrong_password",
      actorRole: actor.role,
      targetRole: target.role,
    });
    /** A failed password check on the owner's account (#221); bounded by `limiter`. */
    await recordAuditEvent({
      action: "user.ownership.transferred",
      outcome: "failure",
      actor: { type: "user", id: actor.id, label: actor.email },
      ...client,
      target: { type: "user", id: target.id, label: target.email },
      metadata: { reason: "wrong_password" },
    });
    return { ok: false, reason: "wrong_password" };
  }

  const result = await runAccountAction(
    action,
    actorId,
    targetId,
    async (tx, owner, newOwner) => {
      /** The owner rule of SSO (#224) on the locked target row. */
      if (await ssoLinkWithoutSecondFactor(tx, newOwner.id)) {
        return "sso_link_without_second_factor";
      }
      /**
       * Before the role changes (#277): the previous owner's links for
       * admins, and every open link of the new owner whoever issued it.
       */
      const resetLinksRevoked =
        (await revokeResetLinks(tx, { issuedBy: owner.id, targetRole: "admin" })) +
        (await revokeResetLinks(tx, { userId: newOwner.id }));
      await tx
        .update(users)
        .set({ role: "admin", updatedAt: sql`now()` })
        .where(eq(users.id, owner.id));
      await tx
        .update(users)
        .set({ role: "owner", updatedAt: sql`now()` })
        .where(eq(users.id, newOwner.id));
      const invitesRevoked = await revokeInvitesIssuedBy(tx, owner.id, "admin");
      const setupLinks = await tx
        .update(userTokens)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(userTokens.purpose, "owner_setup"),
            isNull(userTokens.usedAt),
            isNull(userTokens.revokedAt),
          ),
        )
        .returning({ id: userTokens.id });
      const recordsMoved = await moveOwnerRecords(tx, owner.id, newOwner.id);
      return {
        oldRole: newOwner.role,
        newRole: "owner",
        previousOwnerRole: "admin",
        invitesRevoked,
        setupLinksRevoked: setupLinks.length,
        resetLinksRevoked,
        recordsMoved,
      };
    },
    client,
  );
  if (result.ok) await limiter.clear();
  return result;
}
