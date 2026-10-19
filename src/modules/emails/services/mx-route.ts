import { lookup, resolve4, resolve6, resolveMx } from "dns/promises";
import { logger } from "../../../utils/logger.ts";
import { redactEmailsInText } from "../../../utils/redact.ts";
import { classifySendFailure } from "../../../utils/smtp-error.ts";
import { resolveMxAddresses, type LookupAll } from "./mx-address.ts";
import {
  SMTP_SESSION_DEADLINE_MS,
  type MxSessionOutcome,
  type MxSessionTransaction,
} from "./mx-transport.ts";

/**
 * Where a recipient domain's mail goes, and how an attempt works through
 * those places (#250).
 *
 * **Resolution** ({@link resolveMxRoute}), on every attempt, never cached:
 *
 * - MX hosts: sorted by preference, ties in random order (RFC 5321 5.1).
 * - A null MX (`MX 0 .`, RFC 7505, or any empty exchange): terminal, the
 *   domain accepts no mail.
 * - No MX records: the domain's own A/AAAA records, as one host of
 *   preference 0 (the implicit MX, RFC 5321 5.1). No address records
 *   either: terminal.
 * - NXDOMAIN: terminal. Bun reports a name without MX records as
 *   `ENOTFOUND` too (Node says `ENODATA`), so an `ENOTFOUND` also checks
 *   the address records: a name that truly does not exist has none, and
 *   one that exists without MX records gets its implicit MX.
 * - Any other resolver error (`ESERVFAIL`, `ETIMEOUT`, `ECONNREFUSED`,
 *   `EAI_AGAIN`, ...): temporary, retried on the queue's backoff and
 *   resolved again then.
 *
 * **Failover** ({@link deliverWithFailover}): host after host, address
 * after address (at most {@link MAX_MX_HOSTS_PER_ATTEMPT} hosts and
 * {@link MAX_ADDRESSES_PER_HOST} addresses each), within one session
 * deadline. Only a connection-level failure or a `421` moves on; any other
 * reply from a server that answered decides the attempt.
 *
 * Config-free: the mailer passes the session runner and the lock, and the
 * DNS lookups are replaceable ({@link setMxRouteDeps}), so this unit-tests
 * with stubs and no `mock.module`.
 */

/** Most MX hosts one attempt tries (#250). */
export const MAX_MX_HOSTS_PER_ATTEMPT = 5;

/** Most addresses one attempt tries per MX host (#250). */
export const MAX_ADDRESSES_PER_HOST = 2;

/** Longest one DNS lookup may take; past it, the lookup counts as `ETIMEOUT`. */
const DNS_LOOKUP_TIMEOUT_MS = 15_000;

/** One MX record as `dns/promises` returns it. */
interface MxRecord {
  exchange: string;
  priority: number;
}

/** The DNS lookups, the tie order and the SMTP port, replaceable in tests. */
export interface MxRouteDeps {
  resolveMx: (domain: string) => Promise<MxRecord[]>;
  resolve4: (hostname: string) => Promise<string[]>;
  resolve6: (hostname: string) => Promise<string[]>;
  /** Address lookup of an MX host, see `resolveMxAddresses`. */
  lookup: LookupAll;
  /** Orders MX hosts of equal preference. */
  random: () => number;
  /** SMTP port of an MX host: 25. Tests point each host at a local server. */
  smtpPort: (mxHost: string) => number;
  timeoutMs: number;
}

const realDeps: MxRouteDeps = {
  /** Called through, so a replaced `dns/promises` export is honoured. */
  resolveMx: (domain) => resolveMx(domain),
  resolve4: (hostname) => resolve4(hostname),
  resolve6: (hostname) => resolve6(hostname),
  lookup: (host) => lookup(host, { all: true }),
  random: () => Math.random(),
  smtpPort: () => 25,
  timeoutMs: DNS_LOOKUP_TIMEOUT_MS,
};

let deps: MxRouteDeps = realDeps;

/** Replaces the DNS lookups (tests), or restores the real ones with `null`. */
export function setMxRouteDeps(override: Partial<MxRouteDeps> | null): void {
  deps = override === null ? realDeps : { ...realDeps, ...override };
}

/** What resolving a recipient domain gave, for one attempt. */
export type MxRoute =
  | {
      kind: "hosts";
      /** MX hosts in the order to try them; the domain itself for an implicit MX. */
      hosts: string[];
      /** No MX records: `hosts` is the domain, delivered to its A/AAAA records. */
      implicit: boolean;
    }
  /** The domain cannot receive mail: the entry fails, without retries. */
  | { kind: "failed"; error: string }
  /** The lookup failed for now: the entry is retried, and resolved again then. */
  | { kind: "retry"; error: string };

/** DNS codes that are an answer (the name or the record does not exist), not a failure. */
const NO_RECORDS = new Set(["ENOTFOUND", "ENODATA"]);

/** The `code` of a DNS error (`ENOTFOUND`, `ESERVFAIL`, ...), if it has one. */
function dnsCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

/** A DNS lookup, rejected with an `ETIMEOUT` error past `timeoutMs`. */
async function withTimeout<T>(lookupPromise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error("DNS lookup timed out"), { code: "ETIMEOUT" }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([lookupPromise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** An MX exchange as a host name: trimmed, lowercased, without the trailing dot. */
function hostName(exchange: string): string {
  return exchange.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * MX hosts in the order to try them (RFC 5321 5.1): lowest preference
 * first, hosts of equal preference in random order (each gets a random
 * key, then one stable sort), a host listed twice kept once.
 */
export function orderMxHosts(records: MxRecord[], random: () => number): string[] {
  const ordered = records
    .map((record) => ({
      host: hostName(record.exchange),
      preference: record.priority,
      tie: random(),
    }))
    .toSorted((a, b) => a.preference - b.preference || a.tie - b.tie)
    .map(({ host }) => host);
  return [...new Set(ordered)];
}

/**
 * Resolves where `domain`'s mail goes for this attempt (#250), see the
 * module comment. Never throws.
 */
export async function resolveMxRoute(
  domain: string,
  routeDeps: MxRouteDeps = deps,
): Promise<MxRoute> {
  let records: MxRecord[];
  try {
    records = await withTimeout(routeDeps.resolveMx(domain), routeDeps.timeoutMs);
  } catch (error) {
    const code = dnsCode(error);
    if (code !== undefined && NO_RECORDS.has(code)) {
      return implicitMx(domain, code, routeDeps);
    }
    return {
      kind: "retry",
      error: `${domain}: MX lookup failed temporarily (${code ?? "unknown error"}); will retry`,
    };
  }
  if (records.length === 0) return implicitMx(domain, "ENODATA", routeDeps);
  if (records.some((record) => hostName(record.exchange) === "")) {
    return { kind: "failed", error: `${domain}: domain does not accept mail (null MX)` };
  }
  return {
    kind: "hosts",
    hosts: orderMxHosts(records, routeDeps.random),
    implicit: false,
  };
}

/**
 * The implicit MX (RFC 5321 5.1): `domain` has no MX records (`mxCode`
 * is how the MX lookup said so), so its own A/AAAA records receive its
 * mail. Their addresses are looked up again, and checked like any MX
 * host's, when the attempt connects.
 */
async function implicitMx(
  domain: string,
  mxCode: string,
  routeDeps: MxRouteDeps,
): Promise<MxRoute> {
  const answers = await Promise.allSettled([
    withTimeout(routeDeps.resolve4(domain), routeDeps.timeoutMs),
    withTimeout(routeDeps.resolve6(domain), routeDeps.timeoutMs),
  ]);
  if (answers.some((a) => a.status === "fulfilled" && a.value.length > 0)) {
    return { kind: "hosts", hosts: [hostName(domain)], implicit: true };
  }
  for (const answer of answers) {
    if (answer.status !== "rejected") continue;
    const code = dnsCode(answer.reason);
    if (code === undefined || !NO_RECORDS.has(code)) {
      return {
        kind: "retry",
        error: `${domain}: address lookup failed temporarily (${code ?? "unknown error"}); will retry`,
      };
    }
  }
  return {
    kind: "failed",
    error:
      mxCode === "ENOTFOUND"
        ? `${domain}: domain does not exist`
        : `${domain}: domain has no MX or address records`,
  };
}

/**
 * Whether a failed transaction moves on to the next address or host
 * (#250): a connection-level failure (refused, timed out, reset, a TLS
 * stall, no greeting: no SMTP reply at all) or a `421` (the server is
 * closing the channel). Any other reply came from a server that answered,
 * and decides the attempt.
 */
export function failsOver(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  const responseCode: unknown = Reflect.get(error, "responseCode");
  if (typeof responseCode === "number") return responseCode === 421;
  if (/^421[ -]/m.test(error.message)) return true;
  return classifySendFailure(error) === null;
}

/** One transaction's outcome after failover, and the MX host it ended on. */
export interface RoutedOutcome extends MxSessionOutcome {
  /** The MX host of the outcome; `null` when no host could be connected to. */
  mxHost: string | null;
}

/** One SMTP session to one address of an MX host, see `runMxSession`. */
export type SessionRunner = (session: {
  address: string;
  mxHost: string;
  port: number;
  transactions: MxSessionTransaction[];
  deadlineMs: number;
}) => Promise<MxSessionOutcome[]>;

/** The per-MX lock, see `withMxLock`: held around one session, never across hosts. */
export type MxLock = <T>(mxHost: string, fn: () => Promise<T>) => Promise<T>;

/** The error of an attempt whose session time ran out before every host was tried. */
function attemptDeadlineError(deadlineMs: number): Error {
  return new Error(
    `SMTP session exceeded ${Math.round(deadlineMs / 1000)} s and was closed`,
  );
}

/** A failure's message for a debug line: no recipient address in it (#260). */
function reasonOf(error: unknown): string {
  return redactEmailsInText(error instanceof Error ? error.message : String(error));
}

/**
 * Delivers `transactions` to the first of `hosts` that takes them (#250).
 *
 * Hosts are tried in order (at most {@link MAX_MX_HOSTS_PER_ATTEMPT}), and
 * each host's checked addresses in order (at most
 * {@link MAX_ADDRESSES_PER_HOST}). A transaction moves on only when
 * {@link failsOver} says so; an accepted one, or one a server answered
 * with any other reply, is done. The transactions still pending go to the
 * next address together.
 *
 * All sessions of one attempt share one deadline (`deadlineMs`, counted
 * while sessions run, not while waiting for a lock). `lock` is taken per
 * session, keyed by the host connected to, so no lock is held while
 * another host is tried.
 *
 * Never throws: every transaction gets an outcome. One left without a
 * host carries the last failure (connection error, refused host, or the
 * deadline), which has no SMTP reply, so it is retried.
 */
export async function deliverWithFailover(args: {
  /** For log lines: the recipient domain(s) of these transactions. */
  domain: string;
  hosts: string[];
  transactions: MxSessionTransaction[];
  allowPrivate: boolean;
  runSession: SessionRunner;
  lock: MxLock;
  deadlineMs?: number;
  routeDeps?: MxRouteDeps;
}): Promise<RoutedOutcome[]> {
  const routeDeps = args.routeDeps ?? deps;
  const deadlineMs = args.deadlineMs ?? SMTP_SESSION_DEADLINE_MS;
  let budgetMs = deadlineMs;
  const done = new Map<string, RoutedOutcome>();
  /** Latest failure of each transaction still pending. */
  const lastFailure = new Map<string, RoutedOutcome>();
  let pending = args.transactions;

  if (args.hosts.length > MAX_MX_HOSTS_PER_ATTEMPT) {
    logger.debug("MX hosts beyond the per-attempt cap not tried", {
      domain: args.domain,
      skipped: args.hosts.slice(MAX_MX_HOSTS_PER_ATTEMPT),
    });
  }

  for (const mxHost of args.hosts.slice(0, MAX_MX_HOSTS_PER_ATTEMPT)) {
    if (pending.length === 0 || budgetMs <= 0) break;
    let addresses: string[];
    try {
      addresses = await resolveMxAddresses(mxHost, {
        allowPrivate: args.allowPrivate,
        lookup: routeDeps.lookup,
      });
    } catch (error) {
      /** Never connected: no session, so nothing known about TLS. */
      logger.debug("MX host skipped", {
        domain: args.domain,
        mxHost,
        reason: reasonOf(error),
      });
      for (const t of pending) {
        lastFailure.set(t.key, { key: t.key, error, tls: null, mxHost: null });
      }
      continue;
    }
    if (addresses.length > MAX_ADDRESSES_PER_HOST) {
      logger.debug("MX host addresses beyond the per-host cap not tried", {
        mxHost,
        skipped: addresses.length - MAX_ADDRESSES_PER_HOST,
      });
    }

    for (const address of addresses.slice(0, MAX_ADDRESSES_PER_HOST)) {
      if (pending.length === 0 || budgetMs <= 0) break;
      const sessionTransactions = pending;
      const outcomes = await args.lock(mxHost, async () => {
        /** The budget may have run out while this waited for the lock. */
        if (budgetMs <= 0) {
          const error = attemptDeadlineError(deadlineMs);
          return sessionTransactions.map((t) => ({ key: t.key, error, tls: null }));
        }
        const startedAt = Date.now();
        try {
          return await args.runSession({
            address,
            mxHost,
            port: routeDeps.smtpPort(mxHost),
            transactions: sessionTransactions,
            deadlineMs: budgetMs,
          });
        } finally {
          budgetMs -= Date.now() - startedAt;
        }
      });

      const movingOn: MxSessionOutcome[] = [];
      for (const outcome of outcomes) {
        if (outcome.error !== undefined && failsOver(outcome.error)) {
          movingOn.push(outcome);
          lastFailure.set(outcome.key, { ...outcome, mxHost });
        } else {
          done.set(outcome.key, { ...outcome, mxHost });
        }
      }
      pending = pending.filter((t) => !done.has(t.key));
      if (movingOn.length > 0) {
        logger.debug("MX address failed, trying the next", {
          domain: args.domain,
          mxHost,
          address,
          transactions: movingOn.length,
          reason: reasonOf(movingOn[0]?.error),
        });
      }
    }
  }

  return args.transactions.map(
    (t) =>
      done.get(t.key) ??
      lastFailure.get(t.key) ?? {
        key: t.key,
        error: new Error(`${args.domain}: no MX host could be tried`),
        tls: null,
        mxHost: null,
      },
  );
}
