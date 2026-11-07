/**
 * Starts the long-running services once the HTTP server listens (#387,
 * split from `src/index.ts`): the email queue, the two SMTP listeners when
 * enabled, the trash purge, the webhook delivery worker, the domain
 * re-verification, the DNSBL self-check and the periodic memory sweeps.
 * `registerShutdownHandlers` (`src/process-lifecycle.ts`) stops them.
 */
import { config } from "./config.ts";
import { logger } from "./utils/logger.ts";
import * as queueService from "./modules/emails/services/queue.service.ts";
import * as smtpReceiver from "./modules/inbound/services/smtp-receiver.service.ts";
import * as smtpSubmission from "./modules/smtp-submission/services/smtp-submission.service.ts";
import * as trashPurge from "./modules/trash/services/purge.service.ts";
import * as webhookDeliveryWorker from "./modules/webhooks/services/webhook-delivery-worker.service.ts";
import * as domainReverify from "./modules/domains/services/domain-reverify.service.ts";
import * as sendingIpDnsbl from "./modules/domains/services/sending-ip-dnsbl.service.ts";
import { startRateLimitCleanup } from "./middleware/rate-limit.ts";
import { startLoginRateLimitCleanup } from "./middleware/login-rate-limit.ts";
import { startLocalCounterSweep } from "./utils/shared-store.ts";

export function startBackgroundServices(): void {
  /**
   * Start the email queue processor.
   * It polls the DB every 2 seconds for queued emails and sends them.
   */
  queueService.start().catch((error: unknown) => {
    logger.error("Failed to start email queue processor", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  /**
   * Start the inbound SMTP server (if enabled).
   *
   * Inbound is opt-in (`SMTP_ENABLED=true`). When it's off we log an
   * explicit info line so the silent-fail mode ("I set up MX records
   * but nothing arrives") is one `grep` away from a diagnosis instead
   * of a head-scratch. (#93)
   */
  if (config.smtp.enabled) {
    smtpReceiver.start();
  } else {
    logger.info(
      "Inbound SMTP receiver disabled: set SMTP_ENABLED=true (and publish the SMTP port in docker-compose.override.yml, see docker-compose.override.example.yml) to enable",
    );
  }

  /**
   * Start the SMTP submission server (#120) if enabled. This is the
   * AUTH-required endpoint that lets SMTP-capable apps (Infisical, Netbird,
   * Dify, a Nodemailer backend, …) send *through* BunMail. Opt-in and
   * separate from the inbound receiver above, see docs/smtp-submission.md.
   */
  if (config.smtpSubmission.enabled) {
    smtpSubmission.start();
  } else {
    logger.info(
      "SMTP submission server disabled: set SMTP_SUBMISSION_ENABLED=true (and publish the submission port in docker-compose.override.yml, see docker-compose.override.example.yml) to let apps send via SMTP",
    );
  }

  /**
   * Start the trash purge: periodically removes soft-deleted emails
   * older than TRASH_RETENTION_DAYS.
   */
  trashPurge.start();

  /**
   * Start the webhook delivery worker: drains the persisted
   * `webhook_deliveries` queue, retries on a schedule of 1m / 5m / 15m /
   * 1h / 6h, and prunes delivered rows older than the retention cutoff.
   */
  webhookDeliveryWorker.start();

  /**
   * Start the scheduled DNS re-verification of domains (#250): every few
   * minutes, checks the domains due (daily by default) and flips one whose
   * records keep failing. Off with DOMAIN_REVERIFY_ENABLED=false.
   */
  domainReverify.start();

  /**
   * Start the DNSBL self-check of the sending IPs (#250): about a minute
   * after boot, then daily, against Spamhaus ZEN, Barracuda and SpamCop.
   * Information only, shown on the dashboard home. Off with
   * SENDING_IP_DNSBL_CHECK=false.
   */
  sendingIpDnsbl.start();

  /**
   * Start the periodic sweep that drops expired entries from the HTTP
   * rate-limit map (prevents unbounded growth under many distinct keys).
   */
  startRateLimitCleanup();

  /**
   * Start the periodic sweep for the dashboard login brute-force limiter
   * (#109): prunes expired per-IP failed-attempt entries so a long-lived
   * server doesn't accumulate them unbounded under attacker IP rotation.
   */
  startLoginRateLimitCleanup();

  /**
   * Start the periodic sweep of every shared-store counter's memory side
   * (#185): the SMTP connection and AUTH throttles, the DNS-verify throttle
   * and the `last_used_at` claims. Their keys (client IPs, domain ids, API
   * key ids) would otherwise stay in memory after their window ends.
   */
  startLocalCounterSweep();
}
