import { Elysia, NotFoundError } from "elysia";
import { config } from "../../config.ts";
import {
  isAuthorizedScrape,
  renderMetrics,
  setBuildInfo,
} from "./services/metrics.service.ts";

/** The text exposition format Prometheus, the OTel Collector and the Datadog Agent read. */
const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/**
 * `GET /metrics` (#362): Prometheus metrics for scrapers that send
 * `Authorization: Bearer <METRICS_TOKEN>`. At the root like `/health`,
 * not under `/api/v1`: it is an operations endpoint, not part of the API.
 *
 * Without `METRICS_TOKEN` it throws `NotFoundError`, so `/metrics`
 * answers exactly like any unknown path and reveals nothing. A wrong or
 * missing token gets `401`; the request line logs it at `warn`.
 *
 * @param options.version - The running version, for `bunmail_build_info`
 * @param options.token   - The scrape token; `METRICS_TOKEN` by default (tests pass their own)
 */
export function metricsPlugin(options: { version: string; token?: string | null }) {
  setBuildInfo(options.version);
  const token = options.token === undefined ? config.metrics.token : options.token;
  return new Elysia({ name: "metrics" }).get(
    "/metrics",
    async ({ request }) => {
      if (token === null) throw new NotFoundError();
      if (!isAuthorizedScrape(request.headers.get("authorization"), token)) {
        return new Response("Unauthorized\n", {
          status: 401,
          headers: {
            "www-authenticate": 'Bearer realm="metrics"',
            "cache-control": "no-store",
          },
        });
      }
      return new Response(await renderMetrics(), {
        headers: { "content-type": CONTENT_TYPE, "cache-control": "no-store" },
      });
    },
    { detail: { hide: true } },
  );
}
