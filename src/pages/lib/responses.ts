import type { Context } from "elysia";

/** Answers with a 302 to `location`; the body is empty. */
export function redirect(set: Context["set"], location: string): string {
  set.status = 302;
  set.headers["location"] = location;
  return "";
}

/**
 * `Cache-Control: no-store` for pages that can render a one-time secret
 * (API key, webhook secret, invitation link): neither the browser nor a
 * proxy may keep a copy of the page that showed it.
 */
export function setNoStore(set: Context["set"]): void {
  set.headers["cache-control"] = "no-store";
}

/**
 * Builds the flash-banner prop from the `flash` / `flashType` query
 * params. Both are attacker-controllable, so `flashType` is narrowed to
 * the two values the banner actually renders rather than asserted: an
 * `as "success" | "error"` cast would let an arbitrary string through
 * wearing the union's type.
 */
export function toFlash(
  message: string | undefined,
  rawType: string | undefined,
): { message: string; type: "success" | "error" } | undefined {
  if (!message) return undefined;
  return { message, type: rawType === "error" ? "error" : "success" };
}
