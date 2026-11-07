import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { suppressions } from "../models/suppression.schema.ts";

/**
 * Whether `email` holds an active suppression under ANY API key, of any
 * reason (#345): the gate for BunMail's own mail to addresses no tenant
 * chose, such as a TLS report to a reporting address a recipient domain
 * published. The send gate (`isSuppressed`) is per key; BunMail's own mail
 * has no key, so it errs on the side of not sending: an address any key
 * suppressed (bounce, complaint, unsubscribe, manual) gets no report.
 * "Active" is as for the send gate: permanent, or not yet expired. The
 * address is matched lower-cased and trimmed, as rows are stored.
 */
export async function isSuppressedForAnyKey(email: string): Promise<boolean> {
  const target = email.trim().toLowerCase();
  const [row] = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.email, target),
        or(isNull(suppressions.expiresAt), gt(suppressions.expiresAt, new Date())),
      ),
    )
    .limit(1);
  return row !== undefined;
}
