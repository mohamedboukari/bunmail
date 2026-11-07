import { startApp } from "./app.ts";
import { config } from "./config.ts";
import { logger } from "./utils/logger.ts";
import { registerCrashHandlers, registerShutdownHandlers } from "./process-lifecycle.ts";
import { startBackgroundServices } from "./background-services.ts";
import { encryptDomainKeys } from "./db/encrypt-domain-keys.ts";
import { encryptWebhookSecrets } from "./db/encrypt-webhook-secrets.ts";
import { logReverseDnsAtBoot } from "./modules/domains/services/sending-ips.service.ts";
import {
  checkDomainKeysDecrypt,
  readAppVersion,
  runOwnerBootstrap,
  warnIgnoredSettings,
} from "./boot.ts";
import { useSharedBackend } from "./utils/shared-store.ts";
import { connectRedisBackend } from "./utils/redis-store.ts";
import { startTracing } from "./utils/tracing.ts";

registerCrashHandlers();

const appVersion = await readAppVersion();

/**
 * OpenTelemetry tracing (#363), before the boot work and the listeners.
 * Off unless an OTLP endpoint is configured; off, the SDK is never loaded.
 */
await startTracing(config.tracing, appVersion);

/**
 * Encrypt any DKIM private keys still stored as plaintext PEM (legacy
 * rows from before #23). Idempotent: already-encrypted rows are
 * skipped. Runs before the queue starts so the first send after a
 * restart can never read a plaintext row.
 */
await encryptDomainKeys();

await checkDomainKeysDecrypt();

/** Same for webhook signing secrets from before #259, before the webhook worker starts. */
await encryptWebhookSecrets();

/**
 * Shared state for several replicas (#185): with `REDIS_URL`, rate limits
 * (API, SMTP connections and AUTH, DNS verify), login throttles, the
 * `last_used_at` write claims, the outbound MX session slots and rate
 * buckets (#391) and one-time reveals live in Redis,
 * installed before the server takes a request. A Redis that does not answer at boot refuses the
 * start, like an unreachable database (Docker restarts and retries); a
 * later outage degrades instead (see `src/utils/shared-store.ts`).
 */
if (config.redis.url) {
  useSharedBackend(
    await connectRedisBackend(config.redis.url, { secretKey: config.dkimEncryptionKey }),
  );
}

await runOwnerBootstrap();

warnIgnoredSettings();

const app = startApp(appVersion);

logger.info("BunMail server started", {
  version: appVersion,
  bun: Bun.version,
  env: config.env,
  port: config.server.port,
  host: config.server.host,
});

/** Forward-confirmed reverse DNS of the sending IPs (#248): reported, never fatal. */
void logReverseDnsAtBoot();

startBackgroundServices();

registerShutdownHandlers(app);

/** Export the app type for Elysia's type-safe client (Eden) */
export type App = typeof app;
