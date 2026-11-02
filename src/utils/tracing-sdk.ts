import {
  context,
  diag,
  DiagLogLevel,
  propagation,
  trace,
  type DiagLogger,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  defaultResource,
  detectResources,
  envDetector,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  TracerProvider,
  type Sampler,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import type { TracesSampler, TracingSettings } from "../config.ts";
import { loggableError } from "./db-error.ts";
import { logger } from "./logger.ts";
import type { TracingSdk } from "./tracing.ts";

/**
 * The OpenTelemetry SDK setup (#363), loaded only when tracing is on: by
 * the dynamic `import()` in `startTracing` (`tracing.ts`), never imported
 * statically, so a default install never loads the SDK.
 *
 * The minimal OpenTelemetry JS 3.x set, no `sdk-node` and no
 * auto-instrumentation: a `TracerProvider` with a batch processor and the
 * OTLP/HTTP protobuf exporter, `AsyncLocalStorageContextManager` (its
 * `with()` is `AsyncLocalStorage.run`; `attach()` is never called, see
 * `tracing.ts`), and the W3C trace-context propagator.
 */

/** Longest attribute value a span keeps; longer strings are cut. */
const MAX_ATTRIBUTE_LENGTH = 1024;

/** How often the same OpenTelemetry diagnostic may repeat in the log. */
const DIAG_REPEAT_INTERVAL_MS = 60_000;

/** Most distinct diagnostics remembered for that throttle. */
const DIAG_MAX_TRACKED = 100;

/** The sampler `OTEL_TRACES_SAMPLER` names. */
function samplerFor(name: TracesSampler, ratio: number): Sampler {
  switch (name) {
    case "always_on":
      return new AlwaysOnSampler();
    case "always_off":
      return new AlwaysOffSampler();
    case "traceidratio":
      return new TraceIdRatioBasedSampler(ratio);
    case "parentbased_always_on":
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
    case "parentbased_always_off":
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case "parentbased_traceidratio":
      return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
  }
}

/** One diagnostic argument as a log field: a sanitized error message, a short string, or a type. */
function diagArgument(arg: unknown): string {
  if (arg instanceof Error) return loggableError(arg).slice(0, 300);
  if (typeof arg === "string") return arg.slice(0, 300);
  if (Array.isArray(arg)) return arg.map((item) => diagArgument(item)).join("; ");
  return typeof arg;
}

/**
 * OpenTelemetry's own diagnostics (an export that failed, a dropped span)
 * routed to the BunMail logger, so a collector that is down shows in the
 * logs. The same message is written at most once a minute, with the number
 * of repeats it stood for: a dead collector fails every batch.
 */
function diagLogger(): DiagLogger {
  const lastSeen = new Map<string, { at: number; suppressed: number }>();
  const write =
    (level: "error" | "warn" | "info" | "debug") =>
    (message: string, ...args: unknown[]): void => {
      const now = Date.now();
      const seen = lastSeen.get(message);
      if (seen !== undefined && now - seen.at < DIAG_REPEAT_INTERVAL_MS) {
        seen.suppressed += 1;
        return;
      }
      if (seen === undefined && lastSeen.size >= DIAG_MAX_TRACKED) lastSeen.clear();
      lastSeen.set(message, { at: now, suppressed: 0 });
      logger[level]("OpenTelemetry diagnostic", {
        detail: message.slice(0, 300),
        ...(args.length > 0 ? { args: args.map((arg) => diagArgument(arg)) } : {}),
        ...(seen !== undefined && seen.suppressed > 0
          ? { suppressedSinceLast: seen.suppressed }
          : {}),
      });
    };
  return {
    error: write("error"),
    warn: write("warn"),
    info: write("info"),
    debug: write("debug"),
    verbose: write("debug"),
  };
}

/** Rejects after `ms`, so a hung export cannot hold the shutdown. */
async function withDeadline(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The message of a flush or shutdown failure (the SDK rejects with an array of errors). */
function failureText(error: unknown): string {
  return Array.isArray(error)
    ? error.map((item) => loggableError(item)).join("; ")
    : loggableError(error);
}

/**
 * Installs the SDK as the process-wide tracer provider, context manager
 * and propagator (#363). The resource is `service.name` (from
 * `OTEL_SERVICE_NAME`, default `bunmail`) and `service.version` (the
 * running BunMail version), over any `OTEL_RESOURCE_ATTRIBUTES`. Spans go
 * out in batches to `settings.endpoint`; the exporter reads its headers,
 * timeout, compression and certificates from the standard
 * `OTEL_EXPORTER_OTLP_*` variables itself. `exporter` replaces it with a
 * synchronous one (tests).
 */
export function installTracingSdk(
  settings: Extract<TracingSettings, { enabled: true }>,
  version: string,
  exporter?: SpanExporter,
): TracingSdk {
  diag.setLogger(diagLogger(), {
    logLevel: DiagLogLevel.WARN,
    suppressOverrideMessage: true,
  });

  const resource = defaultResource()
    .merge(detectResources({ detectors: [envDetector] }))
    .merge(
      resourceFromAttributes({
        "service.name": settings.serviceName,
        "service.version": version,
      }),
    );

  const processor =
    exporter === undefined
      ? new BatchSpanProcessor({
          exporter: new OTLPTraceExporter({ url: settings.endpoint }),
        })
      : new SimpleSpanProcessor({ exporter });

  const provider = new TracerProvider({
    resource,
    sampler: samplerFor(settings.sampler, settings.samplerRatio),
    spanLimits: { attributeValueLengthLimit: MAX_ATTRIBUTE_LENGTH },
    spanProcessors: [processor],
  });

  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);

  return {
    async stop(timeoutMs) {
      /** One budget for both steps, so the whole stop fits in `timeoutMs`. */
      const until = Date.now() + timeoutMs;
      try {
        await withDeadline(provider.forceFlush(), timeoutMs);
      } catch (error: unknown) {
        logger.warn("Tracing: buffered spans not exported on shutdown", {
          error: failureText(error),
        });
      }
      try {
        await withDeadline(provider.shutdown(), Math.max(until - Date.now(), 100));
      } catch (error: unknown) {
        logger.warn("Tracing: shutdown did not complete", { error: failureText(error) });
      }
      trace.disable();
      propagation.disable();
      context.disable();
      diag.disable();
    },
  };
}
