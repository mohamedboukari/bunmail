import { context, propagation, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { signPayload } from "./webhook-dispatch.service.ts";
import { logger } from "../../../utils/logger.ts";
import { spanSafeMessage, withSpan } from "../../../utils/tracing.ts";
import {
  buildPinnedRequest,
  resolvePublicWebhookTarget,
  type PinnedRequest,
  type PublicWebhookTarget,
  type ResolveAll,
} from "../../../utils/ssrf-guard.ts";
import { config } from "../../../config.ts";

/** Per-attempt HTTP timeout. Receivers SHOULD respond within seconds;
 *  slower than 10s is treated as a failure. */
const ATTEMPT_TIMEOUT_MS = 10_000;

/** Cap on stored body / error preview to avoid unbounded JSONB growth.
 *  Real consumer 5xx bodies are usually a few hundred bytes; 2KB is
 *  well over typical and still cheap to store. */
export const RESPONSE_PREVIEW_LIMIT = 2048;

/**
 * Most bytes of a response body ever read. Reading stops (and the stream
 * is cancelled) once this much has arrived: enough for the 2 KB preview
 * even with multi-byte characters. The receiver is untrusted, so reading
 * the whole body would let it fill the worker's memory.
 */
const RESPONSE_READ_LIMIT_BYTES = 8 * 1024;

/**
 * Builds the stored preview from at most `RESPONSE_READ_LIMIT_BYTES` of the
 * body, then cancels the stream. The response must have been fetched with
 * `decompress: false`: Bun inflates a compressed body in native code
 * whatever JavaScript reads (a 0.5 MB gzip response cost about 1 GB of
 * memory in testing), so the body is never decompressed at all. A body
 * the receiver encoded anyway is not shown: decoding even a slice of it
 * would mean running a decompressor on attacker input.
 */
async function readBodyPreview(response: Response): Promise<string | null> {
  if (!response.body) return null;

  const encoding = (response.headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (encoding !== "" && encoding !== "identity") {
    await response.body.cancel().catch(() => undefined);
    const label = encoding.replace(/[^a-z0-9, -]/g, "").slice(0, 40);
    return `[${label}-encoded response body not shown]`;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < RESPONSE_READ_LIMIT_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      /** Keep only what is still needed: a single chunk can be large. */
      const needed = value.subarray(0, RESPONSE_READ_LIMIT_BYTES - total);
      chunks.push(needed);
      total += needed.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return (
    new TextDecoder()
      .decode(Buffer.concat(chunks))
      /** Postgres jsonb rejects NUL, and the preview is stored as jsonb. */
      .replaceAll("\u0000", "")
      .slice(0, RESPONSE_PREVIEW_LIMIT)
      .toWellFormed()
  );
}

export interface AttemptOutcome {
  ok: boolean;
  status: number | null;
  error: string | null;
  bodyPreview: string | null;
}

/**
 * Performs one HTTP POST attempt against the webhook URL. Pure-ish:
 * the side effect is the network call; the return value is enough for
 * the caller to update the delivery row.
 *
 * Re-signs per attempt: that's the whole point of separating the
 * stored body from the signature. A row sitting in `pending` for 6
 * hours, when finally retried, ships a fresh timestamp the consumer's
 * 5-min freshness window will accept.
 *
 * The request goes to the address the SSRF guard validated, not to the
 * host name (see {@link buildPinnedRequest}).
 */
export async function performHttpAttempt(opts: {
  url: string;
  /** `null` when the stored secret could not be decrypted (#259): fails without sending. */
  secret: string | null;
  body: string;
  event: string;
  /** The delivery row and the number of this attempt, for its trace span (#363). */
  deliveryId?: string;
  attempt?: number;
  fetchImpl?: typeof fetch;
  /** DNS lookup for the SSRF guard; defaults to the system resolver. */
  resolver?: ResolveAll;
  timeoutMs?: number;
}): Promise<AttemptOutcome> {
  /**
   * One CLIENT span per attempt (#363). The URL as its origin only (scheme,
   * host, port): Slack, Discord and others put the credential in the path.
   * Never the body, the signature or the response.
   */
  let origin: URL | null = null;
  try {
    origin = new URL(opts.url);
  } catch {
    /** Refused below by the SSRF guard; the span carries no URL. */
  }
  return withSpan(
    "webhook.deliver",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.request.method": "POST",
        "bunmail.webhook.event": opts.event,
        ...(origin === null
          ? {}
          : {
              "url.scheme": origin.protocol.replace(/:$/, ""),
              "server.address": origin.hostname,
              ...(origin.port === "" ? {} : { "server.port": Number(origin.port) }),
            }),
        ...(opts.deliveryId === undefined
          ? {}
          : { "bunmail.webhook.delivery_id": opts.deliveryId }),
        ...(opts.attempt === undefined
          ? {}
          : { "bunmail.webhook.attempt": opts.attempt }),
      },
    },
    async (span) => {
      const outcome = await attemptDelivery(opts);
      if (outcome.status !== null) {
        span.setAttribute("http.response.status_code", outcome.status);
      }
      if (!outcome.ok) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: spanSafeMessage(outcome.error ?? "Webhook delivery failed"),
        });
      }
      return outcome;
    },
  );
}

/** {@link performHttpAttempt} without its span. */
async function attemptDelivery(opts: {
  url: string;
  secret: string | null;
  body: string;
  event: string;
  fetchImpl?: typeof fetch;
  resolver?: ResolveAll;
  timeoutMs?: number;
}): Promise<AttemptOutcome> {
  if (opts.secret === null) {
    return {
      ok: false,
      status: null,
      error: "Signing secret could not be decrypted with DKIM_ENCRYPTION_KEY",
      bodyPreview: null,
    };
  }
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  const sigTimestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signPayload(sigTimestamp, opts.body, opts.secret);

  /**
   * SSRF re-validation at delivery time (#128). The URL was checked at
   * create, but DNS can change and rows created before this guard existed
   * were never checked, so resolve and validate on every attempt. The host
   * is resolved exactly once here: the request below connects to the
   * address validated now, so a different later answer is never used.
   * A blocked URL, or one that cannot be pinned to the validated address,
   * is a failed attempt, not a fetch.
   */
  let target: PublicWebhookTarget;
  let pinned: PinnedRequest;
  try {
    target = await resolvePublicWebhookTarget(
      opts.url,
      config.webhookDelivery.allowInsecureHttp,
      opts.resolver,
    );
    pinned = buildPinnedRequest(target);
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
      bodyPreview: null,
    };
  }
  logger.debug("Webhook attempt pinned to validated address", {
    family: target.family,
  });

  const headers: Record<string, string> = {
    /** The receiver sees the configured host, not the address. */
    Host: pinned.host,
    "Content-Type": "application/json",
    "X-BunMail-Signature": signature,
    "X-BunMail-Timestamp": sigTimestamp,
    "X-BunMail-Event": opts.event,
    /** Ask for an uncompressed reply, so honest receivers' previews
     *  can be shown (see readBodyPreview). */
    "Accept-Encoding": "identity",
  };
  /**
   * W3C `traceparent` of the attempt's span (#363), so a traced receiver
   * continues the trace. Adds nothing while tracing is off.
   */
  propagation.inject(context.active(), headers);

  try {
    const response = await fetchFn(pinned.url, {
      method: "POST",
      headers,
      body: opts.body,
      /** SNI and certificate check against the host name (https only). */
      tls: pinned.tls,
      /**
       * A fresh connection per attempt: a pooled connection to the same
       * address could have been opened, and its certificate checked, for
       * a different host name.
       */
      keepalive: false,
      /** Never inflate the untrusted body (Bun-specific option). */
      decompress: false,
      /**
       * Never follow redirects (#128): a 3xx `Location` into an internal
       * address (169.254.169.254, 127.0.0.1, …) would bypass the pre-fetch
       * host check. A redirect is treated as a non-2xx delivery failure.
       */
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS),
    });

    let bodyPreview: string | null = null;
    try {
      bodyPreview = await readBodyPreview(response);
    } catch {
      /** Body read can fail (already-consumed, network reset). Not
       *  fatal: the status code is the load-bearing signal. */
    }

    return {
      ok: response.ok,
      status: response.status,
      error: response.ok ? null : `HTTP ${response.status}`,
      bodyPreview,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
      bodyPreview: null,
    };
  }
}
