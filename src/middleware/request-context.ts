import {
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { config } from "../config.ts";
import { requestIdFrom, runWithLogContext } from "../utils/log-context.ts";
import { logger } from "../utils/logger.ts";
import { bunmailTracer, isTracingActive, recordSpanError } from "../utils/tracing.ts";
import {
  httpArea,
  recordHttpRequest,
} from "../modules/metrics/services/metrics.service.ts";

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
 * With tracing on (#363), the same wrap runs the request inside a SERVER
 * span, so every log line of the request also carries its `traceId`.
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

/** Writes the one line that records a request's outcome, and counts it (#362). */
function logRequest(request: Request, status: number, startedAt: number): void {
  const path = requestLogPath(request.url);
  const elapsedMs = performance.now() - startedAt;
  const fields = {
    method: request.method,
    path,
    status,
    durationMs: Math.round(elapsedMs),
  };
  logger[requestLogLevel(status, path)]("HTTP request", fields);
  recordHttpRequest(request.method, path, status, elapsedMs / 1000);
}

/** Methods a span names as they are; anything else is `_OTHER` (OpenTelemetry semantic conventions). */
const SPAN_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

/**
 * True when the request came through the configured chain of trusted
 * proxies (#363): `DASHBOARD_TRUSTED_PROXY_HOPS` is at least 1 and the
 * request carries at least that many `X-Forwarded-For` entries. The same
 * test `resolveClientIp` applies before it trusts `X-Forwarded-For`
 * (#109, #256); like it, it cannot tell a forged header from a real one
 * when the app port is reachable directly, so bind the port to the proxy.
 */
export function cameThroughTrustedProxies(
  forwardedFor: string | null,
  trustedProxyHops: number,
): boolean {
  if (trustedProxyHops <= 0) return false;
  const entries = (forwardedFor ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return entries.length >= trustedProxyHops;
}

/**
 * The parent of a request's span (#363): the incoming W3C `traceparent`
 * (and `tracestate`) only when the request came through the trusted
 * proxies ({@link cameThroughTrustedProxies}), so the trace continues from
 * the proxy or the calling service; otherwise none, and the request starts
 * a new trace. A client on the open internet thus cannot pick the trace a
 * request joins, nor force it to be sampled. Only those two headers are
 * handed to the propagator, never the whole set.
 */
export function incomingTraceContext(
  headers: Headers,
  trustedProxyHops: number,
): Context {
  const traceparent = headers.get("traceparent");
  if (
    traceparent === null ||
    !cameThroughTrustedProxies(headers.get("x-forwarded-for"), trustedProxyHops)
  ) {
    return ROOT_CONTEXT;
  }
  const carrier: Record<string, string> = { traceparent };
  const tracestate = headers.get("tracestate");
  if (tracestate !== null) carrier["tracestate"] = tracestate;
  return propagation.extract(ROOT_CONTEXT, carrier);
}

/** Records the response status on a request's span; a 5xx marks it as failed. */
function setSpanStatus(span: Span, status: number): void {
  span.setAttribute("http.response.status_code", status);
  if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
}

/**
 * Runs `run` inside the request's SERVER span (#363), when tracing is on.
 * The span is named after the method and the `area` of the path (a fixed
 * set, see `httpArea`), and its attributes come from an allowlist only:
 * method, the path as the request line shows it (no query string,
 * token-like segments masked), status and request ID. Never a header, a
 * cookie, a query string or a body. Health checks and favicons are not
 * traced: they would bury the traces worth reading.
 */
function traceRequest(
  request: Request,
  requestId: string,
  trustedProxyHops: number,
  run: () => Promise<unknown>,
): Promise<unknown> {
  if (!isTracingActive()) return run();
  const path = requestLogPath(request.url);
  if (QUIET_PATHS.has(path)) return run();
  const method = SPAN_METHODS.has(request.method) ? request.method : "_OTHER";
  return bunmailTracer().startActiveSpan(
    `${method} ${httpArea(path)}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": method,
        "url.path": path,
        "bunmail.request_id": requestId,
      },
    },
    incomingTraceContext(request.headers, trustedProxyHops),
    async (span) => {
      try {
        const result = await run();
        if (result instanceof Response) setSpanStatus(span, result.status);
        return result;
      } catch (error: unknown) {
        setSpanStatus(span, 500);
        recordSpanError(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** Elysia's `wrap` hook, see {@link withRequestContext}. */
type RequestWrap = (
  handle: (...args: unknown[]) => unknown,
  request: Request,
) => (...args: unknown[]) => Promise<unknown>;

/**
 * Builds the `wrap` hook. `trustedProxyHops` decides whether an incoming
 * `traceparent` is honoured ({@link incomingTraceContext}); unset, it is
 * `DASHBOARD_TRUSTED_PROXY_HOPS`, read per request. Tests pass their own.
 */
export function createRequestContext(trustedProxyHops?: number): RequestWrap {
  return (handle, request) =>
    (...args: unknown[]) => {
      const requestId = requestIdFrom(request.headers.get("x-request-id"));
      const startedAt = performance.now();
      const hops = trustedProxyHops ?? config.dashboard.trustedProxyHops;
      return runWithLogContext({ requestId }, () =>
        traceRequest(request, requestId, hops, async () => {
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
        }),
      );
    };
}

/**
 * Elysia `wrap` hook: runs each request inside its own log context and,
 * when tracing is on (#363), its own span. The ID is the incoming
 * `X-Request-Id` when it is well formed (a reverse proxy's ID, so both
 * sides' logs share it), otherwise a new one.
 *
 * Elysia calls this with its request handler and the request, then calls
 * the returned function with the request.
 */
export const withRequestContext: RequestWrap = createRequestContext();
