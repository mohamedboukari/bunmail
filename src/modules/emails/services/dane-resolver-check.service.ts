/**
 * Self-check of `DANE_RESOLVER` (#426): does the trusted resolver answer,
 * and does it validate DNSSEC?
 *
 * With `DANE_ENABLED=true` every outbound MX and address lookup goes to
 * that one resolver (`dns-secure.ts`). A wrong address, a resolver that is
 * down, or one that answers without validating would otherwise only show
 * up as per-send `warn` lines, while mail to every domain waits. This
 * check asks two names through the same secure lookup code DANE uses and
 * logs one line per run:
 *
 * 1. {@link SIGNED_PROBE_NAME} (`org`, type A): a DNSSEC-signed answer. No
 *    answer at all (or a failure such as SERVFAIL) logs `error`: every
 *    DANE lookup would fail the same way. An answer without the AD bit
 *    logs `warn`: the resolver does not validate, so DANE never applies.
 * 2. {@link BOGUS_PROBE_NAME} (`dnssec-failed.org`, type A): a name whose
 *    signatures are deliberately broken. A validating resolver refuses it
 *    (SERVFAIL); an answer without AD means it passes bogus data on (for
 *    example Unbound's `val-permissive-mode`), and logs `warn`.
 *
 * **Why these names.** The root zone itself (`.` DNSKEY) would be the
 * most stable signed name, but the shared query encoder (`nameLabels` in
 * `dns-wire.ts`) does not take the empty root name and only asks the
 * record types DANE needs (A, AAAA, MX, CNAME, TLSA), and widening it
 * would touch every DNS caller. The `org` top-level domain is the next
 * best: it depends only on the root trust anchor and the `.org` registry
 * (signed since 2009), not on a third party's DNS operations, which have
 * let the signatures of well-known signed domains expire before. It has
 * no A record, so the answer is an authenticated denial (NOERROR, no
 * records, NSEC3 proof): to set AD the resolver must validate the whole
 * chain from the root, exactly as for records. And it is the parent of
 * the broken name, so both probes share the chain root, `org`: only the
 * deliberately broken leaf differs. `dnssec-failed.org` has been kept
 * broken on purpose for years as a public DNSSEC test. Should its owner
 * ever fix or delete it, a validating resolver gets an AD answer or a
 * signed NXDOMAIN for it; that case is logged at `info` as "not
 * confirmed" rather than as a resolver problem.
 *
 * **Schedule** (mirrors the sending-IP DNSBL self-check,
 * `sending-ip-dnsbl.service.ts`): the first run about 30 s after boot, so
 * a resolver container started alongside BunMail (the compose `dane`
 * profile, whose `unbound-anchor` refreshes the trust anchor first) has
 * time to come up; then about every 24 hours, or about every hour while a
 * run does not pass, so a resolver that comes up late shows a passing
 * line soon. Never fatal: the boot never waits for it.
 *
 * Each run happens in its own log context (`job: "dane-resolver-check"`,
 * a fresh `jobId`). Logged: the resolver's address and port, the names
 * asked and the error code. No secrets are involved.
 */
import { config } from "../../../config.ts";
import type { DaneConfig } from "../../../config/dane.ts";
import { lookupSecure, type SecureLookupOptions } from "../../../utils/dns-secure.ts";
import type { DnsTxtErrorCode } from "../../../utils/dns-wire.ts";
import { generateId } from "../../../utils/id.ts";
import { runWithLogContext } from "../../../utils/log-context.ts";
import { logger } from "../../../utils/logger.ts";
import { loggableError } from "../../../utils/db-error.ts";

/** A DNSSEC-signed name with no A record: its A answer is an authenticated denial. */
export const SIGNED_PROBE_NAME = "org";
/** A name with deliberately broken DNSSEC signatures: a validating resolver refuses it. */
export const BOGUS_PROBE_NAME = "dnssec-failed.org";

/** What one run of the check found. */
export type DaneResolverCheckResult =
  /** The signed name came back with AD and the broken one was refused. */
  | { status: "passed" }
  /** The signed name validated, but the broken name no longer tests anything (fixed or gone). */
  | { status: "unconfirmed" }
  /** The resolver did not answer the signed name, or could not resolve it. */
  | { status: "failing"; code: DnsTxtErrorCode }
  /** The resolver answers without validating. */
  | {
      status: "not-validating";
      reason: "signed-name-without-ad" | "bogus-name-resolved";
    };

/** Codes that mean nothing came back from the resolver, as opposed to an RCODE it sent. */
const NO_ANSWER_CODES: ReadonlySet<DnsTxtErrorCode> = new Set([
  "ETIMEOUT",
  "ECONNREFUSED",
  "EBADRESP",
]);

/** How to fix a resolver that does not answer or cannot resolve. */
const FAILING_HINT =
  "check that the resolver is running and reachable from BunMail at DANE_RESOLVER (with the compose dane profile: the unbound service and the dane network in docker-compose.override.yml); outbound mail waits in retry until it answers";

/** How to fix a resolver that does not validate. */
const NOT_VALIDATING_HINT =
  "DANE_RESOLVER must be a validating resolver (Unbound with a root trust anchor and val-permissive-mode: no, as in the compose dane profile); without validation DANE never applies";

/** Lookup timeouts; production uses the defaults of `lookupSecure`. */
export type DaneResolverCheckTimeouts = Pick<
  SecureLookupOptions,
  "attemptTimeoutMs" | "timeoutMs"
>;

/**
 * Runs the two probes against `resolver` and decides the outcome, without
 * logging it (see {@link runDaneResolverCheck}).
 *
 * @param options - The resolver, with optional timeouts
 * @returns What the probes found
 */
async function probeDaneResolver(
  options: SecureLookupOptions,
): Promise<DaneResolverCheckResult> {
  const signed = await lookupSecure(SIGNED_PROBE_NAME, "A", options);
  if (signed.kind === "failure") return { status: "failing", code: signed.code };
  if (!signed.secure) {
    return { status: "not-validating", reason: "signed-name-without-ad" };
  }

  const bogus = await lookupSecure(BOGUS_PROBE_NAME, "A", options);
  /** Any failure (SERVFAIL from a validating resolver, or a timeout) means it was not passed on. */
  if (bogus.kind === "failure") {
    logger.debug("DANE resolver check: broken name refused", {
      name: BOGUS_PROBE_NAME,
      code: bogus.code,
    });
    return { status: "passed" };
  }
  /** Gone (NXDOMAIN), or validating now (AD): the name no longer tells anything. */
  if (bogus.kind === "nxdomain" || bogus.secure) return { status: "unconfirmed" };
  return { status: "not-validating", reason: "bogus-name-resolved" };
}

/** Logs the outcome of one run: `info`, `warn` or `error` (see the module comment). */
function logResult(
  result: DaneResolverCheckResult,
  resolver: SecureLookupOptions["resolver"],
  durationMs: number,
): void {
  const where = { resolver: resolver.address, port: resolver.port, durationMs };
  switch (result.status) {
    case "passed":
      logger.info("DANE resolver check passed: DANE_RESOLVER answers and validates", {
        ...where,
        signedName: SIGNED_PROBE_NAME,
        bogusName: BOGUS_PROBE_NAME,
      });
      return;
    case "unconfirmed":
      logger.info(
        "DANE resolver check passed: DANE_RESOLVER answers and validates; refusing bogus answers was not confirmed",
        {
          ...where,
          signedName: SIGNED_PROBE_NAME,
          bogusName: BOGUS_PROBE_NAME,
          note: "the deliberately broken test name no longer fails validation (fixed or deleted by its owner)",
        },
      );
      return;
    case "failing":
      logger.error(
        NO_ANSWER_CODES.has(result.code)
          ? "DANE resolver check failed: DANE_RESOLVER does not answer"
          : "DANE resolver check failed: DANE_RESOLVER cannot resolve a DNSSEC-signed name",
        { ...where, name: SIGNED_PROBE_NAME, code: result.code, hint: FAILING_HINT },
      );
      return;
    case "not-validating":
      logger.warn(
        result.reason === "signed-name-without-ad"
          ? "DANE resolver check failed: DANE_RESOLVER does not validate DNSSEC (no AD bit on a signed name)"
          : "DANE resolver check failed: DANE_RESOLVER does not validate DNSSEC (it answers a deliberately broken name)",
        {
          ...where,
          name:
            result.reason === "signed-name-without-ad"
              ? SIGNED_PROBE_NAME
              : BOGUS_PROBE_NAME,
          reason: result.reason,
          hint: NOT_VALIDATING_HINT,
        },
      );
      return;
  }
}

/**
 * One run: probes `DANE_RESOLVER` and logs one line with the outcome, in
 * its own log context (`job: "dane-resolver-check"`, a fresh `jobId`).
 * Does nothing and returns null while DANE is off. Never rejects.
 *
 * @param dane - The DANE settings; `config.dane` by default (tests pass their own)
 * @param timeouts - Lookup timeouts; the `lookupSecure` defaults by default
 * @returns What the run found, or null when DANE is off
 */
export function runDaneResolverCheck(
  dane: DaneConfig = config.dane,
  timeouts: DaneResolverCheckTimeouts = {},
): Promise<DaneResolverCheckResult | null> {
  return runWithLogContext(
    { job: "dane-resolver-check", jobId: generateId("drc") },
    async () => {
      const resolver = dane.resolver;
      if (!dane.enabled || resolver === null) return null;
      const startedAt = Date.now();
      try {
        const result = await probeDaneResolver({ resolver, ...timeouts });
        logResult(result, resolver, Date.now() - startedAt);
        return result;
      } catch (error: unknown) {
        /** `lookupSecure` never throws; this guards the scheduler against a bug. */
        logger.error("DANE resolver check crashed", {
          errorName: error instanceof Error ? error.name : typeof error,
          error: loggableError(error),
        });
        return null;
      }
    },
  );
}

/** Delay of the first run after boot, before jitter. */
const FIRST_RUN_DELAY_MS = 30 * 1000;
/** Time between two runs after a passing one, before jitter. */
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Time until the next run after one that did not pass, before jitter. */
const RECHECK_INTERVAL_MS = 60 * 60 * 1000;

/** `ms` plus or minus `fraction` of it, so replicas do not run in lockstep. */
function withJitter(ms: number, fraction: number): number {
  return Math.round(ms * (1 - fraction + Math.random() * 2 * fraction));
}

/** Whether a run's outcome counts as passing for the schedule. */
function passed(result: DaneResolverCheckResult | null): boolean {
  return result === null || result.status === "passed" || result.status === "unconfirmed";
}

/** True between `start()` and `stop()`. */
let running = false;
/** The DANE settings `start()` was given, used by every scheduled run. */
let activeDane: DaneConfig = config.dane;
/** True while a run is in progress; it schedules the next one when it ends. */
let inRun = false;
/** The next scheduled run, or null while a run is in progress or once stopped. */
let timer: ReturnType<typeof setTimeout> | null = null;

/** Schedules the next run after `delayMs`, unless the check was stopped. */
function scheduleRun(delayMs: number): void {
  if (!running) return;
  timer = setTimeout(() => {
    timer = null;
    inRun = true;
    void runDaneResolverCheck(activeDane).then((result) => {
      inRun = false;
      scheduleRun(
        passed(result)
          ? withJitter(RUN_INTERVAL_MS, 0.05)
          : withJitter(RECHECK_INTERVAL_MS, 0.1),
      );
    });
  }, delayMs);
}

/**
 * Starts the check: the first run about 30 s after boot (22 to 38 s), then
 * one about every 24 hours (plus or minus 5%), or about every hour while
 * a run does not pass, each scheduled when the previous one ends.
 * Idempotent. Does nothing while `DANE_ENABLED` is not `true`.
 *
 * @param dane - The DANE settings; `config.dane` by default (tests pass their own)
 */
export function start(dane: DaneConfig = config.dane): void {
  if (running) return;
  if (!dane.enabled || dane.resolver === null) return;
  running = true;
  activeDane = dane;
  logger.info("Starting DANE resolver check", {
    resolver: dane.resolver.address,
    port: dane.resolver.port,
    intervalHours: RUN_INTERVAL_MS / 3_600_000,
  });
  /** Restarted during a run: that run schedules the next one. */
  if (!inRun) scheduleRun(withJitter(FIRST_RUN_DELAY_MS, 0.25));
}

/** Stops the check. Called from the SIGINT/SIGTERM shutdown path. */
export function stop(): void {
  if (!running) return;
  running = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  logger.info("DANE resolver check stopped");
}

/** Whether the check is running (tests). */
export function isRunning(): boolean {
  return running;
}
