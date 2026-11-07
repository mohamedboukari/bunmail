import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { sessions } from "../models/session.schema.ts";
import { hasSecondFactor } from "../models/user-credential.schema.ts";
import {
  SESSION_ABSOLUTE_SECONDS,
  SESSION_IDLE_SECONDS,
} from "./session-policy.service.ts";

/**
 * The SQL pieces the session queries share (#216, #281): the interval
 * literal, the live-session predicate and the sliding expiry. The public
 * surface is `session.service.ts`.
 */

/**
 * A constant interval literal, e.g. `interval '60 seconds'`. Inlined
 * rather than bound: the values are code constants, and a bound number
 * next to an interval leaves Postgres guessing the parameter type.
 */
export function seconds(value: number): SQL {
  return sql.raw(`interval '${Math.trunc(value)} seconds'`);
}

/**
 * The session-side half of "live" (#216, #281): unexpired (`expires_at`
 * carries both the 24 h idle and the 7 d absolute rule, see
 * `slidingExpiry`) and an assurance that may open a page: `mfa`, or
 * `password` only while the account has no second factor (#220: TOTP;
 * #223: a passkey; one shared predicate, `hasSecondFactor`). `pending`
 * never. So a password-level session can never outlive the account
 * turning 2FA on or adding a passkey, even one a login opened while a
 * confirmation was committing (confirmation deletes the other sessions, but a login
 * that checked the password just before can insert after it). The guard
 * (`findActiveSession`) and the Active sessions list share it, so the
 * list shows exactly the sessions that still open the dashboard.
 */
export function liveSession(): SQL | undefined {
  return and(
    sql`${sessions.expiresAt} > now()`,
    or(
      eq(sessions.assurance, "mfa"),
      and(
        eq(sessions.assurance, "password"),
        sql`NOT ${hasSecondFactor(sessions.userId)}`,
      ),
    ),
  );
}

/** `expires_at` after activity: the idle timeout, capped by the absolute one. */
export function slidingExpiry(): SQL {
  return sql`LEAST(now() + ${seconds(SESSION_IDLE_SECONDS)}, ${sessions.createdAt} + ${seconds(SESSION_ABSOLUTE_SECONDS)})`;
}
