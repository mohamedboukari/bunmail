import { and, isNotNull, ne } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { logger } from "../../../utils/logger.ts";
import { sqlStateOf } from "../../../utils/db-error.ts";
import { domains } from "../models/domain.schema.ts";
import type { ServedMtaStsMode } from "../types/domain.types.ts";

/**
 * Which domains BunMail serves an MTA-STS policy for (#472): the verified
 * domains (`verified_at` set) whose mode is not `none`, by lowercase name.
 *
 * The whole set is read in one query and kept in process for
 * {@link MTA_STS_HOSTS_TTL_MS}, so a policy request never costs a query of
 * its own: the route is public, and a flood of requests for made-up
 * `mta-sts.<name>` hosts must not turn into one query each. The set is
 * small (an operator's own domains). A mode change, a verification flip or
 * a delete in this process drops it at once ({@link forgetMtaStsHosts});
 * another replica sees it within the TTL. Concurrent misses share one
 * load. A failed load keeps serving the previous set, when there is one.
 */

/** How long the set is kept, in ms: the longest a change made elsewhere takes to apply here. */
export const MTA_STS_HOSTS_TTL_MS = 30_000;

interface Snapshot {
  byName: Map<string, ServedMtaStsMode>;
  loadedAt: number;
}

/** Reads the served domains; replaceable in tests. */
type LoadServed = () => Promise<{ name: string; mode: ServedMtaStsMode }[]>;

/** The real load: verified domains with a mode other than `none`. */
const loadFromDb: LoadServed = async () => {
  const rows = await db
    .select({ name: domains.name, mode: domains.mtaStsMode })
    .from(domains)
    .where(and(ne(domains.mtaStsMode, "none"), isNotNull(domains.verifiedAt)));
  return rows.flatMap((row) =>
    row.mode === "none" ? [] : [{ name: row.name, mode: row.mode }],
  );
};

let load: LoadServed = loadFromDb;
let now: () => number = Date.now;
let snapshot: Snapshot | null = null;
let loading: Promise<Snapshot> | null = null;
/** Bumped by every forget: a load started before one is not kept. */
let generation = 0;

/** A stored name as a key: lowercase, no final dot (rows from before #406 may differ). */
function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Drops the cached set, so the next request reads it again. Called when a
 * domain's mode changes, it is deleted, or its verification flips.
 */
export function forgetMtaStsHosts(): void {
  snapshot = null;
  generation++;
}

/** Replaces the load and the clock (tests), or restores the real ones with `null`. */
export function setMtaStsHostsDeps(
  override: { load?: LoadServed; now?: () => number } | null,
): void {
  load = override?.load ?? loadFromDb;
  now = override?.now ?? Date.now;
  forgetMtaStsHosts();
}

/** Loads the set once for every caller waiting on it. */
function reload(): Promise<Snapshot> {
  if (loading !== null) return loading;
  const started = generation;
  const previous = snapshot;
  loading = load()
    .then((rows) => {
      const fresh: Snapshot = {
        byName: new Map(rows.map((row) => [nameKey(row.name), row.mode])),
        loadedAt: now(),
      };
      if (started === generation) snapshot = fresh;
      return fresh;
    })
    .catch((error: unknown) => {
      /** Name and SQLSTATE only: a driver message embeds the query parameters. */
      logger.error("MTA-STS served domains not loaded", {
        errorName: error instanceof Error ? error.name : typeof error,
        sqlState: sqlStateOf(error),
        keptPrevious: previous !== null,
      });
      if (previous === null) throw error;
      /** Kept for another TTL, so a failing database is not asked on every request. */
      const kept: Snapshot = { byName: previous.byName, loadedAt: now() };
      if (started === generation) snapshot = kept;
      return kept;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/**
 * The mode `domainName`'s policy is served under, or `null` when none is
 * served (unknown domain, not verified, or mode `none`). Rejects only
 * when the set could not be read and none was read before.
 */
export async function servedMtaStsMode(
  domainName: string,
): Promise<ServedMtaStsMode | null> {
  const current =
    snapshot !== null && now() - snapshot.loadedAt < MTA_STS_HOSTS_TTL_MS
      ? snapshot
      : await reload();
  return current.byName.get(nameKey(domainName)) ?? null;
}
