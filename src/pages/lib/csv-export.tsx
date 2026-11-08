import type { Context } from "elysia";
import { logger } from "../../utils/logger.ts";
import { getLogContext, runWithLogContext } from "../../utils/log-context.ts";
import { loggableError } from "../../utils/db-error.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";
import type {
  AuditContext,
  AuditOutcome,
} from "../../modules/audit/types/audit.types.ts";
import type {
  ExportBatch,
  ExportCursor,
  ExportSource,
} from "../../modules/exports/types/export.types.ts";
import type { DashboardAuth } from "../../modules/users/types/user.types.ts";
import { ExportLimitedPage } from "../routes/export-limited.tsx";
import { ForbiddenPage } from "../routes/forbidden.tsx";
import { dashboardAudit } from "./audit.ts";
import { CSV_BOM, csvRow } from "./csv.ts";
import {
  acquireExportSlot,
  EXPORT_BUSY_RETRY_AFTER_SEC,
  takeExportBudget,
} from "./export-limiter.ts";

/**
 * Streams one dashboard table as a CSV download (#430).
 *
 * The export routes (`plugins/exports.plugin.tsx`) are thin: each parses
 * its page's filters, builds the table's `ExportSource` and hands it here.
 * This file then:
 *
 * 1. refuses a request another site started (`Sec-Fetch-Site:
 *    cross-site` or `same-site`) with 403, before anything is counted, so
 *    a malicious page can neither burn an admin's budget nor fill the
 *    audit log; a request without the header (an old browser, curl) is
 *    let through, the session cookie being `SameSite` anyway;
 * 2. takes one of the process's export slots (`EXPORT_MAX_CONCURRENT`),
 *    then one unit of the user's budget (`export-limiter.ts`): without a
 *    slot or over the budget, a 429 page with `Retry-After`, logged at
 *    `warn` and audited as a refused export;
 * 3. reads the first batch before answering, so a database that is down
 *    gets a 503 page rather than a 200 with a broken file;
 * 4. answers with a streamed body (`ReadableStream`): the BOM and the
 *    header row, then one chunk per batch. Batches are read in turn, one
 *    per `pull`, but Bun 1.3.14 drains a response body as fast as `pull`
 *    produces, whatever the client reads: a slow or stalled client still
 *    makes the server build and buffer the whole file. What bounds memory
 *    is therefore the row cap (one export) and the slot count (how many
 *    at once), not the client's pace;
 * 5. stops at `exportLimits.rowCap` rows. The headers are long gone by
 *    then, so the cap is announced in the file itself: one last row whose
 *    first cell says the export was truncated (the other cells empty);
 * 6. when the stream ends (finished, failed or cancelled), releases the
 *    slot, writes one log line (table, rows, duration, user) and records
 *    `export.downloaded`, before the last byte is queued. `rows` and the
 *    outcome describe what the server produced, not what the client
 *    received: with Bun buffering the body, a finished export may still
 *    be in flight, or never fully read, when it is recorded.
 */

/**
 * Batch size and row cap. A plain object rather than constants so the
 * integration tests can lower them (more rows than one batch, the cap)
 * with a handful of rows; nothing else writes them.
 */
export const exportLimits: { batchSize: number; rowCap: number } = {
  /** Rows per database round trip. */
  batchSize: 500,
  /**
   * Most rows one export writes; past it the file ends with the
   * truncation row. With Bun buffering the response, this is what bounds
   * one export's memory.
   */
  rowCap: 50_000,
};

/** The first cell of the last row of a truncated export. */
export function truncationNote(rowCap: number): string {
  return `Truncated: this export stops at ${rowCap} rows. Narrow the page filters to export the rest.`;
}

/** `bunmail-<table>-<UTC date>.csv`. */
export function exportFilename(table: string, now: Date = new Date()): string {
  return `bunmail-${table}-${now.toISOString().slice(0, 10)}.csv`;
}

/** What `csvExportResponse` needs from the route. */
export interface CsvExportRequest {
  /** The table, bound to the page's filters. */
  source: ExportSource;
  /** Names of the filters the export follows, for the audit event (never their values). */
  filters: readonly string[];
  /** The signed-in admin. */
  auth: DashboardAuth;
  request: Request;
  server: Context["server"];
  set: Context["set"];
}

/** How an export ended, for the log line and the audit outcome. */
type ExportEnd = "finished" | "failed" | "cancelled";

/** `Sec-Fetch-Site` values that mean another site started the request. */
const FOREIGN_FETCH_SITES = new Set(["cross-site", "same-site"]);

/** Records an export refused before it started (`rows: 0`). */
async function recordRefusal(
  auditContext: AuditContext,
  input: CsvExportRequest,
  reason: "rate_limited" | "busy",
): Promise<void> {
  await recordAuditEvent({
    ...auditContext,
    action: "export.downloaded",
    outcome: "failure",
    metadata: {
      table: input.source.table,
      filters: [...input.filters],
      rows: 0,
      truncated: false,
      reason,
    },
  });
}

/**
 * The download response for one export, or the 403 / 429 / 503 page. See
 * the file comment for the steps.
 */
export async function csvExportResponse(
  input: CsvExportRequest,
): Promise<Response | string> {
  const { source, auth, set, request } = input;
  const userId = auth.user.id;
  const table = source.table;

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && FOREIGN_FETCH_SITES.has(fetchSite)) {
    logger.warn("CSV export refused: started by another site", {
      userId,
      table,
      fetchSite,
    });
    set.status = 403;
    return <ForbiddenPage message="Exports can only be started from this dashboard." />;
  }

  const auditContext = dashboardAudit(auth, request, input.server);

  const slot = acquireExportSlot();
  if (!slot) {
    logger.warn("CSV export refused: too many exports running", { userId, table });
    await recordRefusal(auditContext, input, "busy");
    set.status = 429;
    set.headers["retry-after"] = String(EXPORT_BUSY_RETRY_AFTER_SEC);
    return <ExportLimitedPage retryAfterMinutes={1} />;
  }

  const release: () => void = slot;

  const budget = await takeExportBudget(userId);
  if (budget.limited) {
    release();
    logger.warn("CSV export refused: rate limited", {
      userId,
      table,
      retryAfterSec: budget.retryAfterSec,
    });
    await recordRefusal(auditContext, input, "rate_limited");
    set.status = 429;
    set.headers["retry-after"] = String(budget.retryAfterSec);
    return <ExportLimitedPage retryAfterMinutes={Math.ceil(budget.retryAfterSec / 60)} />;
  }

  const startedAt = performance.now();
  /** The request's log context: the stream's callbacks run outside it. */
  const logContext = getLogContext() ?? {};
  const { batchSize, rowCap } = exportLimits;

  let written = 0;
  let truncated = false;
  let ended = false;

  /** Releases the slot, logs the end of the export and records it, once. */
  async function end(how: ExportEnd, error?: unknown): Promise<void> {
    if (ended) return;
    ended = true;
    release();
    const fields = {
      userId,
      table,
      rows: written,
      truncated,
      durationMs: Math.round(performance.now() - startedAt),
    };
    if (how === "finished") logger.info("CSV export finished", fields);
    else if (how === "cancelled")
      logger.warn("CSV export cancelled by the client", fields);
    else logger.error("CSV export failed", { ...fields, error: loggableError(error) });
    const outcome: AuditOutcome = how === "finished" ? "success" : "failure";
    await recordAuditEvent({
      ...auditContext,
      action: "export.downloaded",
      outcome,
      metadata: { table, filters: [...input.filters], rows: written, truncated },
    });
  }

  /** How many rows the next batch asks for: one past the cap, to tell "exactly the cap" from "more". */
  function nextLimit(): number {
    return Math.min(batchSize, rowCap - written + 1);
  }

  let first: ExportBatch;
  try {
    first = await source.fetchBatch(null, nextLimit());
  } catch (error: unknown) {
    await end("failed", error);
    set.status = 503;
    return "Export temporarily unavailable";
  }

  const encoder = new TextEncoder();
  let cursor: ExportCursor | null = null;

  /**
   * Writes a batch, up to the cap. Returns true when the export is
   * complete (no more rows, or the cap reached).
   */
  function write(
    batch: ExportBatch,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean {
    const room = rowCap - written;
    const rows = batch.rows.slice(0, room);
    if (rows.length > 0) controller.enqueue(encoder.encode(rows.map(csvRow).join("")));
    written += rows.length;
    if (batch.rows.length > room) {
      truncated = true;
      return true;
    }
    cursor = batch.next;
    return cursor === null;
  }

  /** Ends the file: the truncation row when capped, the audit record, then close. */
  async function complete(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    if (truncated) {
      const note = [truncationNote(rowCap), ...source.headers.slice(1).map(() => null)];
      controller.enqueue(encoder.encode(csvRow(note)));
    }
    await end("finished");
    controller.close();
  }

  /**
   * Runs one step of the stream; any throw (a query, a cell that cannot
   * be written) ends the export as failed, logged and audited, and errors
   * the stream so the download is marked broken.
   */
  async function step(
    controller: ReadableStreamDefaultController<Uint8Array>,
    run: () => Promise<void>,
  ): Promise<void> {
    try {
      await run();
    } catch (error: unknown) {
      await end("failed", error);
      controller.error(new Error("CSV export failed"));
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) =>
      runWithLogContext(logContext, () =>
        step(controller, async () => {
          controller.enqueue(encoder.encode(CSV_BOM + csvRow(source.headers)));
          if (write(first, controller)) await complete(controller);
        }),
      ),
    pull: (controller) =>
      runWithLogContext(logContext, () =>
        step(controller, async () => {
          if (ended || cursor === null) return;
          const batch = await source.fetchBatch(cursor, nextLimit());
          if (write(batch, controller)) await complete(controller);
        }),
      ),
    cancel: () => runWithLogContext(logContext, () => end("cancelled")),
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFilename(table)}"`,
      "cache-control": "no-store",
    },
  });
}
