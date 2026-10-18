/**
 * Rules of the new-device sign-in alert (#282). Pure: no I/O, no config.
 *
 * A browser is recognized by its `bm_device` cookie, never by IP (mobile
 * addresses change all the time). A device is **known** to an account
 * when a `user_devices` row for that account and that cookie was seen in
 * the last `KNOWN_DEVICE_DAYS`. The account's very first device is
 * recorded without an alert: the first sign-in after setup or after
 * accepting an invitation is not a "new device" event.
 */

/** A device seen by the account within this many days is known: no alert. */
export const KNOWN_DEVICE_DAYS = 30;

/**
 * `user_devices` rows not seen for this many days are deleted by the purge
 * worker; also the `bm_device` cookie lifetime (the most browsers keep a
 * cookie, RFC 6265bis).
 */
export const DEVICE_RETENTION_DAYS = 400;

/** `Max-Age` of the `bm_device` cookie, in seconds. */
export const DEVICE_COOKIE_MAX_AGE_SECONDS = DEVICE_RETENTION_DAYS * 24 * 60 * 60;

/**
 * What the sign-in upsert saw, from the snapshot before its own write:
 *
 * - `inserted`: this sign-in created the row (the cookie was new to the account).
 * - `hadDevices`: the account had at least one device row before.
 * - `known`: this account and cookie had a row seen within `KNOWN_DEVICE_DAYS`.
 * - `stale`: this account and cookie had a row, last seen longer ago.
 */
export interface DeviceUpsertFacts {
  inserted: boolean;
  hadDevices: boolean;
  known: boolean;
  stale: boolean;
}

/**
 * What a sign-in means for the alert:
 *
 * - `first`: the account's first device, recorded silently.
 * - `known`: seen within the window, nothing to say.
 * - `new`: a browser the account has not used in the window: alert.
 */
export type SignInDeviceKind = "first" | "known" | "new";

/**
 * Classifies a sign-in from the upsert's facts. A row that existed but
 * was not in the snapshot (another sign-in from the same new browser
 * inserted it a moment earlier) counts as `known`: that other sign-in
 * sends the one alert.
 */
export function classifySignInDevice(facts: DeviceUpsertFacts): SignInDeviceKind {
  if (facts.inserted) return facts.hadDevices ? "new" : "first";
  if (facts.known) return "known";
  return facts.stale ? "new" : "known";
}
