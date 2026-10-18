import { logger } from "../../../utils/logger.ts";
import { UserStoreError } from "../errors.ts";
import { sendNewDeviceAlert } from "./new-device-alert.service.ts";
import { recordSignInDevice } from "./user-device.service.ts";
import { describeUserAgent } from "./user-agent.service.ts";

/**
 * The new-device check of a password sign-in (#282), run by the login
 * handler after it decided the response, without waiting for it: it
 * never delays or fails a sign-in.
 *
 * Records the browser (`user_devices`, keyed by the `bm_device` cookie)
 * and, when the account has not used it in the last 30 days, sends the
 * "New sign-in to your BunMail account" alert. The account's first
 * device is recorded silently. See `device-policy.service.ts`.
 */

/**
 * How long the check waits for the session's location lookup (#281)
 * before it goes on without a location. Online GeoIP gives up after 3 s;
 * the alert should not wait that long.
 */
export const LOCATION_WAIT_MS = 2000;

/** One successful password sign-in. */
export interface SignInDeviceEvent {
  userId: string;
  /** The account's address: the alert goes there. */
  email: string;
  /** The `bm_device` cookie value the response sets (well-formed). */
  deviceToken: string;
  /** A valid IP literal, or null. */
  ip: string | null;
  /** The raw `User-Agent`; only its label is kept. */
  userAgent: string | null;
  /** The session's location lookup (`locateSession`), which never rejects. */
  location: Promise<string | null>;
  /** When the sign-in happened. */
  at: Date;
}

/** `promise`'s value, or `null` when it takes longer than `ms`. */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Records the sign-in's device and alerts the account when it is new.
 * Never rejects: a failure is logged at `warn` with the user id, the IP
 * and the error's name (and SQLSTATE), never a raw message.
 *
 * @returns a promise that settles when the check is done (the login
 *          handler `void`s it; tests await it).
 */
export async function recognizeSignInDevice(event: SignInDeviceEvent): Promise<void> {
  try {
    const location = await settleWithin(event.location, LOCATION_WAIT_MS);
    const label = describeUserAgent(event.userAgent);
    const device = await recordSignInDevice({
      userId: event.userId,
      deviceToken: event.deviceToken,
      label,
      ip: event.ip,
      location,
    });
    const ids = { userId: event.userId, deviceId: device.deviceId };

    if (device.kind === "first") {
      logger.info("First sign-in device recorded, no alert", ids);
      return;
    }
    if (device.kind === "known") {
      logger.debug("Sign-in from a known device", ids);
      return;
    }

    logger.info("New-device sign-in", { ...ids, ip: event.ip });
    await sendNewDeviceAlert({
      ...ids,
      email: event.email,
      device: label,
      ip: event.ip,
      location,
      at: event.at,
    });
  } catch (error: unknown) {
    logger.warn("New-device sign-in check failed", {
      userId: event.userId,
      ip: event.ip,
      errorName: error instanceof Error ? error.name : typeof error,
      ...(error instanceof UserStoreError ? { sqlState: error.sqlState } : {}),
    });
  }
}
