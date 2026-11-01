# Metrics (#362)

BunMail serves Prometheus metrics at `GET /metrics`, in the text exposition format (`text/plain; version=0.0.4`). Prometheus scrapes it directly; the OpenTelemetry Collector (`prometheus` receiver) and the Datadog Agent (OpenMetrics check) read the same endpoint, so one setup covers every common stack. Logs stay the place for individual events ([logging.md](logging.md)); metrics are for rates, trends and alerts.

## Turning it on

The endpoint is off by default. Set a scrape token in `.env` and restart:

```bash
METRICS_TOKEN=$(openssl rand -hex 32)   # 32 to 256 of [A-Za-z0-9_-], 8+ distinct
```

- Unset or empty: `/metrics` answers like any unknown path (`404`), revealing nothing.
- Set: a scraper must send `Authorization: Bearer <METRICS_TOKEN>`. A missing or wrong token gets `401` with `WWW-Authenticate: Bearer realm="metrics"`, and the request line is logged at `warn`. The comparison is constant-time.
- Anything else (too short, other characters, fewer than 8 distinct characters) refuses to boot, so a weak token cannot slip through: the endpoint has no rate limit.

The token is not an API key: it cannot send mail or read messages. The metrics still describe your traffic, so keep it secret and send it only over TLS or a private network. To keep the endpoint off the internet entirely, block `/metrics` at the reverse proxy and scrape the app's port from the host or a private network (see [SECURITY.md](../SECURITY.md)).

```bash
curl -s -H "Authorization: Bearer $METRICS_TOKEN" https://mail.example.com/metrics | head
```

## Scrape configs

**Prometheus**

```yaml
scrape_configs:
  - job_name: bunmail
    scheme: https
    scrape_interval: 30s
    authorization:
      credentials_file: /etc/prometheus/bunmail-token   # the METRICS_TOKEN value
    static_configs:
      - targets: ["mail.example.com"]
```

**OpenTelemetry Collector** (then export OTLP anywhere: Grafana Cloud, Honeycomb, Elastic, ...)

```yaml
receivers:
  prometheus:
    config:
      scrape_configs:
        - job_name: bunmail
          scheme: https
          scrape_interval: 30s
          authorization:
            credentials: ${env:BUNMAIL_METRICS_TOKEN}
          static_configs:
            - targets: ["mail.example.com"]
```

**Datadog Agent** (`conf.d/openmetrics.d/conf.yaml`)

```yaml
instances:
  - openmetrics_endpoint: https://mail.example.com/metrics
    namespace: bunmail
    metrics: [".*"]
    headers:
      Authorization: "Bearer <METRICS_TOKEN>"
```

## Metrics

No label carries an email address, a domain, an API key or a raw path, so the number of series stays small and nothing personal leaves the server.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `bunmail_build_info` | gauge | `version`, `bun` | Always 1; the running BunMail and Bun versions |
| `process_start_time_seconds`, `process_resident_memory_bytes`, `process_cpu_seconds_total` | gauge | | The usual process metrics |
| `bunmail_metrics_db_up` | gauge | | 1 when the last queue snapshot read the database, 0 when it failed (the queue gauges are then absent) |
| `bunmail_emails` | gauge | `status` (`queued`, `sending`) | Live emails not yet final; `queued` includes scheduled retries, trashed rows are excluded |
| `bunmail_emails_due` | gauge | | Queued emails whose next attempt is due now |
| `bunmail_queue_oldest_due_age_seconds` | gauge | | How long the most overdue queued email has been due. Near 0 on a healthy queue, however old its scheduled retries are |
| `bunmail_emails_finished_total` | counter | `status` (`sent`, `bounced`, `failed`), `source` (`api`, `smtp`) | Emails that reached a final status, counted once when the outcome is stored |
| `bunmail_email_send_attempt_duration_seconds` | histogram | | One send attempt (every MX group of one email), claim to stored outcome |
| `bunmail_mx_deliveries_total` | counter | `tls` (`starttls`, `plaintext`) | Recipient MX groups delivered, by transport security |
| `bunmail_http_requests_total` | counter | `area`, `method`, `code_class` (`2xx` to `5xx`) | HTTP requests |
| `bunmail_http_request_duration_seconds` | histogram | `area` | HTTP request duration |

`area` is a fixed set: `api/v1/<resource>` for each REST module (`emails`, `domains`, `webhooks`, ...), `api/v1/other`, `api/docs`, `dashboard`, `unsubscribe`, `health`, `metrics` and `other` (anything else, scanners included).

The queue gauges come from one database query per scrape (only `queued` and `sending` rows, the set the queue claims from), cached 15 seconds so several scrapers share it; a read slower than 5 seconds counts as failed (`bunmail_metrics_db_up 0`), so a hung database cannot hang the scrape. Counters and histograms live in the process and start from zero after a restart; Prometheus's `rate()` and `increase()` handle that.

**Several replicas** (#185): scrape each replica. Counters and histograms are per replica and add up with `sum()`; the queue gauges read the same database on every replica, so take `max()` of them, not `sum()`.

## Example alerts

```yaml
groups:
  - name: bunmail
    rules:
      - alert: BunMailQueueStuck
        expr: max(bunmail_queue_oldest_due_age_seconds) > 300
        for: 10m
        annotations: { summary: "Emails have been due for over 5 minutes and are not going out" }
      - alert: BunMailDatabaseUnreachable
        expr: max(bunmail_metrics_db_up) == 0
        for: 5m
      - alert: BunMailFailureRateHigh
        expr: |
          sum(rate(bunmail_emails_finished_total{status!="sent"}[1h]))
            / sum(rate(bunmail_emails_finished_total[1h])) > 0.05
        for: 30m
        annotations: { summary: "Over 5% of emails bounced or failed in the last hour" }
      - alert: BunMailServerErrors
        expr: sum(rate(bunmail_http_requests_total{code_class="5xx"}[5m])) > 0.1
        for: 10m
```

## Module layout

```
src/modules/metrics/
├── metrics.plugin.ts          ← GET /metrics and its METRICS_TOKEN bearer guard (404 when unset)
└── services/
    ├── registry.ts            ← counter, histogram, gauge collected on scrape, text format rendering
    ├── metrics.service.ts     ← BunMail's metrics, the `area` label, the scrape-token check
    └── db-gauges.service.ts   ← readQueueSnapshot(): the queue gauges' one query
```

No tables and no DTOs. The plugin is mounted in `src/index.ts` next to `/health`, not under `/api/v1`. The counters are fed from where the events already happen: the request-context wrapper (HTTP), `processEmail` and `recordSendOutcome` in the queue (attempts and final statuses), and the mailer (MX deliveries). The registry is hand-written (no dependency) and checks every metric and label name when it is defined.

Tests: `test/unit/metrics-registry.test.ts` (the text format), `test/unit/metrics-service.test.ts` (`area`, the token check, `METRICS_TOKEN`), `test/e2e/metrics-api.test.ts` (the guard and the response) and `test/integration/metrics.integration.test.ts` (the queue snapshot on a real database).
