import { lt, sql, type SQL } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { generateId } from "../../../utils/id.ts";
import { withSanitizedErrors } from "../errors.ts";
import { userDevices } from "../models/user-device.schema.ts";
import {
  DEVICE_RETENTION_DAYS,
  KNOWN_DEVICE_DAYS,
  classifySignInDevice,
  type SignInDeviceKind,
} from "./device-policy.service.ts";
import { hashToken } from "./token.service.ts";

/**
 * The `user_devices` table (#282): the browsers each account signed in
 * from, keyed by the SHA-256 of the `bm_device` cookie. The only code
 * that touches the table.
 *
 * Never logs or returns a device hash or the cookie value. Database
 * errors leave this module as `UserStoreError` (SQLSTATE only): drizzle's
 * message would carry the hash and the IP in its params.
 */

/** A constant `interval '<n> days'` literal (code constants only, never input). */
function days(value: number): SQL {
  return sql.raw(`interval '${Math.trunc(value)} days'`);
}

/** What a password sign-in records. */
export interface SignInDeviceInput {
  userId: string;
  /** The raw `bm_device` cookie value (well-formed); only its hash is stored. */
  deviceToken: string;
  /** The device label ("Chrome on macOS"). */
  label: string;
  /** A valid IP literal, or null. */
  ip: string | null;
  /** Approximate location, or null. */
  location: string | null;
}

/** The device row a sign-in landed on, and what it means for the alert. */
export interface RecordedSignInDevice {
  /** `user_devices.id` (`udv_`). */
  deviceId: string;
  kind: SignInDeviceKind;
}

/** `row[key]` when it is a boolean; anything else reads as `false`. */
function flag(row: Record<string, unknown>, key: string): boolean {
  return row[key] === true;
}

/**
 * Records a password sign-in from a browser in one statement: inserts the
 * account's row for this cookie, or moves an existing one's `last_seen_at`
 * forward with the new label, IP and location. The `prior` CTE reads the
 * table as it was before this statement (every part of a statement shares
 * one snapshot), so it tells whether the account had any device and
 * whether this one was seen within `KNOWN_DEVICE_DAYS`; `xmax = 0` tells
 * an insert from an update. `classifySignInDevice` turns that into
 * `first`, `known` or `new`.
 */
export async function recordSignInDevice(
  input: SignInDeviceInput,
): Promise<RecordedSignInDevice> {
  const id = generateId("udv");
  const hash = hashToken(input.deviceToken);
  const rows = await withSanitizedErrors(() =>
    db.execute(sql`
      WITH prior AS (
        SELECT
          EXISTS (
            SELECT 1 FROM user_devices WHERE user_id = ${input.userId}
          ) AS had_devices,
          EXISTS (
            SELECT 1 FROM user_devices
            WHERE user_id = ${input.userId} AND device_hash = ${hash}
              AND last_seen_at > now() - ${days(KNOWN_DEVICE_DAYS)}
          ) AS known,
          EXISTS (
            SELECT 1 FROM user_devices
            WHERE user_id = ${input.userId} AND device_hash = ${hash}
              AND last_seen_at <= now() - ${days(KNOWN_DEVICE_DAYS)}
          ) AS stale
      )
      INSERT INTO user_devices (id, user_id, device_hash, user_agent, ip, location)
      VALUES (${id}, ${input.userId}, ${hash}, ${input.label}, ${input.ip}, ${input.location})
      ON CONFLICT (user_id, device_hash) DO UPDATE SET
        last_seen_at = now(),
        user_agent = EXCLUDED.user_agent,
        ip = EXCLUDED.ip,
        location = EXCLUDED.location
      RETURNING
        id,
        (xmax = 0) AS inserted,
        (SELECT had_devices FROM prior) AS had_devices,
        (SELECT known FROM prior) AS known,
        (SELECT stale FROM prior) AS stale
    `),
  );
  const row = rows[0];
  const deviceId = row?.["id"];
  if (!row || typeof deviceId !== "string") {
    throw new Error("Device upsert returned no row");
  }
  return {
    deviceId,
    kind: classifySignInDevice({
      inserted: flag(row, "inserted"),
      hadDevices: flag(row, "had_devices"),
      known: flag(row, "known"),
      stale: flag(row, "stale"),
    }),
  };
}

/**
 * Deletes device rows not seen for `DEVICE_RETENTION_DAYS` (the purge
 * worker). Such a browser counts as new again at its next sign-in.
 */
export async function purgeStaleUserDevices(): Promise<number> {
  const rows = await withSanitizedErrors(() =>
    db
      .delete(userDevices)
      .where(lt(userDevices.lastSeenAt, sql`now() - ${days(DEVICE_RETENTION_DAYS)}`))
      .returning({ id: userDevices.id }),
  );
  return rows.length;
}
