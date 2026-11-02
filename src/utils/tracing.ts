import {
  context,
  INVALID_SPAN_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
  type SpanOptions,
  type Tracer,
} from "@opentelemetry/api";
import type { SpanExporter } from "@opentelemetry/sdk-trace";
import type { TracingSettings } from "../config.ts";
import { loggableError } from "./db-error.ts";
import { logger, redactSecrets } from "./logger.ts";
import { maskEmailsInText, redactUrl } from "./redact.ts";

/**
 * OpenTelemetry tracing (#363): spans for the HTTP request, the queue send
 * attempt and its MX deliveries, webhook delivery and SMTP sessions,
 * exported over OTLP/HTTP when an endpoint is configured.
 *
 * Off by default. This module imports only `@opentelemetry/api`, whose
 * calls are no-ops until a tracer provider is installed; the SDK (exporter,
 * processors, context manager) lives in `tracing-sdk.ts` and is loaded
 * with a dynamic `import()` by {@link startTracing} only when tracing is
 * on, so a default install never loads it. While off, the helpers below
 * skip span work entirely and log lines carry no trace fields.
 *
 * Spans are created by hand at those few boundaries: nothing is
 * auto-instrumented (on Bun there is nothing useful to instrument, and
 * `@elysiajs/opentelemetry` records every header, cookie and body). Every
 * attribute is chosen at its call site from identifiers and counts, never
 * a header, a body, an email address or a secret; error messages are
 * sanitized by {@link spanSafeMessage}.
 *
 * Context: spans become active only through `startActiveSpan` and
 * `context.with`, which use `AsyncLocalStorage.run`. Never call
 * `context.attach()`: on Bun it falls back to `AsyncLocalStorage.enterWith`,
 * which segfaults inside Elysia hooks (see docs/logging.md).
 */

/**
 * The tracer of every BunMail span (scope `bunmail`), looked up per call:
 * a tracer kept across a stop and a new start would keep sending to the
 * stopped provider.
 */
export function bunmailTracer(): Tracer {
  return trace.getTracer("bunmail");
}

/** What {@link startTracing} gets back from the SDK module. */
export interface TracingSdk {
  /** Exports the spans still buffered, shuts the SDK down and unregisters it. Never rejects. */
  stop(timeoutMs: number): Promise<void>;
}

/** The running SDK, or `null` while tracing is off. */
let running: TracingSdk | null = null;

/** True while tracing is on (spans are recorded and exported). */
export function isTracingActive(): boolean {
  return running !== null;
}

/**
 * Turns tracing on when `settings` say so (#363): loads the SDK module,
 * installs the tracer provider, context manager and W3C propagator, and
 * logs the export endpoint's origin once. Does nothing when tracing is off
 * or already on. `exporter` replaces the OTLP exporter (tests: an
 * in-memory exporter, spans exported synchronously). Returns whether
 * tracing is on.
 */
export async function startTracing(
  settings: TracingSettings,
  version: string,
  exporter?: SpanExporter,
): Promise<boolean> {
  if (!settings.enabled || running !== null) return running !== null;
  const { installTracingSdk } = await import("./tracing-sdk.ts");
  running = installTracingSdk(settings, version, exporter);
  logger.info("Tracing enabled", {
    /** Origin only: an endpoint can carry credentials in its path or query. */
    endpoint: redactUrl(settings.endpoint),
    serviceName: settings.serviceName,
    sampler: settings.sampler,
    samplerRatio: settings.samplerRatio,
  });
  return true;
}

/**
 * Exports the spans still buffered and turns tracing off, waiting at most
 * `timeoutMs` (shutdown must not hang on an unreachable collector). Never
 * rejects; a failure is logged. No-op while tracing is off.
 */
export async function stopTracing(timeoutMs: number = 5_000): Promise<void> {
  const sdk = running;
  if (sdk === null) return;
  running = null;
  await sdk.stop(timeoutMs);
}

/** The span handed to callbacks while tracing is off: records nothing. */
const NOOP_SPAN: Span = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);

/** Longest error message recorded on a span. */
const MAX_SPAN_MESSAGE_LENGTH = 300;

/** An http(s) URL inside free text. */
const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/g;

/**
 * An error's message as a span may carry it, since spans leave the server:
 * a drizzle query error reduced to its SQLSTATE (its message embeds the
 * query parameters), every email address masked whatever `LOG_REDACT_PII`
 * says, every URL cut to its origin (webhook URLs carry credentials in the
 * path), and the length capped.
 */
export function spanSafeMessage(error: unknown): string {
  const masked = maskEmailsInText(loggableError(error)).replace(URL_IN_TEXT, (url) =>
    redactUrl(url),
  );
  const stripped = redactSecrets(masked);
  return (typeof stripped === "string" ? stripped : "").slice(0, MAX_SPAN_MESSAGE_LENGTH);
}

/**
 * Marks `span` as failed with `error`: an exception event and an error
 * status, both with the sanitized message ({@link spanSafeMessage}) and
 * never the stack, whose first line repeats the raw message.
 */
export function recordSpanError(span: Span, error: unknown): void {
  const message = spanSafeMessage(error);
  span.recordException({ name: error instanceof Error ? error.name : "Error", message });
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/**
 * Runs `fn` inside a new active span named `name` and ends the span when
 * `fn` settles; a thrown error is recorded ({@link recordSpanError}) and
 * rethrown. While tracing is off, `fn` runs directly with a span that
 * records nothing.
 */
export function withSpan<T>(
  name: string,
  options: SpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  if (running === null) return fn(NOOP_SPAN);
  return bunmailTracer().startActiveSpan(name, options, async (span) => {
    try {
      return await fn(span);
    } catch (error: unknown) {
      recordSpanError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Which SMTP listener a session belongs to. */
type SmtpListenerName = "inbound" | "submission";

/** Most SMTP sessions traced at once; beyond it a new session is not traced. */
const MAX_TRACED_SMTP_SESSIONS = 10_000;

/** The SMTP reply a message ended with: the error's `responseCode`, else 250, or `null`. */
function smtpReplyCode(error: unknown): number | null {
  if (error === undefined || error === null) return 250;
  const code: unknown =
    error instanceof Error ? Reflect.get(error, "responseCode") : null;
  return typeof code === "number" ? code : null;
}

/**
 * The spans of one SMTP listener's sessions (#363), keyed by `smtp-server`
 * session id: one root `smtp.session` span per connection, from connect to
 * close, and one `smtp.message` child per message received. smtp-server
 * calls each handler separately, so a handler re-enters its session's span
 * with {@link SmtpSessionTracer.run}. Spans carry the listener, the session
 * id and counts, never an address (IP or email) or message content.
 */
export interface SmtpSessionTracer {
  /** Starts the session span (`onConnect`). */
  open(sessionId: string): void;
  /** Ends the session span (`onClose`), with the number of messages received. */
  close(sessionId: string, messages: number): void;
  /**
   * Starts a `smtp.message` span (`onData`) and returns `callback`
   * wrapped to end it with the SMTP reply the message got: an error's
   * `responseCode`, or 250. A 451 (a local failure) or an error without a
   * code marks the span as failed; other refusals are the client's.
   */
  message<A extends unknown[]>(
    sessionId: string,
    recipientCount: number,
    callback: (...args: A) => void,
  ): (...args: A) => void;
  /** Runs `fn` with the session's open message span, else its session span, active. */
  run<T>(sessionId: string, fn: () => T): T;
}

/** Creates the {@link SmtpSessionTracer} of one listener. */
export function smtpSessionTracer(listener: SmtpListenerName): SmtpSessionTracer {
  const live = new Map<string, { session: Span; message: Span | null }>();
  return {
    open(sessionId) {
      if (running === null || live.size >= MAX_TRACED_SMTP_SESSIONS) return;
      const session = bunmailTracer().startSpan("smtp.session", {
        kind: SpanKind.SERVER,
        root: true,
        attributes: {
          "bunmail.smtp.listener": listener,
          "bunmail.smtp.session_id": sessionId,
        },
      });
      live.set(sessionId, { session, message: null });
    },

    close(sessionId, messages) {
      const entry = live.get(sessionId);
      if (entry === undefined) return;
      live.delete(sessionId);
      /** A message still open when the connection dropped. */
      entry.message?.end();
      entry.session.setAttribute("bunmail.smtp.messages", messages);
      entry.session.end();
    },

    message(sessionId, recipientCount, callback) {
      const entry = live.get(sessionId);
      if (entry === undefined) return callback;
      entry.message?.end();
      const span = bunmailTracer().startSpan(
        "smtp.message",
        {
          attributes: {
            "bunmail.smtp.listener": listener,
            "bunmail.smtp.recipient_count": recipientCount,
          },
        },
        trace.setSpan(context.active(), entry.session),
      );
      entry.message = span;
      let ended = false;
      return (...args) => {
        if (!ended) {
          ended = true;
          const code = smtpReplyCode(args[0]);
          if (code !== null) span.setAttribute("bunmail.smtp.reply_code", code);
          if (code === null || code === 451) recordSpanError(span, args[0]);
          span.end();
          if (entry.message === span) entry.message = null;
        }
        callback(...args);
      };
    },

    run(sessionId, fn) {
      const entry = live.get(sessionId);
      if (entry === undefined) return fn();
      return context.with(
        trace.setSpan(context.active(), entry.message ?? entry.session),
        fn,
      );
    },
  };
}
