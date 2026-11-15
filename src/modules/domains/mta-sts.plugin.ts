import { Elysia } from "elysia";
import { logger } from "../../utils/logger.ts";
import { sqlStateOf } from "../../utils/db-error.ts";
import { servedMtaStsMode } from "./services/mta-sts-hosts.service.ts";
import {
  mtaStsDomainFromHost,
  servedMtaStsPolicy,
  type MtaStsPolicySettings,
} from "./services/mta-sts-served-policy.ts";
import type { ServedMtaStsMode } from "./types/domain.types.ts";

/**
 * Inbound MTA-STS (#472, RFC 8461): `GET /.well-known/mta-sts.txt` answers
 * the policy of the domain the request's `Host` names, as
 * `mta-sts.<domain>`, when that domain is verified and an admin set its
 * mode to `testing` or `enforce`.
 *
 * - `200`, `Content-Type: text/plain`, `Cache-Control: max-age=` the
 *   policy's `max_age` capped at an hour, the policy text
 *   (`servedMtaStsPolicy`).
 * - `404` with one fixed body for everything else: no `Host`, a host that
 *   is not `mta-sts.<name>`, an unknown domain, an unverified one, mode
 *   `none`. The answers cannot be told apart, so the route says nothing
 *   about which domains exist beyond the policies it serves.
 * - `503` when the served set cannot be read (the database is down and
 *   was never read before), never a `404` that would look final.
 *
 * No auth and no cookie: senders fetch it anonymously. The lookup is a
 * map read (`mta-sts-hosts.service.ts`), never a query per request. TLS
 * for `mta-sts.<domain>` is the reverse proxy's job (docs/self-hosting.md);
 * the proxy must pass the original `Host`.
 */

/**
 * Longest an HTTP cache (a CDN, the proxy) may keep the policy, in
 * seconds. Senders cache it for its own `max_age` (RFC 8461) regardless;
 * this only bounds how long a stale copy can be served after a change.
 */
const HTTP_CACHE_MAX_SECONDS = 3600;

/** Headers on every answer of this route. */
const COMMON_HEADERS: Record<string, string> = {
  "content-type": "text/plain; charset=utf-8",
  "x-robots-tag": "noindex",
};

/** The one answer for every request that gets no policy. */
function notFound(): Response {
  return new Response("Not found\n", {
    status: 404,
    headers: { ...COMMON_HEADERS, "cache-control": "no-store" },
  });
}

/** The served set could not be read: retry later. */
function unavailable(): Response {
  return new Response("Service unavailable\n", {
    status: 503,
    headers: { ...COMMON_HEADERS, "cache-control": "no-store", "retry-after": "30" },
  });
}

/** Options of {@link mtaStsPlugin}; the defaults suit production. */
export interface MtaStsPluginOptions {
  /** The mode a domain's policy is served under; a test can pass its own. */
  lookup?: (domainName: string) => Promise<ServedMtaStsMode | null>;
  /** The policy settings; `config.mtaSts` by default. */
  settings?: MtaStsPolicySettings;
}

/** Builds the plugin; `src/app.ts` mounts one. */
export function mtaStsPlugin(options: MtaStsPluginOptions = {}) {
  const lookup = options.lookup ?? servedMtaStsMode;
  return new Elysia({ name: "mta-sts" }).get(
    "/.well-known/mta-sts.txt",
    async ({ request }) => {
      const domain = mtaStsDomainFromHost(request.headers.get("host"));
      if (domain === null) return notFound();
      let mode: ServedMtaStsMode | null;
      try {
        mode = await lookup(domain);
      } catch (error) {
        logger.error("MTA-STS policy not served: served domains unavailable", {
          errorName: error instanceof Error ? error.name : typeof error,
          sqlState: sqlStateOf(error),
        });
        return unavailable();
      }
      if (mode === null) {
        /** Scanners ask for this path on any host: `debug` only. */
        logger.debug("MTA-STS policy request for a domain without one");
        return notFound();
      }
      const policy = servedMtaStsPolicy(mode, options.settings);
      logger.debug("MTA-STS policy served", { domain, mode, id: policy.id });
      return new Response(policy.text, {
        status: 200,
        headers: {
          ...COMMON_HEADERS,
          "cache-control": `max-age=${Math.min(policy.maxAge, HTTP_CACHE_MAX_SECONDS)}`,
        },
      });
    },
    { detail: { hide: true } },
  );
}
