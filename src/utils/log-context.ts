import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "crypto";

/**
 * Request-scoped log context (#284): the correlation ID that ties together
 * every log line of one HTTP request, queued email attempt, SMTP session,
 * webhook delivery or background job, so a post-mortem can reconstruct
 * what happened to it with one search.
 *
 * Carried by `AsyncLocalStorage`, so it follows every `await` without
 * being passed around: the logger reads it and adds its fields to each
 * line. Contexts nest: an inner `runWithLogContext` sees the outer fields
 * plus its own.
 *
 * Only `run` is used, never `enterWith`: calling `enterWith` inside an
 * Elysia hook segfaults Bun 1.3.14. HTTP requests enter their context
 * through Elysia's `wrap` hook instead (`src/index.ts`).
 */

/**
 * Fields attached to every log line written inside a context. All are
 * identifiers, never secrets or message content.
 */
export interface LogContext {
  /** HTTP request (`X-Request-Id`), reused from a trusted proxy or generated. */
  requestId?: string;
  /** A unit of background work: an email id, a webhook delivery id, a job name. */
  jobId?: string;
  /** What kind of work `jobId` names, e.g. `email-send`, `webhook-delivery`, `purge`. */
  job?: string;
  /** The `smtp-server` session id of an inbound or submission connection. */
  smtpSessionId?: string;
  /** Which SMTP listener the session belongs to. */
  listener?: "inbound" | "submission";
  /** The signed-in dashboard user the request acts as (#222), for "who did what". */
  userId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Runs `fn` with `context` merged over the current one (inner fields win)
 * and returns its result. Synchronous and asynchronous functions alike:
 * every `await` inside `fn` keeps the context.
 */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, fn);
}

/**
 * Records the signed-in dashboard user on the current context (#222):
 * every later line of the request, including its `HTTP request` line,
 * carries `userId`, so a post-mortem can tell who did what. The current
 * store belongs to this request alone (each `runWithLogContext` creates a
 * fresh object), so setting a field on it cannot leak into other work.
 * No-op outside a context.
 */
export function setLogContextUser(userId: string): void {
  const store = storage.getStore();
  if (store) store.userId = userId;
}

/** The context of the code currently running, or `undefined` outside any. */
export function getLogContext(): LogContext | undefined {
  return storage.getStore();
}

/** Accepted shape of an incoming `X-Request-Id`: short and log-safe. */
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * A fresh request ID: `req_` plus 16 random bytes in hex, unique enough to
 * search for and short enough to quote in a bug report.
 */
export function newRequestId(): string {
  return `req_${randomBytes(16).toString("hex")}`;
}

/**
 * The ID for an incoming request: the `X-Request-Id` a reverse proxy set,
 * when it is 1 to 64 characters of `[A-Za-z0-9._-]` (so it can never
 * break a log line or a header), otherwise a new one.
 */
export function requestIdFrom(header: string | null): string {
  return header !== null && REQUEST_ID_RE.test(header) ? header : newRequestId();
}
