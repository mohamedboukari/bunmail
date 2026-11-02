import { config } from "../../config.ts";
import { resolveClientIp } from "../../middleware/login-rate-limit.ts";

/** The client IP of a request, for the log lines (the login limiter's resolution). */
export function clientIp(request: Request, socketIp: string | undefined): string {
  return resolveClientIp({
    socketIp,
    forwardedFor: request.headers.get("x-forwarded-for"),
    trustedProxyHops: config.dashboard.trustedProxyHops,
  });
}
