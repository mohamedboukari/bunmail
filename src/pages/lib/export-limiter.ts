import { sharedWindowCounter } from "../../utils/shared-store.ts";

/**
 * Limits of the dashboard CSV exports (#430): a per-user budget and a
 * per-process concurrency cap.
 *
 * **Budget.** An export reads up to `exportLimits.rowCap` rows of
 * personal data, so even an admin gets at most
 * `EXPORT_MAX_PER_WINDOW` of them per `EXPORT_WINDOW_MS`: enough for any
 * real use, and a stolen admin session cannot pull the whole database in
 * a loop. Keyed by user id (the actor), whatever table is exported.
 *
 * A fixed window from the first export, in the shared store (#185): Redis
 * when `REDIS_URL` is set, so every replica counts against one budget per
 * user; else process memory. Every key expires with its window.
 */

/** Most exports per user in one window. */
export const EXPORT_MAX_PER_WINDOW = 10;

/** Window length: 10 minutes. */
export const EXPORT_WINDOW_MS = 10 * 60 * 1000;

/** Exports per user id. */
const exportCounter = sharedWindowCounter("rl:csv-export");

/**
 * The in-memory counts, keyed by user id: the whole state without Redis.
 * Exported for tests; the routes go through the function below.
 */
export const exportBudgetMap = exportCounter.local.entries;

/** Outcome of one export request against the budget. */
export type ExportBudgetDecision =
  { limited: false } | { limited: true; retryAfterSec: number };

/**
 * Counts one export for `userId`; `limited` (with the seconds until the
 * window ends) when it is over the budget and must be refused.
 */
export async function takeExportBudget(userId: string): Promise<ExportBudgetDecision> {
  const decision = await exportCounter.take([userId], {
    max: EXPORT_MAX_PER_WINDOW,
    windowMs: EXPORT_WINDOW_MS,
  });
  if (!decision.limited) return { limited: false };
  return {
    limited: true,
    retryAfterSec: Math.max(1, Math.ceil(decision.retryAfterMs / 1000)),
  };
}

/* ─── Concurrency ─── */

/**
 * Most exports producing at once in this process. Bun 1.3.14 drains a
 * streamed response body as fast as `pull` produces it, whatever the
 * client reads, so a stalled client still makes the server build (and
 * buffer) the whole file: the row cap bounds one export's memory, and
 * this cap bounds how many are held at once. Per process on purpose: the
 * memory it protects is this process's.
 */
export const EXPORT_MAX_CONCURRENT = 2;

/** `Retry-After` of a refusal for lack of a free slot, in seconds. */
export const EXPORT_BUSY_RETRY_AFTER_SEC = 30;

/** Exports producing right now in this process. */
let activeExports = 0;

/**
 * Takes one export slot: a release function (idempotent: a second call is
 * a no-op), or `null` when `EXPORT_MAX_CONCURRENT` exports are already
 * producing. The caller releases when the stream ends, fails or is
 * cancelled, and on every path that answers without streaming.
 */
export function acquireExportSlot(): (() => void) | null {
  if (activeExports >= EXPORT_MAX_CONCURRENT) return null;
  activeExports += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeExports -= 1;
  };
}

/** Exports producing right now. Exported for tests. */
export function activeExportCount(): number {
  return activeExports;
}

/**
 * Forgets every slot. For tests only: a test that never reads an export's
 * body (the route-access table) would otherwise hold slots for the next
 * test files of the same process.
 */
export function resetExportSlots(): void {
  activeExports = 0;
}
