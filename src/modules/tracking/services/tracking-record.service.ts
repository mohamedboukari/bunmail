import { and, count, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { config } from "../../../config.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { sqlStateOf } from "../../../utils/db-error.ts";
import { emails } from "../../emails/models/email.schema.ts";
import { emailEvents } from "../../emails/models/email-event.schema.ts";
import type { Tx } from "../../emails/types/email.types.ts";
import { clientKindOf, storedClickUrl } from "./tracking-client.ts";
import { RecordingGuards } from "./tracking-guards.ts";
import type {
  TrackingClientKind,
  TrackingHit,
  TrackingKind,
  TrackingResult,
} from "../types/tracking.types.ts";

/**
 * Recording of open and click events (#187), after the token was
 * verified and the response sent. Bounded three ways:
 *
 * - **Dedupe:** the same email, type and link within
 *   {@link DEDUPE_WINDOW_SECONDS} is not recorded again.
 * - **Caps:** at most {@link MAX_OPENS_PER_EMAIL} opens and
 *   {@link MAX_CLICKS_PER_EMAIL} clicks per email.
 * - **Budget:** at most {@link RECORD_BUDGET_PER_SECOND} recordings per
 *   second per process, and at most {@link MAX_IN_FLIGHT} at once; past
 *   them, requests are still served but not recorded.
 *
 * An in-process gate (`tracking-guards.ts`) applies dedupe and caps first
 * and charges the budget only for what passes, so one replayed token
 * cannot use the budget up. The database checks stay the truth: dedupe
 * and caps are checked again under a lock on the email row (waited for
 * at most {@link LOCK_TIMEOUT}), in the transaction that inserts the
 * event, so concurrent requests (and replicas) cannot both pass them. No IP address and no user agent are
 * stored: only `client_kind` and the `machine` guess.
 */

/** Seconds within which the same email, type and link is recorded once. */
const DEDUPE_WINDOW_SECONDS = 60;

/** Most events recorded per email, by type. */
export const MAX_OPENS_PER_EMAIL = 20;
export const MAX_CLICKS_PER_EMAIL = 50;

/** Recordings per second per process, by default. */
const RECORD_BUDGET_PER_SECOND = 100;

/** Recordings running at once per process; more are dropped as `capped`. */
const MAX_IN_FLIGHT = 4;

/** Entries kept by each in-process LRU map of the gate. */
const MAX_GUARD_ENTRIES = 10_000;

/** How long the recording transaction waits for the email row lock. */
const LOCK_TIMEOUT = "2s";

/** Postgres SQLSTATE `lock_not_available`, raised past `lock_timeout`. */
const LOCK_NOT_AVAILABLE = "55P03";

/** A click this soon after the email was sent is likely a link scanner. */
const SCANNER_AFTER_SEND_MS = 10_000;

/** Clicks on other links of the same email within this many seconds suggest a scanner. */
const SCANNER_BURST_SECONDS = 2;

/** What recording a hit came to (never `invalid`: the token was verified). */
export type RecordResult = Exclude<TrackingResult, "invalid">;

/** The event to store, as the recorder decided it. */
interface EventToStore {
  emailId: string;
  apiKeyId: string;
  kind: TrackingKind;
  position: number | null;
  url: string | null;
  clientKind: TrackingClientKind;
  machine: boolean;
}

/**
 * Stores one event and, when it is the email's first of its type, sets
 * `first_opened_at` / `first_clicked_at` with a conditional `UPDATE`,
 * all in `tx`. Returns whether it was the first. The webhook events of a
 * later part go through the outbox in this same transaction.
 */
async function storeEvent(
  tx: Tx,
  event: EventToStore,
): Promise<{ id: string; first: boolean }> {
  const id = generateId("evt");
  await tx.insert(emailEvents).values({
    id,
    emailId: event.emailId,
    apiKeyId: event.apiKeyId,
    type: event.kind,
    linkPosition: event.position,
    url: event.url,
    clientKind: event.clientKind,
    machine: event.machine,
  });
  const column = event.kind === "open" ? emails.firstOpenedAt : emails.firstClickedAt;
  const updated = await tx
    .update(emails)
    .set(
      event.kind === "open"
        ? { firstOpenedAt: sql`now()` }
        : { firstClickedAt: sql`now()` },
    )
    .where(and(eq(emails.id, event.emailId), isNull(column)))
    .returning({ id: emails.id });
  return { id, first: updated.length > 0 };
}

/** The events of one email and type matching `extra`, counted in `tx`. */
async function countEvents(
  tx: Tx,
  hit: TrackingHit,
  extra?: ReturnType<typeof and>,
): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(emailEvents)
    .where(
      and(eq(emailEvents.emailId, hit.emailId), eq(emailEvents.type, hit.kind), extra),
    );
  return row?.n ?? 0;
}

/** `now() - <seconds>`, with the number inlined as an interval literal. */
function secondsAgo(seconds: number): ReturnType<typeof sql> {
  return sql`now() - ${sql.raw(`interval '${Math.trunc(seconds)} seconds'`)}`;
}

/** Records one verified hit in its own transaction (see the file comment). */
async function recordInTransaction(
  hit: TrackingHit,
  nowMs: number,
): Promise<RecordResult> {
  return db.transaction(async (tx): Promise<RecordResult> => {
    /** Never wait long on the row lock: a held lock costs a pooled connection. */
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`));
    const [email] = await tx
      .select({
        apiKeyId: emails.apiKeyId,
        trackOpens: emails.trackOpens,
        trackClicks: emails.trackClicks,
        sentAt: emails.sentAt,
      })
      .from(emails)
      .where(eq(emails.id, hit.emailId))
      .for("update");
    if (!email) return "untracked";
    if (hit.kind === "open" ? !email.trackOpens : !email.trackClicks) return "untracked";

    const cap = hit.kind === "open" ? MAX_OPENS_PER_EMAIL : MAX_CLICKS_PER_EMAIL;
    if ((await countEvents(tx, hit)) >= cap) return "capped";

    const sameLink =
      hit.position === null
        ? isNull(emailEvents.linkPosition)
        : eq(emailEvents.linkPosition, hit.position);
    const recent = gt(emailEvents.occurredAt, secondsAgo(DEDUPE_WINDOW_SECONDS));
    if ((await countEvents(tx, hit, and(sameLink, recent))) > 0) return "deduped";

    const clientKind = clientKindOf(hit.userAgent);
    let machine = clientKind === "image_proxy";
    if (!machine && hit.kind === "click") {
      const sentAt = email.sentAt?.getTime();
      const otherLinkBurst =
        hit.position === null
          ? 0
          : await countEvents(
              tx,
              hit,
              and(
                ne(emailEvents.linkPosition, hit.position),
                gt(emailEvents.occurredAt, secondsAgo(SCANNER_BURST_SECONDS)),
              ),
            );
      machine =
        (sentAt !== undefined && nowMs - sentAt < SCANNER_AFTER_SEND_MS) ||
        otherLinkBurst > 0;
    }

    const stored = await storeEvent(tx, {
      emailId: hit.emailId,
      apiKeyId: email.apiKeyId,
      kind: hit.kind,
      position: hit.position,
      url: hit.url === null ? null : storedClickUrl(hit.url),
      clientKind,
      machine,
    });
    logger.debug("Tracking event recorded", {
      emailId: hit.emailId,
      eventId: stored.id,
      kind: hit.kind,
      position: hit.position,
      clientKind,
      machine,
      first: stored.first,
    });
    return "recorded";
  });
}

/** Options of {@link createTrackingRecorder}; the defaults suit production. */
export interface TrackingRecorderOptions {
  /** Recordings per second per process. */
  budgetPerSecond?: number;
  /** Recordings running at once. */
  maxInFlight?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/**
 * Records verified hits; see the file comment. Never throws: `null` means
 * the recording failed (logged).
 */
export type TrackingRecorder = (hit: TrackingHit) => Promise<RecordResult | null>;

/**
 * A recorder with its own in-process gate (`tracking-guards.ts`): dedupe
 * and per-email caps first, then the per-second budget and at most
 * {@link MAX_IN_FLIGHT} transactions at once. The public routes use one;
 * a test can build one with small limits or a fixed clock.
 */
export function createTrackingRecorder(
  options: TrackingRecorderOptions = {},
): TrackingRecorder {
  const now = options.now ?? Date.now;
  const guards = new RecordingGuards({
    dedupeWindowMs: DEDUPE_WINDOW_SECONDS * 1000,
    caps: { open: MAX_OPENS_PER_EMAIL, click: MAX_CLICKS_PER_EMAIL },
    budgetPerSecond: options.budgetPerSecond ?? RECORD_BUDGET_PER_SECOND,
    maxInFlight: options.maxInFlight ?? MAX_IN_FLIGHT,
    maxEntries: MAX_GUARD_ENTRIES,
    now,
  });

  return async (hit: TrackingHit): Promise<RecordResult | null> => {
    /** The kill switch: served, never recorded. */
    if (!config.tracking.enabled) return "untracked";
    const decision = guards.admit(hit);
    if (decision !== "go") {
      logger.debug("Tracking event not recorded by the in-process gate", {
        emailId: hit.emailId,
        kind: hit.kind,
        result: decision,
      });
      return decision;
    }
    try {
      return await recordInTransaction(hit, now());
    } catch (error: unknown) {
      const sqlState = sqlStateOf(error);
      if (sqlState === LOCK_NOT_AVAILABLE) {
        logger.debug("Tracking event not recorded: email row busy", {
          emailId: hit.emailId,
          kind: hit.kind,
        });
        return "capped";
      }
      /** Name and SQLSTATE only: a driver message embeds the query parameters. */
      logger.error("Tracking event not recorded", {
        emailId: hit.emailId,
        kind: hit.kind,
        errorName: error instanceof Error ? error.name : typeof error,
        sqlState,
      });
      return null;
    } finally {
      guards.release();
    }
  };
}
