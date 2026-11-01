import { createHash, timingSafeEqual } from "crypto";
import { logger } from "../../../utils/logger.ts";
import { loggableError } from "../../../utils/db-error.ts";
import {
  collectedCounter,
  counter,
  createRegistry,
  gauge,
  histogram,
} from "./registry.ts";
import { readDbSnapshot, type DbSnapshot } from "./db-gauges.service.ts";

/**
 * BunMail's Prometheus metrics (#362), served by `GET /metrics`
 * (`metrics.plugin.ts`). Counters and histograms live in this process
 * and reset on restart (one series per replica, summed by Prometheus);
 * the queue gauges are read from the database at scrape time.
 *
 * No label carries a domain, a recipient, an API key or a raw path, so
 * the number of series stays small and nothing personal is exposed.
 */

const registry = createRegistry();

/* ─── Build and process ─── */

let buildVersion = "unknown";

/** Records the running version for `bunmail_build_info` (set once at mount). */
export function setBuildInfo(version: string): void {
  buildVersion = version;
}

gauge(
  registry,
  "bunmail_build_info",
  "Always 1; the labels carry the running BunMail and Bun versions.",
  ["version", "bun"],
  () => [{ labels: { version: buildVersion, bun: Bun.version }, value: 1 }],
);

/** Process start, in seconds since the epoch. */
const startTimeSeconds = Date.now() / 1000 - process.uptime();

gauge(
  registry,
  "process_start_time_seconds",
  "Start time of the process since the Unix epoch, in seconds.",
  [],
  () => [{ labels: {}, value: startTimeSeconds }],
);
gauge(
  registry,
  "process_resident_memory_bytes",
  "Resident memory size, in bytes.",
  [],
  () => [{ labels: {}, value: process.memoryUsage().rss }],
);
collectedCounter(
  registry,
  "process_cpu_seconds_total",
  "Total user and system CPU time spent, in seconds.",
  [],
  () => {
    const usage = process.cpuUsage();
    return [{ labels: {}, value: (usage.user + usage.system) / 1e6 }];
  },
);

/* ─── Database gauges (cached) ─── */

/** How long one database read serves scrapes: several scrapers share it. */
const SNAPSHOT_TTL_MS = 15_000;

/** A read slower than this counts as failed, so a hung database cannot hang the scrape. */
const SNAPSHOT_TIMEOUT_MS = 5_000;

let snapshot: { at: number; value: DbSnapshot | null } | null = null;
let pending: Promise<DbSnapshot | null> | null = null;

/** `readDbSnapshot`, rejected after {@link SNAPSHOT_TIMEOUT_MS}. */
function readWithTimeout(): Promise<DbSnapshot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`database snapshot took over ${SNAPSHOT_TIMEOUT_MS} ms`));
    }, SNAPSHOT_TIMEOUT_MS);
  });
  return Promise.race([readDbSnapshot(), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * The database gauges, from the cache or one shared read; `null` when the
 * read failed. The dashboard's System health card reads the same snapshot,
 * so the page and a scrape never disagree.
 */
export async function dbSnapshot(now = Date.now()): Promise<DbSnapshot | null> {
  if (snapshot !== null && now - snapshot.at < SNAPSHOT_TTL_MS) return snapshot.value;
  pending ??= readWithTimeout()
    .catch((error: unknown) => {
      logger.warn("Metrics: database snapshot failed", { error: loggableError(error) });
      return null;
    })
    .then((value) => {
      snapshot = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

gauge(
  registry,
  "bunmail_metrics_db_up",
  "1 when the last database snapshot worked, 0 when it failed (the database gauges are then absent).",
  [],
  async () => [{ labels: {}, value: (await dbSnapshot()) === null ? 0 : 1 }],
);
gauge(
  registry,
  "bunmail_emails",
  "Live emails not yet final, by status (queued includes scheduled retries; trashed rows excluded).",
  ["status"],
  async () => {
    const queue = (await dbSnapshot())?.queue;
    if (queue === undefined) return [];
    return [
      { labels: { status: "queued" }, value: queue.queued },
      { labels: { status: "sending" }, value: queue.sending },
    ];
  },
);
gauge(
  registry,
  "bunmail_emails_due",
  "Queued emails whose next attempt is due now: what the queue should be sending.",
  [],
  async () => {
    const queue = (await dbSnapshot())?.queue;
    return queue === undefined ? [] : [{ labels: {}, value: queue.due }];
  },
);
gauge(
  registry,
  "bunmail_queue_oldest_due_age_seconds",
  "Seconds the most overdue queued email has been due; near 0 on a healthy queue.",
  [],
  async () => {
    const queue = (await dbSnapshot())?.queue;
    return queue === undefined ? [] : [{ labels: {}, value: queue.oldestDueAgeSeconds }];
  },
);
gauge(
  registry,
  "bunmail_webhook_deliveries_pending",
  "Webhook deliveries still to make, including scheduled retries.",
  [],
  async () => {
    const webhooks = (await dbSnapshot())?.webhooks;
    return webhooks === undefined ? [] : [{ labels: {}, value: webhooks.pending }];
  },
);
gauge(
  registry,
  "bunmail_webhook_deliveries_due",
  "Pending webhook deliveries due now: what the worker should be delivering.",
  [],
  async () => {
    const webhooks = (await dbSnapshot())?.webhooks;
    return webhooks === undefined ? [] : [{ labels: {}, value: webhooks.due }];
  },
);
gauge(
  registry,
  "bunmail_suppressions",
  "Active suppressions (not expired), by reason (bounce, complaint, manual, unsubscribe, other).",
  ["reason"],
  async () => {
    const counts = (await dbSnapshot())?.suppressions;
    return (counts ?? []).map(({ reason, count }) => ({
      labels: { reason },
      value: count,
    }));
  },
);

/* ─── Sending ─── */

/** Emails that reached a final status (counted once, when the outcome is stored). */
export const emailsFinished = counter(
  registry,
  "bunmail_emails_finished_total",
  "Emails that reached a final status, by status (sent, bounced, failed) and source (api, smtp).",
  ["status", "source"],
);

/** One send attempt, from claim to stored outcome. */
export const sendAttemptDuration = histogram(
  registry,
  "bunmail_email_send_attempt_duration_seconds",
  "Duration of one send attempt (every MX group of one email), in seconds.",
  [],
  [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
);

/** MX groups delivered, by whether the session was encrypted. */
export const mxDeliveries = counter(
  registry,
  "bunmail_mx_deliveries_total",
  "Recipient MX groups delivered, by transport security (starttls, plaintext).",
  ["tls"],
);

/* ─── SMTP listeners ─── */

/** The two SMTP listeners. */
export type SmtpListener = "inbound" | "submission";

/**
 * Why a listener refused a connection or a command: a fixed set, so the
 * label stays bounded. `temporary` is a `451` the client should retry.
 */
export type SmtpRejection =
  | "rate_limited"
  | "dnsbl"
  | "auth_rate_limited"
  | "auth_failed"
  | "auth_required"
  | "sender_invalid"
  | "sender_not_allowed"
  | "recipient_invalid"
  | "recipient_unknown"
  | "domain_unknown"
  | "too_many_recipients"
  | "too_large"
  | "quota"
  | "suppressed"
  | "rejected"
  | "temporary";

const smtpConnections = counter(
  registry,
  "bunmail_smtp_connections_total",
  "SMTP connections accepted by a listener (inbound on port 25, submission), before any check.",
  ["listener"],
);
const smtpRejections = counter(
  registry,
  "bunmail_smtp_rejections_total",
  "SMTP connections or commands a listener refused, by reason.",
  ["listener", "reason"],
);
const smtpMessagesAccepted = counter(
  registry,
  "bunmail_smtp_messages_accepted_total",
  "Messages a listener accepted (inbound: stored; submission: queued for sending).",
  ["listener"],
);

/** Counts a connection a listener accepted. */
export function recordSmtpConnection(listener: SmtpListener): void {
  smtpConnections.inc({ listener });
}

/** Counts a connection or command a listener refused. */
export function recordSmtpRejection(listener: SmtpListener, reason: SmtpRejection): void {
  smtpRejections.inc({ listener, reason });
}

/** Counts a message a listener accepted. */
export function recordSmtpMessageAccepted(listener: SmtpListener): void {
  smtpMessagesAccepted.inc({ listener });
}

/** Inbound DNSBL checks that did not run (#365), every one, unlike the throttled warning. */
const dnsblUnchecked = counter(
  registry,
  "bunmail_inbound_dnsbl_unchecked_total",
  "Inbound connections let through without a DNSBL answer, by why (lookup_failed, refused, unexpected).",
  ["kind"],
);

/** Counts an inbound connection allowed without a DNSBL answer. */
export function recordDnsblUnchecked(
  kind: "lookup_failed" | "refused" | "unexpected",
): void {
  dnsblUnchecked.inc({ kind });
}

/* ─── Webhooks ─── */

const webhookAttempts = counter(
  registry,
  "bunmail_webhook_attempts_total",
  "Webhook delivery attempts, by outcome (delivered; retry, a failure that will be retried; failed, the last attempt failed).",
  ["outcome"],
);

/** Counts one stored webhook attempt. */
export function recordWebhookAttempt(outcome: "delivered" | "retry" | "failed"): void {
  webhookAttempts.inc({ outcome });
}

/* ─── HTTP ─── */

const httpRequests = counter(
  registry,
  "bunmail_http_requests_total",
  "HTTP requests, by area, method and status class.",
  ["area", "method", "code_class"],
);
const httpDuration = histogram(
  registry,
  "bunmail_http_request_duration_seconds",
  "HTTP request duration, by area, in seconds.",
  ["area"],
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
);

/** The REST resources under `/api/v1/` (each module's prefix). */
const API_RESOURCES = new Set([
  "api-keys",
  "dmarc-reports",
  "domains",
  "emails",
  "inbound",
  "smtp-submission",
  "suppressions",
  "templates",
  "webhooks",
]);

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/**
 * The `area` label of a request: a fixed set of values, never the raw
 * path, which carries IDs and would let any scanner create new series.
 */
export function httpArea(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "");
  const [first, second, third] = segments;
  if (first === "api" && second === "v1") {
    return third !== undefined && API_RESOURCES.has(third)
      ? `api/v1/${third}`
      : "api/v1/other";
  }
  if (first === "api" && second === "docs") return "api/docs";
  if (first === "dashboard") return "dashboard";
  if (first === "u") return "unsubscribe";
  if (first === "health" && second === undefined) return "health";
  if (first === "metrics" && second === undefined) return "metrics";
  return "other";
}

/** Counts one finished request (called from the request-context wrapper). */
export function recordHttpRequest(
  method: string,
  path: string,
  status: number,
  durationSeconds: number,
): void {
  const area = httpArea(path);
  httpRequests.inc({
    area,
    method: METHODS.has(method) ? method : "other",
    code_class: `${Math.min(Math.max(Math.floor(status / 100), 1), 5)}xx`,
  });
  httpDuration.observe({ area }, durationSeconds);
}

/* ─── Scrape ─── */

/** The whole scrape, in the text exposition format. */
export function renderMetrics(): Promise<string> {
  return registry.render();
}

/** SHA-256 of a token, so the comparison below never depends on its length. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Whether an `Authorization` header carries the scrape token, compared in
 * constant time (both sides hashed first, so lengths leak nothing).
 */
export function isAuthorizedScrape(header: string | null, token: string): boolean {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  const presented = match?.[1];
  if (presented === undefined) return false;
  return timingSafeEqual(digest(presented), digest(token));
}
