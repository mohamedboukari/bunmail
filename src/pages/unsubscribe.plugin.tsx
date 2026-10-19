import { Elysia } from "elysia";
import { config } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { maskEmail } from "../utils/redact.ts";
import { PAGE_CSP } from "../middleware/security-headers.ts";
import { rateLimitBucket, resolveClientIp } from "../middleware/login-rate-limit.ts";
import {
  checkRateLimit,
  pruneExpiredEntries,
  type RateLimitEntry,
  type RateLimitOptions,
} from "../middleware/rate-limit-core.ts";
import {
  resolveUnsubscribeToken,
  unsubscribe,
  type UnsubscribeTarget,
} from "../modules/suppressions/services/unsubscribe.service.ts";
import type { UnsubscribeSource } from "../modules/suppressions/types/suppression.types.ts";
import {
  UnsubscribeConfirmPage,
  UnsubscribeDonePage,
  UnsubscribeInvalidPage,
  UnsubscribeRateLimitedPage,
} from "./routes/unsubscribe.tsx";

/**
 * Public one-click unsubscribe endpoint (#249): `GET` and `POST /u/:token`,
 * the URL in the per-recipient `List-Unsubscribe` header. No auth: the
 * token is the credential (an HMAC over email id, recipient and API key,
 * see `unsubscribe-token.ts`).
 *
 * - `GET` only shows a confirmation page. It never suppresses: link
 *   scanners, antivirus gateways and mail-client prefetchers fetch GETs.
 * - `POST` suppresses: the RFC 8058 one-click request
 *   (`List-Unsubscribe=One-Click`, sent by the mailbox provider) or the
 *   confirmation form. There is deliberately no CSRF or same-origin check:
 *   providers POST from their own servers, cross-origin by design, and
 *   the worst a forged POST can do is what the token already allows, i.e.
 *   unsubscribe the one recipient that token names.
 *
 * Both are rate limited per client IP (an IPv6 client per /64), answer
 * with `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and
 * `X-Robots-Tag: noindex`, under the page CSP with no script. Every
 * unusable token gets the same 404 page; nothing echoes the token or the
 * full address.
 */

/** Requests per client bucket per minute, across GET and POST. */
const DEFAULT_LIMIT: RateLimitOptions = { max: 30, windowMs: 60_000 };

/** Headers on every response of this plugin. */
const PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": PAGE_CSP,
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

/** A page response with the headers above. */
async function pageResponse(
  content: string | Promise<string>,
  status: number,
  extra: Record<string, string> = {},
): Promise<Response> {
  return new Response("<!doctype html>" + (await content), {
    status,
    headers: { ...PAGE_HEADERS, ...extra },
  });
}

/** One field of a parsed form body, if it is a string. */
function formField(body: unknown, name: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value: unknown = Reflect.get(body, name);
  return typeof value === "string" ? value : undefined;
}

/**
 * Which kind of POST this is: the RFC 8058 one-click body, the
 * confirmation form, or neither (`null`, refused).
 */
function postSource(body: unknown): UnsubscribeSource | null {
  if (formField(body, "List-Unsubscribe")?.trim().toLowerCase() === "one-click") {
    return "one_click";
  }
  if (formField(body, "confirm") === "unsubscribe") return "link";
  return null;
}

/** What the pages show about a target. */
function pageSubject(target: UnsubscribeTarget): {
  maskedAddress: string;
  senderDomain: string;
} {
  return {
    maskedAddress: maskEmail(target.recipient),
    senderDomain: target.senderDomain,
  };
}

/**
 * Builds the plugin. Each instance has its own limiter state, so a test
 * can use a fresh one; `src/index.ts` mounts one.
 *
 * @param limit Requests per client bucket per window (default 30 a minute).
 */
export function unsubscribePlugin(limit: RateLimitOptions = DEFAULT_LIMIT) {
  const buckets = new Map<string, RateLimitEntry>();
  let lastPrune = Date.now();

  /**
   * Counts one request for the client and returns the 429 page when it is
   * over the limit, else `null`. Expired buckets are swept at most once a
   * window, here, so the map cannot grow without a timer.
   */
  async function throttle(
    request: Request,
    socketIp: string | undefined,
  ): Promise<Response | null> {
    const now = Date.now();
    if (now - lastPrune >= limit.windowMs) {
      pruneExpiredEntries(buckets, now, limit.windowMs);
      lastPrune = now;
    }
    const bucket = rateLimitBucket(
      resolveClientIp({
        socketIp,
        forwardedFor: request.headers.get("x-forwarded-for"),
        trustedProxyHops: config.dashboard.trustedProxyHops,
      }),
    );
    const decision = checkRateLimit(buckets, bucket, now, limit);
    if (!decision.limited) return null;
    logger.warn("Unsubscribe request rate limited", {
      bucket,
      method: request.method,
      retryAfter: decision.retryAfter,
    });
    return pageResponse(UnsubscribeRateLimitedPage(), 429, {
      "retry-after": String(decision.retryAfter),
    });
  }

  return new Elysia({ name: "unsubscribe" })
    .get(
      "/u/:token",
      async ({ params, request, server }) => {
        const limited = await throttle(request, server?.requestIP(request)?.address);
        if (limited) return limited;

        const target = await resolveUnsubscribeToken(params.token);
        if (!target) {
          logger.warn("Unsubscribe link not valid", { method: "GET" });
          return pageResponse(UnsubscribeInvalidPage(), 404);
        }
        return pageResponse(UnsubscribeConfirmPage(pageSubject(target)), 200);
      },
      { detail: { hide: true } },
    )
    .post(
      "/u/:token",
      async ({ params, body, request, server }) => {
        const limited = await throttle(request, server?.requestIP(request)?.address);
        if (limited) return limited;

        const target = await resolveUnsubscribeToken(params.token);
        if (!target) {
          logger.warn("Unsubscribe link not valid", { method: "POST" });
          return pageResponse(UnsubscribeInvalidPage(), 404);
        }

        const source = postSource(body);
        if (source === null) {
          logger.warn("Unsubscribe POST without a one-click or confirmation body", {
            emailId: target.emailId,
          });
          return pageResponse(UnsubscribeConfirmPage(pageSubject(target)), 400);
        }

        await unsubscribe(target, source);
        return pageResponse(UnsubscribeDonePage(pageSubject(target)), 200);
      },
      { detail: { hide: true } },
    );
}
