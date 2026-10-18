import { requestIdFrom, runWithLogContext } from "../utils/log-context.ts";
import { logger } from "../utils/logger.ts";

/**
 * Request context and the per-request log line (#284).
 *
 * `withRequestContext` is passed to Elysia's `wrap` (`src/index.ts`), so it
 * runs around the whole request pipeline: hooks, handler, error handler.
 * Inside it every log line carries the request's `requestId`, the ID goes
 * back to the client as `X-Request-Id`, and one line records the outcome:
 *
 *   HTTP request { requestId, method, path, status, durationMs }
 *
 * `wrap` is Elysia's own extension point for this (its OpenTelemetry plugin
 * uses it). The obvious alternative, `AsyncLocalStorage.enterWith` in an
 * `onRequest` hook, segfaults Bun 1.3.14; wrapping `Bun.serve`'s fetch
 * instead would lose `server.requestIP`, which the login limiter needs.
 */

/** Paths that are polled or fetched constantly; logged at `debug` when healthy. */
const QUIET_PATHS = new Set(["/health", "/favicon.ico", "/favicon.svg"]);

/** Statuses worth a `warn`: authentication and rate-limit refusals. */
const SECURITY_STATUSES = new Set([401, 403, 429]);

/**
 * A path segment that looks like a credential: 32 or more URL-safe
 * characters (a base64url token, a hex hash). Masked in the request line.
 */
const TOKEN_SEGMENT_RE = /^[A-Za-z0-9_-]{32,}$/;

/**
 * The path as it appears in the request line: the query string dropped
 * (owner setup links carry their token there) and token-like segments
 * replaced with `:token`, so no credential reaches the logs.
 */
export function requestLogPath(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "(unparseable)";
  }
  return pathname
    .split("/")
    .map((segment) => (TOKEN_SEGMENT_RE.test(segment) ? ":token" : segment))
    .join("/");
}

/**
 * Level of the request line: `error` for 5xx, `warn` for 401/403/429,
 * `debug` for healthy health checks and favicons, `info` otherwise.
 */
export function requestLogLevel(
  status: number,
  path: string,
): "debug" | "info" | "warn" | "error" {
  if (status >= 500) return "error";
  if (SECURITY_STATUSES.has(status)) return "warn";
  if (QUIET_PATHS.has(path)) return "debug";
  return "info";
}

/** Writes the one line that records a request's outcome. */
function logRequest(request: Request, status: number, startedAt: number): void {
  const path = requestLogPath(request.url);
  const fields = {
    method: request.method,
    path,
    status,
    durationMs: Math.round(performance.now() - startedAt),
  };
  logger[requestLogLevel(status, path)]("HTTP request", fields);
}

/**
 * Elysia `wrap` hook: runs each request inside its own log context. The
 * ID is the incoming `X-Request-Id` when it is well formed (a reverse
 * proxy's ID, so both sides' logs share it), otherwise a new one.
 *
 * Elysia calls this with its request handler and the request, then calls
 * the returned function with the request.
 */
export function withRequestContext(
  handle: (...args: unknown[]) => unknown,
  request: Request,
): (...args: unknown[]) => Promise<unknown> {
  return (...args: unknown[]) => {
    const requestId = requestIdFrom(request.headers.get("x-request-id"));
    const startedAt = performance.now();
    return runWithLogContext({ requestId }, async () => {
      let result: unknown;
      try {
        result = await handle(...args);
      } catch (error: unknown) {
        /** Elysia normally turns errors into responses; this is the fallback. */
        logRequest(request, 500, startedAt);
        throw error;
      }
      if (result instanceof Response) {
        try {
          result.headers.set("x-request-id", requestId);
        } catch {
          /** Immutable headers (a proxied response): the ID is still in the logs. */
        }
        logRequest(request, result.status, startedAt);
      }
      return result;
    });
  };
}
