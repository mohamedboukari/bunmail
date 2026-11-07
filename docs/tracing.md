# Tracing (#363)

BunMail can export OpenTelemetry traces over OTLP/HTTP (protobuf): a span for each HTTP request, each queued send attempt and its MX deliveries, each webhook delivery and each SMTP connection. Logs stay the place for individual events ([logging.md](logging.md)) and metrics for rates and alerts ([metrics.md](metrics.md)); traces show where the time of one request or one send went, across the steps.

## Turning it on

Tracing is off by default. Point BunMail at an OTLP/HTTP endpoint (an OpenTelemetry Collector, Jaeger, Grafana Tempo, Honeycomb, ...) in `.env` and restart:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

- Unset (the default): nothing is traced and the OpenTelemetry SDK is never loaded; only the no-op `@opentelemetry/api` is, so a default install pays nothing. Log lines are unchanged.
- Set: the boot logs `Tracing enabled` with the endpoint's origin, and spans go out in batches. An endpoint that does not answer does not stop the app: export failures are logged at `error` as `OpenTelemetry diagnostic`, at most once a minute per message.
- On shutdown (`SIGINT`, `SIGTERM`), the spans still buffered are exported, waiting at most 5 seconds.

| Variable | Default | Meaning |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Base URL of the OTLP/HTTP receiver; spans go to `<url>/v1/traces`. Setting it turns tracing on |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset | Full traces URL, used as given; wins over the base URL. Setting it turns tracing on |
| `OTEL_TRACES_EXPORTER` | unset | `otlp` turns tracing on even without an endpoint (then `http://localhost:4318/v1/traces`); `none` turns it off |
| `OTEL_SDK_DISABLED` | `false` | `true` turns tracing off whatever else is set |
| `OTEL_SERVICE_NAME` | `bunmail` | The `service.name` of every span; name each instance when several report to one backend |
| `OTEL_TRACES_SAMPLER` | `parentbased_always_on` | `always_on`, `always_off`, `traceidratio`, `parentbased_always_on`, `parentbased_always_off` or `parentbased_traceidratio` |
| `OTEL_TRACES_SAMPLER_ARG` | `1` | The ratio of the `traceidratio` samplers, from 0 to 1 (`0.1` keeps one trace in ten) |
| `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | `http/protobuf` | Only `http/protobuf` is supported |
| `OTEL_EXPORTER_OTLP_HEADERS`, `_TIMEOUT`, `_COMPRESSION`, `_CERTIFICATE`, `_CLIENT_CERTIFICATE`, `_CLIENT_KEY` (and their `_TRACES_` forms) | unset | Read by the exporter as the OpenTelemetry spec describes, for example `OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=<key>` |
| `OTEL_RESOURCE_ATTRIBUTES` | unset | Extra resource attributes, for example `deployment.environment=production`; `service.name` and `service.version` come from the variables above and the running version |

Unset and blank mean unset. An endpoint that is not an `http://` or `https://` URL, another protocol (`grpc`, `http/json`), another exporter (`zipkin`, `console`), an unknown sampler, a ratio outside 0 to 1, or a service name with control characters or over 255 characters refuses to boot, so a typo cannot silently send traces nowhere. An error never echoes the endpoint: it can carry credentials. `OTEL_EXPORTER_OTLP_HEADERS` often holds a backend API key: BunMail never reads it into its configuration and never logs it.

Only the W3C trace context propagator is installed (`traceparent`, `tracestate`); `OTEL_PROPAGATORS` and the `OTEL_BSP_*` batch settings are not read.

## Example: a local Jaeger

```yaml
# docker-compose.override.yml
services:
  jaeger:
    image: jaegertracing/all-in-one:1.62.0
    ports:
      - "127.0.0.1:16686:16686" # the UI
  app:
    environment:
      OTEL_EXPORTER_OTLP_ENDPOINT: http://jaeger:4318
```

Open `http://localhost:16686` and pick the `bunmail` service. For a hosted backend, run an OpenTelemetry Collector next to BunMail and let it hold the backend's credentials, or set `OTEL_EXPORTER_OTLP_HEADERS` directly.

## Spans

Every attribute is chosen by hand at the call site from identifiers and counts. Nothing is auto-instrumented: under Bun there is nothing useful to instrument, and the Elysia OpenTelemetry plugin records every request header, cookie and body.

| Span | Kind | Parent | Attributes |
|---|---|---|---|
| `<METHOD> <area>` (`POST api/v1/emails`) | server | the incoming `traceparent` from a trusted proxy (below), else none | `http.request.method` (unknown methods as `_OTHER`), `url.path` (the request line's path: no query string, token-like segments as `:token`), `http.response.status_code`, `bunmail.request_id` (the `X-Request-Id`). A 5xx marks it as failed. `/health` and the favicons are not traced |
| `email.send_attempt` | internal | none: each attempt is its own trace | `bunmail.email.id`, `bunmail.email.attempt`, `bunmail.email.source` (`api` or `smtp`) |
| `mx.deliver` | internal | the send attempt (or whatever sent the mail: an inbound notification, an invitation) | `bunmail.mx.host_count`, `bunmail.mx.transaction_count`, `bunmail.mx.recipient_count`, `bunmail.mx.verified_tls` (MTA-STS enforce), then `server.address` (the MX host it ended on), `bunmail.mx.tls` (`starttls` or `plaintext`), `bunmail.mx.delivered`, `bunmail.mx.failed`, `bunmail.mx.deferred`. Any failed transaction marks it as failed |
| `mx.session` | client | `mx.deliver`, one per connection tried (failover shows as several) | `server.address`, `server.port`, `network.peer.address` (the MX's IP), `bunmail.mx.transaction_count`, `bunmail.mx.tls` and the outcome counts |
| `webhook.deliver` | client | none from the delivery worker | `http.request.method`, `url.scheme`, `server.address`, `server.port` (the URL's origin only), `bunmail.webhook.event`, `bunmail.webhook.delivery_id`, `bunmail.webhook.attempt`, `http.response.status_code`. A failed attempt marks it as failed |
| `smtp.session` | server | none: each connection is its own trace | `bunmail.smtp.listener` (`inbound` or `submission`), `bunmail.smtp.session_id` (the `smtpSessionId` of the logs), `bunmail.smtp.messages` |
| `smtp.message` | internal | `smtp.session` | `bunmail.smtp.listener`, `bunmail.smtp.recipient_count`, `bunmail.smtp.reply_code` (250, or the refusal's code). Only a `451` (a local failure) or an error without a code marks it as failed: other refusals are the client's |

A failed span's status message and exception event carry a sanitized message, never a stack: a database error reduced to its SQLSTATE, every email address masked (`a***@example.org`, whatever `LOG_REDACT_PII` says, since spans leave the server), every URL cut to its origin, at most 300 characters. Attribute values are capped at 1024 characters.

## Propagation

- **Incoming:** an HTTP request's `traceparent` (and `tracestate`) is honoured only when the request came through the trusted proxies: `DASHBOARD_TRUSTED_PROXY_HOPS` is at least 1 and the request carries at least that many `X-Forwarded-For` entries, the same test the login limiter applies before it trusts `X-Forwarded-For`. Otherwise the request starts a new trace, so a client on the internet cannot choose the trace its request joins or force it to be sampled. Like the limiter, this cannot tell a forged `X-Forwarded-For` from a real one when the app port is reachable directly: keep the port bound to the proxy (the default compose file publishes it on `127.0.0.1` only).
- **Outgoing:** each webhook delivery sends a `traceparent` header naming its `webhook.deliver` span, so a traced receiver continues the trace. With tracing off, no header is added.
- A queued email is sent later by the queue worker, in its own trace: the send attempt is not linked to the request that queued it.

## Logs

While a sampled span is active, every log line carries `traceId` and `spanId` next to the correlation IDs ([logging.md](logging.md)), so a line leads to its trace and a trace to its lines. With tracing off, lines carry neither.

## What spans never contain

Request or response headers (`Authorization`, cookies, `User-Agent`), query strings, request or message bodies, subjects, attachment names, email addresses, client IP addresses, API keys, webhook secrets or signatures, and webhook URL paths or queries. See [SECURITY.md](../SECURITY.md).

## Several replicas

Each replica exports its own spans; give them the same `OTEL_SERVICE_NAME` and tell them apart with `OTEL_RESOURCE_ATTRIBUTES=service.instance.id=<name>`.

## Module layout

```
src/utils/
├── tracing.ts       ← API only: startTracing / stopTracing, withSpan, the SMTP session spans, spanSafeMessage
└── tracing-sdk.ts   ← The SDK setup, loaded by a dynamic import only when tracing is on
```

The settings are read by `readTracingSettings` in `src/config/observability.ts` (`config.tracing`). Tracing starts in `src/index.ts` before the boot work and stops in the shutdown handler (`src/process-lifecycle.ts`). The spans are made in `src/middleware/request-context.ts` (HTTP), `processEmail` in the queue, the mailer (`mx.deliver`, `mx.session`), `performHttpAttempt` (webhooks, with the `traceparent` injection) and both SMTP listeners. Spans become active only through `startActiveSpan` and `context.with`, which use `AsyncLocalStorage.run`; never call `context.attach()`, which uses `enterWith` on Bun and segfaults inside Elysia hooks ([logging.md](logging.md)).

Dependencies: the OpenTelemetry JS 3.x minimal set (`@opentelemetry/api`, `sdk-trace`, `context-async-hooks`, `core`, `resources`, `exporter-trace-otlp-proto`), 11 packages from the OpenTelemetry project with no other dependencies and no install scripts.

Tests: `test/unit/tracing.test.ts` (the settings, nothing loaded while off, the request span's allowlist, `traceparent` trust, 5xx, log fields, webhook spans and the injected `traceparent`, SMTP session spans), `test/unit/mailer.service.test.ts` (the `mx.deliver` and `mx.session` spans) and `test/integration/tracing.integration.test.ts` (the send attempt and both SMTP listeners on a real database and real connections).
