import { eq } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { domains } from "../../domains/models/domain.schema.ts";
import { emails } from "../../emails/models/email.schema.ts";
import type { VerifiedClickToken } from "./tracking-token.ts";

/**
 * Per-domain revocation of click links (#424). A click token whose MAC
 * verified still has to match its sender domain's current tracking
 * epoch (`domains.tracking_epoch`), which an admin bumps to revoke every
 * click link already sent from the domain.
 *
 * - **v2 token:** it names its domain and epoch. It redirects only while
 *   the domain exists and is still at that epoch.
 * - **v1 token** (sent before #424): its domain is the email row's
 *   `domain_id`, and it counts as epoch 0. It redirects only while that
 *   row exists, has a domain, and the domain is still at epoch 0.
 *
 * Only tokens whose MAC verified get here, so a forged token never costs
 * a query. The epochs (and the email domains of v1 links) are cached in
 * process, so a click does not cost a query each time. A bump or a
 * domain delete in this process clears the domain's entry at once
 * ({@link forgetTrackingEpoch}); another process (a second replica) sees
 * it within {@link TRACKING_EPOCH_TTL_MS}.
 */

/**
 * How long a domain's epoch (or its absence), and a v1 link's email
 * domain, are cached, in ms: the longest a bump or a domain delete made
 * by another process takes to apply here.
 */
export const TRACKING_EPOCH_TTL_MS = 30_000;

/** Most entries per cache; the cache starts over past it. */
const MAX_CACHED_ENTRIES = 10_000;

/** Options of {@link createTtlCache}; the defaults suit production. */
interface TtlCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** The clock, for tests. */
  now?: () => number;
}

/** A small in-process cache of values loaded by key. */
export interface TtlCache<V> {
  /** The key's value; loaded on a miss, one load at a time per key. */
  get: (key: string) => Promise<V>;
  /** Drops the key's entry, so the next {@link TtlCache.get} loads it again. */
  forget: (key: string) => void;
}

/**
 * Builds a cache over `load`: an entry lives `ttlMs`, concurrent misses
 * of one key share one load, and a failed load is not cached. A load
 * that was running when {@link TtlCache.forget} was called is returned
 * to its callers but not stored (it may have read the value from before
 * the change), and later calls start a new one.
 */
export function createTtlCache<V>(
  load: (key: string) => Promise<V>,
  options: TtlCacheOptions = {},
): TtlCache<V> {
  const ttlMs = options.ttlMs ?? TRACKING_EPOCH_TTL_MS;
  const maxEntries = options.maxEntries ?? MAX_CACHED_ENTRIES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: V; expiresAt: number }>();
  const inFlight = new Map<string, Promise<V>>();
  /** Bumped by every `forget`: a load started before one is not stored. */
  let generation = 0;

  return {
    get(key) {
      const cached = entries.get(key);
      if (cached !== undefined && cached.expiresAt > now()) {
        return Promise.resolve(cached.value);
      }
      const running = inFlight.get(key);
      if (running !== undefined) return running;
      const started = generation;
      const task = load(key).then(
        (value) => {
          if (inFlight.get(key) === task) inFlight.delete(key);
          if (started === generation) {
            if (entries.size >= maxEntries) entries.clear();
            entries.set(key, { value, expiresAt: now() + ttlMs });
          }
          return value;
        },
        (error: unknown) => {
          if (inFlight.get(key) === task) inFlight.delete(key);
          throw error;
        },
      );
      inFlight.set(key, task);
      return task;
    },
    forget(key) {
      generation += 1;
      entries.delete(key);
      inFlight.delete(key);
    },
  };
}

/** Reads a domain's epoch from the database, `null` when the domain does not exist. */
async function loadDomainEpoch(domainId: string): Promise<number | null> {
  const [row] = await db
    .select({ epoch: domains.trackingEpoch })
    .from(domains)
    .where(eq(domains.id, domainId));
  return row?.epoch ?? null;
}

/** The process-wide epoch cache the redirect reads. */
const epochCache = createTtlCache(loadDomainEpoch);

/**
 * Drops a domain's cached epoch after a bump or a delete, so its links
 * of the old epoch stop working in this process at once.
 */
export function forgetTrackingEpoch(domainId: string): void {
  epochCache.forget(domainId);
}

/**
 * The email's sender domain: `undefined` when the email row is gone,
 * `null` when it has none.
 */
async function loadEmailDomain(emailId: string): Promise<string | null | undefined> {
  const [row] = await db
    .select({ domainId: emails.domainId })
    .from(emails)
    .where(eq(emails.id, emailId));
  return row === undefined ? undefined : row.domainId;
}

/**
 * The process-wide cache of v1 links' email domains, so a valid v1 link
 * does not read its email on every click. Safe to cache: an email's
 * `domain_id` only ever becomes null (its domain deleted), and the epoch
 * check then refuses the link anyway. A purged email's links stop within
 * the TTL.
 */
const emailDomainCache = createTtlCache(loadEmailDomain);

/**
 * Why a verified click link does not redirect:
 *   - `revoked`: the domain's epoch is no longer the link's;
 *   - `unknown_domain`: the domain was deleted;
 *   - `email_gone`: a v1 link whose email row is gone;
 *   - `no_domain`: a v1 link whose email has no domain.
 */
export type ClickRefusal = "revoked" | "unknown_domain" | "email_gone" | "no_domain";

/** The outcome of {@link checkClickLink}, with the domain when it is known. */
export type ClickLinkCheck =
  | { ok: true; domainId: string }
  | { ok: false; reason: ClickRefusal; domainId: string | null };

/** Where {@link checkClickLink} reads from; the defaults use the database. */
export interface ClickLinkDeps {
  epochOf: (domainId: string) => Promise<number | null>;
  emailDomainOf: (emailId: string) => Promise<string | null | undefined>;
}

const defaultDeps: ClickLinkDeps = {
  epochOf: (domainId) => epochCache.get(domainId),
  emailDomainOf: (emailId) => emailDomainCache.get(emailId),
};

/**
 * Whether a verified click token may still redirect: its domain exists
 * and is at the token's epoch (0 for a v1 token). Throws when the
 * database does (the caller answers without redirecting).
 */
export async function checkClickLink(
  token: VerifiedClickToken,
  deps: ClickLinkDeps = defaultDeps,
): Promise<ClickLinkCheck> {
  let domainId: string;
  let expected: number;
  if (token.version === 2) {
    domainId = token.domainId;
    expected = token.epoch;
  } else {
    const emailDomain = await deps.emailDomainOf(token.emailId);
    if (emailDomain === undefined) {
      return { ok: false, reason: "email_gone", domainId: null };
    }
    if (emailDomain === null) return { ok: false, reason: "no_domain", domainId: null };
    domainId = emailDomain;
    expected = 0;
  }
  const current = await deps.epochOf(domainId);
  if (current === null) return { ok: false, reason: "unknown_domain", domainId };
  if (current !== expected) return { ok: false, reason: "revoked", domainId };
  return { ok: true, domainId };
}
