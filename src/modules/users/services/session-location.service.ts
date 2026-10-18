import { logger } from "../../../utils/logger.ts";
import * as geoip from "./geoip.service.ts";
import { setSessionLocation } from "./session.service.ts";

/**
 * Stores the approximate location of a new session (#281), after the
 * session exists. Every place that opens a session calls it once the
 * session row is committed (the login handler, and owner setup,
 * invitation accept, password reset and password change after their
 * transaction), and does not wait for it: a slow, rate-limited or down
 * GeoIP source never delays or fails a sign-in. When it is done the
 * page shows the location; until then (or when nothing is known) the
 * column stays empty.
 *
 * Never rejects: a failed lookup or write is logged at `warn` with the
 * session id and a sanitized message, and the session is left as it is.
 * Runs in the request's log context, so its lines carry the request id.
 *
 * @returns the location stored, or `null` when none was (callers `void`
 *          it; the login hands it to the new-device check, #282, which
 *          waits for it a short while; tests await it).
 */
export async function locateSession(
  sessionId: string,
  ip: string | null,
): Promise<string | null> {
  try {
    const location = await geoip.lookupLocation(ip);
    if (!location) return null;
    await setSessionLocation(sessionId, location);
    logger.debug("Session location stored", { sessionId });
    return location;
  } catch (error: unknown) {
    logger.warn("Session location lookup failed", {
      sessionId,
      ip,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
