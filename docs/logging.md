# Logging and post-mortems

BunMail's logs are built so that, after an incident, one search reconstructs what happened to a request, a queued email, an SMTP connection or a webhook delivery (#284). This page covers the format, the IDs, what is and is not logged, and how to trace an incident.

## Format

- **Production** (`BUNMAIL_ENV=production`): one JSON object per line, for log aggregators (Grafana Loki, Datadog, `jq`):

  ```json
  {"level":"info","message":"HTTP request","timestamp":"2026-10-18T12:00:00.000Z","requestId":"req_3f9c...","method":"POST","path":"/api/v1/emails/send","status":201,"durationMs":42}
  ```

- **Development**: a colored line with the same fields as JSON at the end.
- **Levels**: `LOG_LEVEL` = `debug`, `info` (default), `warn` or `error`. `debug` adds internal detail (each send attempt's duration, DKIM signing, batch sizes) and is meant to be switched on while investigating.

## Correlation IDs

Every line written while handling a piece of work carries that work's ID, automatically, down to the deepest service call. Nothing has to pass the ID around: it travels with the code through every `await` (`AsyncLocalStorage`, `src/utils/log-context.ts`).

| Work | Fields on every line | Where it starts |
|---|---|---|
| HTTP request | `requestId` | each request (`src/middleware/request-context.ts`) |
| Queued email, one send attempt | `job: "email-send"`, `jobId` (the `msg_` email id) | `processEmail` in the queue |
| SMTP connection (inbound or submission) | `smtpSessionId`, `listener: "inbound" \| "submission"` | each `smtp-server` handler |
| Webhook delivery | `job: "webhook-delivery"`, `jobId` (the delivery id) | the delivery worker |
| Purge cycle (trash, tombstones, expired sessions) | `job: "purge"` | the purge worker |

Contexts nest: a webhook fired while sending an email logs with the email's `jobId`.

### X-Request-Id

- Every HTTP response carries `X-Request-Id`. Ask users to quote it in bug reports: it finds every line of that request.
- An incoming `X-Request-Id` (set by your reverse proxy or load balancer) is **reused** when it is 1 to 64 characters of `[A-Za-z0-9._-]`, so the proxy's logs and BunMail's share one ID. Anything else is replaced with a fresh `req_<32 hex>` ID.

## One line per unit of work

| Line | Level | Fields |
|---|---|---|
| `HTTP request` | `error` for 5xx, `warn` for 401/403/429, `debug` for a healthy `/health` or favicon, `info` otherwise | `method`, `path`, `status`, `durationMs` |
| `Processing email`, then `Email reached terminal state` / `Email send had retry groups, requeued` / `Email permanently failed (input error)` | `info` / `warn` / `error` | email id, statuses, SMTP results |
| `Email send attempt finished` | `debug` | `emailId`, `attempt`, `durationMs` |
| `SMTP session closed` | `info` | `remoteAddress`, `messages`, `durationMs` |

The `path` of the request line never contains the query string (owner setup links carry their token there), and any path segment that looks like a credential (32 or more URL-safe characters) is shown as `:token`.

## What is never logged

- **Secrets, by rule and by safety net.** Call sites never pass passwords, API keys, tokens, token hashes or private keys. On top of that, the logger itself replaces the value of any field whose name ends in `password`, `passwd`, `secret`, `token`, `tokenHash`, `secretHash`, `privateKey`, `authorization`, `cookie`, `setCookie` or `apiKey` (any case, `_` and `-` ignored, at any depth) with `[REDACTED]`. Identifiers stay readable: `apiKeyId`, `sessionId`, `tokenCount` are not secrets.
- **Request and message bodies.** Validation errors log the failing field paths only, never the submitted values.
- **Recipient addresses in clear** when `LOG_REDACT_PII=true` (the production default): `a***@example.com`.
- **The one documented exception:** the owner setup link (#215), logged once per minted link so the operator can claim the account. It is single use and expires after 24 hours.
- Drizzle query errors on the account paths are logged with the Postgres SQLSTATE only, never with the query parameters.

## Tracing an incident

```bash
# All lines of one request (from a user's X-Request-Id or an HTTP request line)
docker compose logs app | grep 'req_3f9c'

# Everything that happened to one email, across retries
docker compose logs app | grep 'msg_123'

# Every request that failed in the last hour, with its ID (JSON logs + jq)
docker compose logs --since 1h app | grep '"HTTP request"' | jq -c 'select(.status >= 500) | {requestId, path, status}'

# One SMTP connection: find its id in the close summary, then all its lines
docker compose logs app | grep '"SMTP session closed"'
docker compose logs app | grep '<smtpSessionId>'
```

Turn on `LOG_LEVEL=debug` (restart the app) to see internal detail while reproducing a problem, then set it back: debug output is large.

## Retention

`docker-compose.yml` rotates container logs with the `json-file` driver: at most 5 files of 10 MB per container (about 50 MB), oldest lines dropped. For longer history, ship the JSON lines to a log store (Loki, Datadog, CloudWatch) and keep them there.

## Rules for new code

Every new route, background job and service entry point follows these rules (also in `CLAUDE.md`):

1. **Boundary line**: the outcome of each unit of work is logged once, with its IDs and a duration where it matters. HTTP requests get theirs automatically.
2. **Background work runs in a context**: wrap a new job, worker iteration or connection handler in `runWithLogContext({ job, jobId })` so every line inside carries its ID.
3. **Every failure path logs** at `warn` (expected, handled) or `error` (unexpected), with the IDs involved and the error code or message, never the raw error object of a database query.
4. **Detail at `debug`**: internal steps useful while investigating, not in normal operation.
5. **No secrets, no bodies**: never log passwords, keys, tokens, hashes, cookies or message content; route emails through `redactEmail`. The redaction safety net is not a license to pass them.
