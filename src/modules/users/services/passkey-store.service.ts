import { and, asc, eq } from "drizzle-orm";
import type { db } from "../../../db/index.ts";
import { userCredentials } from "../models/user-credential.schema.ts";
import type { SessionClient, Tx } from "../types/user.types.ts";

/**
 * The stored passkey as the ceremonies read it (#223): its constants,
 * columns and row, the account's passkeys, and the error name a `debug`
 * line may carry. The public surface is `passkey.service.ts`.
 */

/** The credential type of a passkey. */
export const PASSKEY_CREDENTIAL = "passkey";

/** SQLSTATE of a unique violation: the credential id is registered already. */
export const UNIQUE_VIOLATION = "23505";

/** No request metadata (a script, a test): events are still recorded. */
export const NO_CLIENT: SessionClient = { ip: null, userAgent: null };

/** A stored passkey, as the ceremonies read it. */
export interface PasskeyRow {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  name: string;
  transports: string | null;
}

/** The passkey columns every ceremony selects. */
export const passkeyColumns = {
  id: userCredentials.id,
  userId: userCredentials.userId,
  credentialId: userCredentials.providerAccountId,
  publicKey: userCredentials.publicKey,
  counter: userCredentials.counter,
  name: userCredentials.name,
  transports: userCredentials.transports,
};

/** A selected row with the columns that a passkey always has, or null when one is missing. */
export function toPasskeyRow(row: {
  id: string;
  userId: string;
  credentialId: string | null;
  publicKey: string | null;
  counter: number | null;
  name: string | null;
  transports: string | null;
}): PasskeyRow | null {
  if (row.credentialId === null || row.publicKey === null) return null;
  return {
    id: row.id,
    userId: row.userId,
    credentialId: row.credentialId,
    publicKey: row.publicKey,
    counter: row.counter ?? 0,
    name: row.name ?? "Passkey",
    transports: row.transports,
  };
}

/** The account's passkeys, oldest first. */
export async function passkeysOf(
  executor: typeof db | Tx,
  userId: string,
): Promise<PasskeyRow[]> {
  const rows = await executor
    .select(passkeyColumns)
    .from(userCredentials)
    .where(
      and(
        eq(userCredentials.userId, userId),
        eq(userCredentials.type, PASSKEY_CREDENTIAL),
      ),
    )
    .orderBy(asc(userCredentials.createdAt), asc(userCredentials.id));
  return rows.map(toPasskeyRow).filter((row) => row !== null);
}

/** Why a library call failed, for a `debug` line: the error class only (messages quote challenges). */
export function failureName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
