/**
 * Scheduled DNS re-verification of domains (#250).
 *
 * Verify used to run only on demand, so a domain whose records were
 * removed or changed after verification stayed "verified" for good. This
 * worker wakes every few minutes (jittered, so replicas do not wake in
 * lockstep), claims the domains whose `next_check_at` has passed, and runs
 * the same checks and state machine as Verify on each
 * (`runDnsChecks` + `applyDomainCheck`): a passing domain is checked again
 * one interval later (`DOMAIN_REVERIFY_INTERVAL_HOURS`, plus or minus an
 * hour), a failing or inconclusive one after an hour. See
 * `domain-check-state.ts` for when a domain flips to failing.
 *
 * The loop only reads DNS and writes the domain row and the webhook
 * outbox: it never sends mail.
 *
 * Several replicas are safe: the claim is one `UPDATE ... WHERE id IN
 * (SELECT ... FOR UPDATE SKIP LOCKED)` that pushes `next_check_at` forward
 * by a lease before any check runs, so two claims never return the same
 * domain, and a replica that dies mid-check releases its domains when the
 * lease ends.
 */
import { sql } from "drizzle-orm";
import { db, type DbExecutor } from "../../../db/index.ts";
import { config } from "../../../config.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { runWithLogContext } from "../../../utils/log-context.ts";
import { domains } from "../models/domain.schema.ts";
import type { Domain } from "../types/domain.types.ts";
import { applyDomainCheck } from "./domain-check.service.ts";
import { runDnsChecks, type VerificationDeps } from "./dns-verification.service.ts";

/** How often the worker wakes to look for due domains, before jitter. */
const WAKE_INTERVAL_MS = 5 * 60 * 1000;

/** Domains claimed per batch. */
const CLAIM_BATCH_SIZE = 50;

/** Batches per run at most: a run checks at most 500 domains, the next run goes on. */
const MAX_BATCHES_PER_RUN = 10;

/** Domains checked at once. */
export const REVERIFY_CONCURRENCY = 8;

/**
 * How long a claimed domain stays invisible to other claims. Far longer
 * than a check (a few lookups, 10 s at most for SPF), short enough that a
 * crashed replica's domains are checked again soon.
 */
const CLAIM_LEASE_MINUTES = 15;

/** What one run did, logged once as its outcome line. */
export interface ReverifyRunSummary {
  /** Domains checked (claimed and stored). */
  checked: number;
  /** Every check passed. */
  passed: number;
  /** At least one check failed definitively. */
  failed: number;
  /** No failure, at least one lookup errored. */
  unknown: number;
  /** Verified domains that flipped to failing (`domain.verification_failed`). */
  flipped: number;
  /** Domains that became verified (`domain.verified`). */
  recovered: number;
  /** Domains whose check or store threw; they are retried once the lease ends. */
  errors: number;
  durationMs: number;
}

/** Test seams: the DNS lookups and the clock. */
export interface ReverifyDeps {
  verification?: VerificationDeps;
  now?: () => Date;
}

/**
 * Claims up to `limit` due domains (`next_check_at` unset or past, oldest
 * first, never-checked first) and pushes their `next_check_at` forward by
 * the lease, in one statement. Concurrent claims return disjoint domains:
 * a row another claim has locked is skipped, not waited for. `executor`
 * lets tests hold a claim open in a transaction.
 */
export async function claimDueDomains(
  limit: number,
  executor: DbExecutor = db,
): Promise<Domain[]> {
  return executor
    .update(domains)
    .set({
      nextCheckAt: sql`NOW() + interval ${sql.raw(`'${CLAIM_LEASE_MINUTES} minutes'`)}`,
    })
    .where(
      sql`${domains.id} IN (
        SELECT ${domains.id} FROM ${domains}
        WHERE ${domains.nextCheckAt} IS NULL OR ${domains.nextCheckAt} <= NOW()
        ORDER BY ${domains.nextCheckAt} ASC NULLS FIRST, ${domains.id}
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )`,
    )
    .returning();
}

/** Checks one claimed domain and stores the result; counts it into `summary`. */
async function checkClaimed(
  domain: Domain,
  deps: ReverifyDeps,
  summary: ReverifyRunSummary,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  try {
    const checks = await runDnsChecks(domain, deps.verification, {
      source: "scheduled",
      now,
    });
    const applied = await applyDomainCheck(domain.id, checks, now);
    /** Deleted during the lookups: nothing to count. */
    if (!applied) return;
    summary.checked++;
    const { outcome, event } = applied.transition;
    if (outcome === "pass") summary.passed++;
    else if (outcome === "fail") summary.failed++;
    else summary.unknown++;
    if (event === "failed") summary.flipped++;
    if (event === "verified") summary.recovered++;
    logger.debug("Domain re-verified", {
      domainId: domain.id,
      outcome,
      spf: checks.spf.status,
      dkim: checks.dkim.status,
      dmarc: checks.dmarc.status,
      consecutiveFailures: applied.domain.consecutiveFailures,
    });
  } catch (error: unknown) {
    summary.errors++;
    /** By name only: a drizzle error's message embeds its query parameters. */
    logger.error("Domain re-verification failed", {
      domainId: domain.id,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

/** Checks `batch` with at most {@link REVERIFY_CONCURRENCY} domains at once. */
async function checkBatch(
  batch: readonly Domain[],
  deps: ReverifyDeps,
  summary: ReverifyRunSummary,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < batch.length) {
      const domain = batch[next++];
      if (domain) await checkClaimed(domain, deps, summary);
    }
  }
  const workers = Math.max(1, Math.min(REVERIFY_CONCURRENCY, batch.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

/**
 * One run: claims due domains in batches and checks them, until none is
 * due or {@link MAX_BATCHES_PER_RUN} batches are done. Runs in its own log
 * context (`job: "domain-reverify"`, a fresh `jobId`) and logs one outcome
 * line. Does nothing while `DOMAIN_REVERIFY_ENABLED=false`. Never rejects.
 */
export function runReverifyCycle(deps: ReverifyDeps = {}): Promise<ReverifyRunSummary> {
  return runWithLogContext(
    { job: "domain-reverify", jobId: generateId("drv") },
    async () => {
      const startedAt = Date.now();
      const summary: ReverifyRunSummary = {
        checked: 0,
        passed: 0,
        failed: 0,
        unknown: 0,
        flipped: 0,
        recovered: 0,
        errors: 0,
        durationMs: 0,
      };
      if (!config.domainReverify.enabled) return summary;

      try {
        for (let batchNo = 0; batchNo < MAX_BATCHES_PER_RUN; batchNo++) {
          const batch = await claimDueDomains(CLAIM_BATCH_SIZE);
          if (batch.length === 0) break;
          await checkBatch(batch, deps, summary);
          if (batch.length < CLAIM_BATCH_SIZE) break;
        }
      } catch (error: unknown) {
        summary.errors++;
        logger.error("Domain re-verification claim failed", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }

      summary.durationMs = Date.now() - startedAt;
      if (summary.checked > 0 || summary.errors > 0) {
        logger.info("Domain re-verification run completed", { ...summary });
      } else {
        logger.debug("Domain re-verification run: nothing due", {
          durationMs: summary.durationMs,
        });
      }
      return summary;
    },
  );
}

/** True between `start()` and `stop()`. */
let running = false;
/** True while a run is in progress; it schedules the next one when it ends. */
let inRun = false;
/** The next scheduled run, or null while a run is in progress or once stopped. */
let timer: ReturnType<typeof setTimeout> | null = null;

/** `ms` plus or minus 20%, so replicas do not wake in lockstep. */
function withJitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

/** Schedules the next run, unless the worker was stopped. */
function scheduleRun(): void {
  if (!running) return;
  timer = setTimeout(() => {
    timer = null;
    inRun = true;
    void runReverifyCycle().finally(() => {
      inRun = false;
      scheduleRun();
    });
  }, withJitter(WAKE_INTERVAL_MS));
}

/**
 * Starts the worker: the first run comes a few minutes after boot, then
 * one run every few minutes, each scheduled when the previous one ends (no
 * overlap). Idempotent. Does nothing while `DOMAIN_REVERIFY_ENABLED=false`.
 */
export function start(): void {
  if (running) return;
  if (!config.domainReverify.enabled) {
    logger.info("Domain DNS re-verification disabled (DOMAIN_REVERIFY_ENABLED=false)");
    return;
  }
  running = true;
  logger.info("Starting domain DNS re-verification", {
    intervalHours: config.domainReverify.intervalHours,
    wakeIntervalMs: WAKE_INTERVAL_MS,
    concurrency: REVERIFY_CONCURRENCY,
  });
  if (!inRun) scheduleRun();
}

/** Stops the worker. Called from the SIGINT/SIGTERM shutdown path. */
export function stop(): void {
  if (!running) return;
  running = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  logger.info("Domain DNS re-verification stopped");
}

/** Whether the worker is running (tests). */
export function isRunning(): boolean {
  return running;
}
