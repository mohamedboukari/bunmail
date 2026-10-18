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
 * @returns a promise that settles when the lookup is done (callers
 *          `void` it; tests await it).
 */
export async function locateSession(sessionId: string, ip: string | null): Promise<void> {
  try {
    const location = await geoip.lookupLocation(ip);
    if (!location) return;
    await setSessionLocation(sessionId, location);
    logger.debug("Session location stored", { sessionId });
  } catch (error: unknown) {
    logger.warn("Session location lookup failed", {
      sessionId,
      ip,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
