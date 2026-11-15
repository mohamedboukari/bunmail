import { Elysia } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import { sqlStateOf } from "../../utils/db-error.ts";
import { PAGE_CSP } from "../../middleware/security-headers.ts";
import { rateLimitBucket, resolveClientIp } from "../../middleware/login-rate-limit.ts";
import {
  checkRateLimit,
  pruneExpiredEntries,
  type RateLimitEntry,
  type RateLimitOptions,
} from "../../middleware/rate-limit-core.ts";
import { recordTrackingRequest } from "../metrics/services/metrics.service.ts";
import {
  verifyClickToken,
  verifyOpenToken,
  type VerifiedClickToken,
} from "./services/tracking-token.ts";
import {
  checkClickLink,
  type ClickLinkCheck,
  type ClickRefusal,
} from "./services/tracking-epoch.service.ts";
import {
  createTrackingRecorder,
  type RecordResult,
  type TrackingRecorder,
} from "./services/tracking-record.service.ts";
import type { TrackingHit, TrackingKind } from "./types/tracking.types.ts";

/**
 * Public open and click tracking endpoints (#187), outside `/api` and
 * `/dashboard` like the unsubscribe pages. No auth: the token is the
 * credential (`tracking-token.ts`).
 *
 * - `GET /t/o/<token>.gif`: the 43-byte transparent GIF for a valid token
 *   (also when its email is gone: the recorder then finds no row), else a
 *   neutral 404. Both kinds of token verify without the database, so an
 *   invalid one is refused, and rate limited, before any query.
 * - `GET /t/c/<token>`: a `302` to the URL BunMail signed for that email
 *   and link, re-checked as `http(s)` at redirect time, else a neutral
 *   404 page that never shows the URL. No open redirect, and no
 *   server-side fetch anywhere. A token whose MAC verified must also
 *   match its sender domain's current tracking epoch (#424,
 *   `tracking-epoch.service.ts`): a revoked link, a link of a deleted
 *   domain, and a link from before #424 whose email is gone get the
 *   same 404 as an invalid token (and count against the same limit). A
 *   database failure on that check gets a `503`, never a redirect.
 *
 * Valid requests are always served, whatever `TRACKING_ENABLED` says
 * (links already sent keep working), and never rate limited: Gmail's and
 * Apple's proxies fetch for millions of people from a few addresses.
 * Only invalid tokens count against a per-client limit. The event is
 * recorded after the response is built, never delaying it
 * (`tracking-record.service.ts`); `HEAD` requests (link scanners) are
 * answered the same way and never recorded. Responses carry
 * `Cache-Control: no-store, private`, `Referrer-Policy: no-referrer`,
 * `X-Robots-Tag: noindex` and no cookie.
 */

/** Invalid tokens per client bucket per minute, before the 429. */
const DEFAULT_LIMIT: RateLimitOptions = { max: 30, windowMs: 60_000 };

/** A 1x1 transparent GIF (GIF89a, two-colour table, one transparent pixel): 43 bytes. */
export const TRANSPARENT_GIF = Buffer.from(
  "47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b",
  "hex",
);

/** Headers on every response of this plugin. */
const COMMON_HEADERS: Record<string, string> = {
  "cache-control": "no-store, private",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
};

/** The neutral page for an unusable link: says nothing about the token or a URL. */
const INVALID_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link not valid</title></head><body><p>This link is not valid.</p></body></html>';

function gifResponse(): Response {
  return new Response(TRANSPARENT_GIF, {
    status: 200,
    headers: { ...COMMON_HEADERS, "content-type": "image/gif" },
  });
}

function redirectResponse(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: { ...COMMON_HEADERS, location: url },
  });
}

function invalidResponse(): Response {
  return new Response(INVALID_PAGE, {
    status: 404,
    headers: {
      ...COMMON_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": PAGE_CSP,
    },
  });
}

/** The epoch check could not run (a database failure): never a redirect, never a 404 that would look final. */
function unavailableResponse(): Response {
  return new Response("Service unavailable", {
    status: 503,
    headers: {
      ...COMMON_HEADERS,
      "content-type": "text/plain; charset=utf-8",
      "retry-after": "30",
    },
  });
}

function limitedResponse(retryAfter: number): Response {
  return new Response("Too many requests", {
    status: 429,
    headers: {
      ...COMMON_HEADERS,
      "content-type": "text/plain; charset=utf-8",
      "retry-after": String(retryAfter),
    },
  });
}

/** Options of {@link trackingPlugin}; the defaults suit production. */
export interface TrackingPluginOptions {
  /** Invalid tokens per client bucket per window. */
  limit?: RateLimitOptions;
  /** The recorder; a test can pass one with a small budget. */
  recorder?: TrackingRecorder;
  /** Called with each background recording, so a test can wait for it. */
  onRecord?: (task: Promise<RecordResult | null>) => void;
  /** The epoch check of a verified click token (#424); a test can pass a failing one. */
  checkClick?: (token: VerifiedClickToken) => Promise<ClickLinkCheck>;
}

/** A verified click link refused by the epoch check (#424): ids only, never the URL. */
interface ClickRefusalLog {
  reason: ClickRefusal;
  emailId: string;
  domainId: string | null;
  position: number;
  tokenVersion: 1 | 2;
}

/**
 * Builds the plugin. Each instance has its own limiter and recorder;
 * `src/app.ts` mounts one.
 */
export function trackingPlugin(options: TrackingPluginOptions = {}) {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const recorder = options.recorder ?? createTrackingRecorder();
  const checkClick = options.checkClick ?? checkClickLink;
  const buckets = new Map<string, RateLimitEntry>();
  let lastPrune = Date.now();

  /**
   * Counts one invalid token for the client: the 429 once it is over the
   * limit (logged once per window and bucket), else the neutral 404. A
   * click link the epoch check refused (`refusal`) is logged at `info`
   * while the client is under the limit.
   */
  function refuse(
    kind: TrackingKind,
    request: Request,
    socketIp: string | undefined,
    refusal?: ClickRefusalLog,
  ): Response {
    recordTrackingRequest(kind, "invalid");
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
    if (refusal === undefined) {
      logger.debug("Tracking token not valid", { kind, method: request.method });
    } else if (!decision.limited) {
      logger.info("Tracking click link refused", { ...refusal, method: request.method });
    }
    if (!decision.limited) return invalidResponse();
    if (decision.count === limit.max + 1) {
      logger.warn("Tracking requests with invalid tokens rate limited", {
        bucket,
        kind,
        retryAfter: decision.retryAfter,
      });
    }
    return limitedResponse(decision.retryAfter);
  }

  /** Records a verified `GET` in the background; `HEAD` is never recorded. */
  function recordLater(request: Request, hit: Omit<TrackingHit, "userAgent">): void {
    if (request.method !== "GET") {
      recordTrackingRequest(hit.kind, "untracked");
      return;
    }
    const task = recorder({ ...hit, userAgent: request.headers.get("user-agent") })
      .then((result) => {
        /** `null`: the recorder failed and logged it (sanitized). */
        if (result !== null) recordTrackingRequest(hit.kind, result);
        return result;
      })
      .catch((error: unknown) => {
        /** Defensive: name and SQLSTATE only, never a driver message, the URL or the recipient. */
        logger.error("Tracking event not recorded", {
          emailId: hit.emailId,
          kind: hit.kind,
          errorName: error instanceof Error ? error.name : typeof error,
          sqlState: sqlStateOf(error),
        });
        return null;
      });
    options.onRecord?.(task);
  }

  return new Elysia({ name: "tracking" })
    .get(
      "/t/o/:file",
      ({ params, request, server }) => {
        /** Verified without the database: an invalid token never reaches a query. */
        const emailId = params.file.endsWith(".gif")
          ? verifyOpenToken(params.file.slice(0, -".gif".length))
          : null;
        if (emailId === null) {
          return refuse("open", request, server?.requestIP(request)?.address);
        }
        const response = gifResponse();
        recordLater(request, { kind: "open", emailId, position: null, url: null });
        return response;
      },
      { detail: { hide: true } },
    )
    .get(
      "/t/c/:token",
      async ({ params, request, server }) => {
        const socketIp = server?.requestIP(request)?.address;
        /** Verified without the database: an invalid token never reaches a query. */
        const subject = verifyClickToken(params.token);
        /** `verifyClickToken` only returns canonical `http(s)` URLs; checked again before redirecting. */
        const target = subject === null ? null : new URL(subject.url);
        if (
          subject === null ||
          target === null ||
          (target.protocol !== "http:" && target.protocol !== "https:")
        ) {
          return refuse("click", request, socketIp);
        }
        /** The domain's current tracking epoch (#424): a revoked link never redirects. */
        let check: ClickLinkCheck;
        try {
          check = await checkClick(subject);
        } catch (error) {
          /** Name and SQLSTATE only, never a driver message or the URL. */
          logger.error("Tracking click link not checked", {
            emailId: subject.emailId,
            tokenVersion: subject.version,
            errorName: error instanceof Error ? error.name : typeof error,
            sqlState: sqlStateOf(error),
          });
          return unavailableResponse();
        }
        if (!check.ok) {
          return refuse("click", request, socketIp, {
            reason: check.reason,
            emailId: subject.emailId,
            domainId: check.domainId,
            position: subject.position,
            tokenVersion: subject.version,
          });
        }
        const response = redirectResponse(subject.url);
        recordLater(request, {
          kind: "click",
          emailId: subject.emailId,
          position: subject.position,
          url: subject.url,
        });
        return response;
      },
      { detail: { hide: true } },
    );
}
