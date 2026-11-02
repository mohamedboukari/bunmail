import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { Elysia } from "elysia";
import { readTracingSettings, type TracingSettings } from "../../src/config.ts";
import {
  cameThroughTrustedProxies,
  createRequestContext,
} from "../../src/middleware/request-context.ts";
import { performHttpAttempt } from "../../src/modules/webhooks/services/webhook-delivery.service.ts";
import { logger } from "../../src/utils/logger.ts";
import type { ResolveAll } from "../../src/utils/ssrf-guard.ts";
import {
  isTracingActive,
  smtpSessionTracer,
  spanSafeMessage,
  startTracing,
  stopTracing,
  withSpan,
} from "../../src/utils/tracing.ts";

/**
 * OpenTelemetry tracing (#363). Tracing is off by default and costs
 * nothing then; when on, spans carry identifiers and counts only, never a
 * header, a cookie, a body or an address. Spans are read back from an
 * in-memory exporter installed through the real setup (`startTracing`),
 * no module mocks.
 */

/** Settings with tracing on; the endpoint is never contacted (the exporter is replaced). */
const ON: TracingSettings = {
  enabled: true,
  endpoint: "http://collector.invalid:4318/v1/traces",
  serviceName: "bunmail-test",
  sampler: "parentbased_always_on",
  samplerRatio: 1,
};

/** The raw tracing environment `readTracingSettings` reads. */
type TracingEnv = NonNullable<Parameters<typeof readTracingSettings>[0]>;

/** A blank tracing environment, overridden per test. */
const NO_ENV: TracingEnv = {
  sdkDisabled: undefined,
  exporter: undefined,
  endpoint: undefined,
  tracesEndpoint: undefined,
  protocol: undefined,
  tracesProtocol: undefined,
  serviceName: undefined,
  sampler: undefined,
  samplerArg: undefined,
};

/** An incoming W3C traceparent, sampled. */
const INCOMING_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const INCOMING_SPAN_ID = "b7ad6b7169203331";
const TRACEPARENT = `00-${INCOMING_TRACE_ID}-${INCOMING_SPAN_ID}-01`;

/** Everything a span would ship to a backend, apart from its resource, as one string. */
function shipped(spans: readonly ReadableSpan[]): string {
  return JSON.stringify(
    spans.map((s) => ({
      name: s.name,
      attributes: s.attributes,
      events: s.events,
      status: s.status,
      links: s.links,
    })),
  );
}

/** Silences the logger for the duration of a test. */
function quietLogger(): Array<{ mockRestore: () => void }> {
  return (["debug", "info", "warn", "error"] as const).map((level) =>
    spyOn(logger, level).mockImplementation(() => {}),
  );
}

describe("readTracingSettings", () => {
  test("off by default, and with OTEL_SDK_DISABLED or OTEL_TRACES_EXPORTER=none", () => {
    expect(readTracingSettings(NO_ENV)).toEqual({ enabled: false });
    expect(
      readTracingSettings({
        ...NO_ENV,
        endpoint: "http://collector:4318",
        sdkDisabled: "true",
      }),
    ).toEqual({ enabled: false });
    expect(
      readTracingSettings({
        ...NO_ENV,
        endpoint: "http://collector:4318",
        exporter: "none",
      }),
    ).toEqual({ enabled: false });
  });

  test("an endpoint turns it on; the traces URL follows the spec", () => {
    expect(readTracingSettings({ ...NO_ENV, endpoint: "http://collector:4318" })).toEqual(
      {
        enabled: true,
        endpoint: "http://collector:4318/v1/traces",
        serviceName: "bunmail",
        sampler: "parentbased_always_on",
        samplerRatio: 1,
      },
    );
    const traces = readTracingSettings({
      ...NO_ENV,
      endpoint: "http://ignored:4318",
      tracesEndpoint: "https://otlp.example.com/custom/path",
      serviceName: "mail-eu",
      sampler: "parentbased_traceidratio",
      samplerArg: "0.25",
    });
    expect(traces).toEqual({
      enabled: true,
      endpoint: "https://otlp.example.com/custom/path",
      serviceName: "mail-eu",
      sampler: "parentbased_traceidratio",
      samplerRatio: 0.25,
    });
    const local = readTracingSettings({ ...NO_ENV, exporter: "otlp" });
    expect(local.enabled && local.endpoint).toBe("http://localhost:4318/v1/traces");
  });

  test("obvious mistakes refuse to boot, without echoing an endpoint", () => {
    const refused: Array<Partial<typeof NO_ENV>> = [
      { sdkDisabled: "yes" },
      { exporter: "zipkin" },
      { endpoint: "collector:4318" },
      { tracesEndpoint: "ftp://user:secret-token@collector" },
      { protocol: "grpc" },
      { tracesProtocol: "http/json" },
      { sampler: "jaeger_remote" },
      { samplerArg: "1.5" },
      { samplerArg: "-0.1" },
      { serviceName: "bad\nname" },
      { serviceName: "x".repeat(256) },
    ];
    for (const env of refused) {
      expect(() => readTracingSettings({ ...NO_ENV, ...env })).toThrow("[config]");
    }
    expect(() =>
      readTracingSettings({
        ...NO_ENV,
        tracesEndpoint: "ftp://user:secret-token@collector",
      }),
    ).not.toThrow("secret-token");
  });
});

describe("tracing off (the default)", () => {
  test("the SDK is loaded only by a dynamic import, never statically", async () => {
    const transpiler = new Bun.Transpiler({ loader: "tsx" });
    const sdkPackages = /^@opentelemetry\/(?!api$)/;
    const src = join(import.meta.dir, "..", "..", "src");
    for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(src)) {
      const code = await Bun.file(join(src, file)).text();
      const imports = transpiler.scanImports(code);
      if (file === join("utils", "tracing-sdk.ts")) continue;
      for (const entry of imports) {
        /** Only the SDK module itself may import the SDK packages. */
        expect({ file, path: sdkPackages.test(entry.path) }).toEqual({
          file,
          path: false,
        });
        if (entry.path === "./tracing-sdk.ts") {
          expect({ file, kind: entry.kind }).toEqual({
            file: join("utils", "tracing.ts"),
            kind: "dynamic-import",
          });
        }
      }
    }
  });

  test("nothing starts, spans record nothing, log lines carry no trace fields", async () => {
    expect(await startTracing({ enabled: false }, "0.0.0")).toBe(false);
    expect(isTracingActive()).toBe(false);

    /** `error` lines: another file's `config` mock may leak `logLevel: "error"` (#293). */
    const console = spyOn(globalThis.console, "error").mockImplementation(() => {});
    try {
      await withSpan("off", {}, async (span) => {
        expect(span.isRecording()).toBe(false);
        expect(trace.getActiveSpan()).toBeUndefined();
        logger.error("inside a span while tracing is off", { n: 1 });
      });
      const line = String(console.mock.calls[0]?.[0] ?? "");
      expect(line).toContain("inside a span while tracing is off");
      expect(line).not.toContain("traceId");
      expect(line).not.toContain("spanId");
    } finally {
      console.mockRestore();
    }
  });

  test("the SMTP session tracer passes callbacks through untouched", () => {
    const sessions = smtpSessionTracer("inbound");
    sessions.open("s1");
    const callback = (): void => {};
    expect(sessions.message("s1", 1, callback)).toBe(callback);
    expect(sessions.run("s1", () => trace.getActiveSpan())).toBeUndefined();
    sessions.close("s1", 1);
  });
});

describe("tracing on", () => {
  const exporter = new InMemorySpanExporter();
  let spies: Array<{ mockRestore: () => void }> = [];

  beforeAll(async () => {
    const quiet = quietLogger();
    expect(await startTracing(ON, "9.9.9", exporter)).toBe(true);
    for (const spy of quiet) spy.mockRestore();
  });

  afterAll(async () => {
    await stopTracing();
    expect(isTracingActive()).toBe(false);
  });

  afterEach(() => {
    exporter.reset();
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  /** An app wrapped like `src/index.ts`, trusting `hops` proxies. */
  function appWith(hops: number): { handle: (request: Request) => Promise<Response> } {
    return new Elysia()
      .wrap(createRequestContext(hops))
      .post("/api/v1/emails/send", async ({ body }) => {
        await Bun.sleep(1);
        return { ok: true, echoed: typeof body };
      })
      .get("/api/v1/emails/:id", ({ params }) => ({ id: params.id }))
      .get("/fail", ({ set }) => {
        set.status = 503;
        return "unavailable";
      })
      .get("/boom", () => {
        throw new Error("kaboom for alice@example.com");
      })
      .get("/missing", ({ set }) => {
        set.status = 404;
        return "nope";
      })
      .get("/health", () => ({ status: "ok" }));
  }

  /** The one SERVER span exported, failing the test when there is not exactly one. */
  function serverSpan(): ReadableSpan {
    const spans = exporter.getFinishedSpans().filter((s) => s.kind === SpanKind.SERVER);
    expect(spans).toHaveLength(1);
    const [span] = spans;
    if (span === undefined) throw new Error("no server span");
    return span;
  }

  test("the resource names the service and the running version", async () => {
    spies = quietLogger();
    await withSpan("resource", {}, async () => {});
    const [span] = exporter.getFinishedSpans();
    expect(span?.resource.attributes["service.name"]).toBe("bunmail-test");
    expect(span?.resource.attributes["service.version"]).toBe("9.9.9");
  });

  test("a request's span has allowlisted attributes only: no header, cookie, query or body", async () => {
    spies = quietLogger();
    const response = await appWith(0).handle(
      new Request("http://localhost/api/v1/emails/send?token=query-secret-value", {
        method: "POST",
        headers: {
          authorization: "Bearer bm_live_secret_key_value",
          cookie: "bm_session=session-cookie-value",
          "content-type": "application/json",
          "x-request-id": "proxy-req-1",
          "user-agent": "agent-string-value",
        },
        body: JSON.stringify({ to: "alice@example.com", subject: "body-secret-subject" }),
      }),
    );
    expect(response.status).toBe(200);

    const span = serverSpan();
    expect(span.name).toBe("POST api/v1/emails");
    expect(Object.keys(span.attributes).toSorted()).toEqual([
      "bunmail.request_id",
      "http.request.method",
      "http.response.status_code",
      "url.path",
    ]);
    expect(span.attributes).toEqual({
      "http.request.method": "POST",
      "url.path": "/api/v1/emails/send",
      "bunmail.request_id": "proxy-req-1",
      "http.response.status_code": 200,
    });
    const all = shipped(exporter.getFinishedSpans());
    for (const secret of [
      "bm_live_secret_key_value",
      "session-cookie-value",
      "query-secret-value",
      "alice@example.com",
      "body-secret-subject",
      "agent-string-value",
      "authorization",
      "cookie",
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  test("the path is the request line's: token-like segments masked", async () => {
    spies = quietLogger();
    await appWith(0).handle(
      new Request(`http://localhost/api/v1/emails/${"a".repeat(40)}`),
    );
    expect(serverSpan().attributes["url.path"]).toBe("/api/v1/emails/:token");
  });

  test("health checks are not traced", async () => {
    spies = quietLogger();
    const response = await appWith(0).handle(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  test("a 5xx marks the span as failed; a 404 does not", async () => {
    spies = quietLogger();
    const app = appWith(0);
    await app.handle(new Request("http://localhost/fail"));
    expect(serverSpan().status.code).toBe(SpanStatusCode.ERROR);
    expect(serverSpan().attributes["http.response.status_code"]).toBe(503);
    exporter.reset();

    const boom = await app.handle(new Request("http://localhost/boom"));
    expect(boom.status).toBe(500);
    expect(serverSpan().status.code).toBe(SpanStatusCode.ERROR);
    expect(shipped(exporter.getFinishedSpans())).not.toContain("alice@example.com");
    exporter.reset();

    await app.handle(new Request("http://localhost/missing"));
    expect(serverSpan().status.code).toBe(SpanStatusCode.UNSET);
  });

  test("an incoming traceparent is ignored without a trusted proxy", async () => {
    spies = quietLogger();
    await appWith(0).handle(
      new Request("http://localhost/missing", {
        headers: { traceparent: TRACEPARENT, "x-forwarded-for": "203.0.113.7" },
      }),
    );
    const span = serverSpan();
    expect(span.spanContext().traceId).not.toBe(INCOMING_TRACE_ID);
    expect(span.parentSpanContext).toBeUndefined();
  });

  test("an incoming traceparent is continued when the request came through the trusted proxies", async () => {
    spies = quietLogger();
    await appWith(1).handle(
      new Request("http://localhost/missing", {
        headers: { traceparent: TRACEPARENT, "x-forwarded-for": "203.0.113.7" },
      }),
    );
    const span = serverSpan();
    expect(span.spanContext().traceId).toBe(INCOMING_TRACE_ID);
    expect(span.parentSpanContext?.spanId).toBe(INCOMING_SPAN_ID);
  });

  test("with fewer X-Forwarded-For entries than trusted hops, it is ignored", async () => {
    spies = quietLogger();
    const app = appWith(2);
    await app.handle(
      new Request("http://localhost/missing", {
        headers: { traceparent: TRACEPARENT, "x-forwarded-for": "203.0.113.7" },
      }),
    );
    expect(serverSpan().spanContext().traceId).not.toBe(INCOMING_TRACE_ID);
    exporter.reset();

    await app.handle(
      new Request("http://localhost/missing", { headers: { traceparent: TRACEPARENT } }),
    );
    expect(serverSpan().spanContext().traceId).not.toBe(INCOMING_TRACE_ID);
  });

  test("log lines carry traceId and spanId only while a span is active", async () => {
    /** `error` lines: another file's `config` mock may leak `logLevel: "error"` (#293). */
    const console = spyOn(globalThis.console, "error").mockImplementation(() => {});
    spies = [console];
    let traceId = "";
    let spanId = "";
    await withSpan("logging", {}, async (span) => {
      traceId = span.spanContext().traceId;
      spanId = span.spanContext().spanId;
      logger.error("inside a span");
    });
    logger.error("outside any span");
    const [inside, outside] = console.mock.calls.map((call) => String(call[0]));
    expect(inside).toContain(traceId);
    expect(inside).toContain(spanId);
    expect(outside).not.toContain("traceId");
  });

  test("withSpan records a thrown error with a sanitized message and rethrows it", async () => {
    spies = quietLogger();
    const failing = withSpan("failing", {}, async () => {
      throw new Error(
        "550 5.1.1 <bob@example.org>: rejected, see https://hooks.example.com/T0/B1/secret",
      );
    });
    const caught = await failing.then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(Error);
    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    const text = shipped(exporter.getFinishedSpans());
    expect(text).toContain("b***@example.org");
    expect(text).toContain("https://hooks.example.com");
    expect(text).not.toContain("bob@example.org");
    expect(text).not.toContain("/T0/B1/secret");
  });

  test("webhook delivery: a CLIENT span with the URL's origin only, and the traceparent sent", async () => {
    spies = quietLogger();
    const sent: Headers[] = [];
    const fetchImpl: typeof fetch = Object.assign(
      (_input: string | URL | Request, init?: BunFetchRequestInit) => {
        sent.push(new Headers(init?.headers));
        return Promise.resolve(new Response("ok", { status: 200 }));
      },
      { preconnect: fetch.preconnect },
    );
    const resolver: ResolveAll = () => Promise.resolve([{ address: "93.184.216.34" }]);

    await withSpan("email.send_attempt", { root: true }, async () => {
      const outcome = await performHttpAttempt({
        url: "https://hooks.example.com/services/T000/B000/xoxb-path-secret?q=query-secret",
        secret: "signing-secret",
        body: JSON.stringify({ to: "carol@example.com" }),
        event: "email.sent",
        deliveryId: "whd_1",
        attempt: 2,
        resolver,
        fetchImpl,
      });
      expect(outcome.ok).toBe(true);
    });

    const spans = exporter.getFinishedSpans();
    const client = spans.find((s) => s.name === "webhook.deliver");
    const root = spans.find((s) => s.name === "email.send_attempt");
    expect(client?.kind).toBe(SpanKind.CLIENT);
    expect(client?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    expect(client?.attributes).toEqual({
      "http.request.method": "POST",
      "bunmail.webhook.event": "email.sent",
      "url.scheme": "https",
      "server.address": "hooks.example.com",
      "bunmail.webhook.delivery_id": "whd_1",
      "bunmail.webhook.attempt": 2,
      "http.response.status_code": 200,
    });
    const text = shipped(spans);
    for (const secret of [
      "xoxb-path-secret",
      "query-secret",
      "signing-secret",
      "carol@",
    ]) {
      expect(text).not.toContain(secret);
    }

    /** The receiver gets the attempt span's context. */
    const traceparent = sent[0]?.get("traceparent") ?? "";
    expect(traceparent).toBe(
      `00-${client?.spanContext().traceId}-${client?.spanContext().spanId}-01`,
    );
  });

  test("webhook delivery: a failed attempt marks the span as failed", async () => {
    spies = quietLogger();
    const fetchImpl: typeof fetch = Object.assign(
      () => Promise.resolve(new Response("no", { status: 502 })),
      { preconnect: fetch.preconnect },
    );
    await performHttpAttempt({
      url: "https://hooks.example.com/x",
      secret: "s",
      body: "{}",
      event: "email.sent",
      resolver: () => Promise.resolve([{ address: "93.184.216.34" }]),
      fetchImpl,
    });
    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["http.response.status_code"]).toBe(502);
  });

  test("SMTP: one session span per connection, a child per message, counts and reply codes only", () => {
    spies = quietLogger();
    const sessions = smtpSessionTracer("submission");
    sessions.open("sess1");
    let replied: unknown = "not yet";
    const reply = sessions.message("sess1", 3, (error?: Error) => {
      replied = error;
    });
    const inside = sessions.run(
      "sess1",
      () => trace.getActiveSpan()?.spanContext().spanId,
    );
    reply(
      Object.assign(new Error("Daily quota for dave@example.com reached"), {
        responseCode: 452,
      }),
    );
    expect(replied).toBeInstanceOf(Error);

    const temporary = sessions.message("sess1", 1, (_error?: Error) => {});
    temporary(Object.assign(new Error("Local error"), { responseCode: 451 }));
    sessions.message("sess1", 1, () => {})();
    sessions.close("sess1", 3);

    const spans = exporter.getFinishedSpans();
    const session = spans.find((s) => s.name === "smtp.session");
    const messages = spans.filter((s) => s.name === "smtp.message");
    expect(session?.kind).toBe(SpanKind.SERVER);
    expect(session?.parentSpanContext).toBeUndefined();
    expect(session?.attributes).toEqual({
      "bunmail.smtp.listener": "submission",
      "bunmail.smtp.session_id": "sess1",
      "bunmail.smtp.messages": 3,
    });
    expect(messages.map((m) => m.attributes["bunmail.smtp.reply_code"])).toEqual([
      452, 451, 250,
    ]);
    expect(messages.map((m) => m.status.code)).toEqual([
      SpanStatusCode.UNSET,
      SpanStatusCode.ERROR,
      SpanStatusCode.UNSET,
    ]);
    for (const message of messages) {
      expect(message.parentSpanContext?.spanId).toBe(session?.spanContext().spanId);
    }
    /** While a message is open, handlers run under its span. */
    expect(inside).toBe(messages[0]?.spanContext().spanId);
    expect(shipped(spans)).not.toContain("dave@");
  });
});

describe("cameThroughTrustedProxies", () => {
  test("needs at least as many X-Forwarded-For entries as trusted hops", () => {
    expect(cameThroughTrustedProxies("203.0.113.7", 0)).toBe(false);
    expect(cameThroughTrustedProxies(null, 1)).toBe(false);
    expect(cameThroughTrustedProxies("", 1)).toBe(false);
    expect(cameThroughTrustedProxies("203.0.113.7", 1)).toBe(true);
    expect(cameThroughTrustedProxies("203.0.113.7, 10.0.0.2", 2)).toBe(true);
    expect(cameThroughTrustedProxies("203.0.113.7", 2)).toBe(false);
  });
});

describe("spanSafeMessage", () => {
  test("masks addresses whatever LOG_REDACT_PII says, cuts URLs to their origin, caps the length", () => {
    expect(spanSafeMessage(new Error("to erin@example.org failed"))).toBe(
      "to e***@example.org failed",
    );
    expect(spanSafeMessage("see https://example.com/a/b?c=d now")).toBe(
      "see https://example.com now",
    );
    expect(spanSafeMessage(new Error("x".repeat(1000)))).toHaveLength(300);
  });
});
