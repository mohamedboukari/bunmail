import { db } from "../../../db/index.ts";
import { domains } from "../../domains/models/domain.schema.ts";
import { domainNameIs } from "../../domains/services/domain.service.ts";
import {
  verifyDomain,
  type VerificationResult,
} from "../../domains/services/dns-verification.service.ts";
import type { Domain } from "../../domains/types/domain.types.ts";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import {
  SenderDomainNotRegisteredError,
  SenderDomainUnverifiedError,
} from "../errors.ts";
import type { SendWarning } from "../types/email.types.ts";

/**
 * How long a failed inline DKIM re-verification is trusted (#245). Within
 * this window a send from the same domain is refused without another DNS
 * lookup, so a client retrying in a loop cannot make every request query
 * DNS. Verifying the domain from the dashboard or API updates the stored
 * flag, which is read first, so a fixed record is honoured at once.
 */
export const UNVERIFIED_RECHECK_MS = 5 * 60 * 1000;

/** In-process memory of inline re-verifications, keyed by domain id. */
export interface RecheckCache {
  /** Epoch ms until which a failed re-verification is trusted. */
  unverifiedUntil: Map<string, number>;
  /** Re-verifications in progress: concurrent sends share one lookup. */
  inFlight: Map<string, Promise<VerificationResult | null>>;
}

/** Injected by tests; production uses {@link defaultDeps}. */
export interface SenderDomainDeps {
  /** Re-runs SPF/DKIM/DMARC DNS checks and stores the new flags. */
  verify: (domain: Domain) => Promise<VerificationResult>;
  now: () => number;
  cache: RecheckCache;
}

/**
 * Process-wide cache. Bounded by the number of registered domains (an
 * operator-controlled set), so it needs no eviction beyond expiry.
 */
const sharedCache: RecheckCache = { unverifiedUntil: new Map(), inFlight: new Map() };

const defaultDeps: SenderDomainDeps = {
  /** Looked up per call, not captured, so a test spy on the module applies. */
  verify: (domain) => verifyDomain(domain),
  now: Date.now,
  cache: sharedCache,
};

/** Result of {@link checkSenderDomain}. */
interface SenderDomainCheck {
  /** The registered domain's id, or null when unregistered (development). */
  domainId: string | null;
  warnings: SendWarning[];
}

/** IDs carried into every log line of the check. */
interface SendIds {
  id: string;
  apiKeyId: string;
}

/** One warning per DNS record that is not verified, DKIM first. */
function warningsFor(flags: VerificationResult): SendWarning[] {
  const warnings: SendWarning[] = [];
  if (!flags.dkim) warnings.push("dkim_unverified");
  if (!flags.spf) warnings.push("spf_unverified");
  if (!flags.dmarc) warnings.push("dmarc_unverified");
  return warnings;
}

/**
 * Runs the verifier once and records the outcome: a failure (or a thrown
 * error, treated as a failure) is remembered for
 * {@link UNVERIFIED_RECHECK_MS}, a success clears any memory.
 */
async function runRecheck(
  domain: Domain,
  ids: SendIds,
  deps: SenderDomainDeps,
): Promise<VerificationResult | null> {
  try {
    const result = await deps.verify(domain);
    if (result.dkim) deps.cache.unverifiedUntil.delete(domain.id);
    else deps.cache.unverifiedUntil.set(domain.id, deps.now() + UNVERIFIED_RECHECK_MS);
    return result;
  } catch (error: unknown) {
    /** By name only: a drizzle error's message embeds its query parameters. */
    logger.warn("Inline DKIM re-verification failed", {
      ...ids,
      domainId: domain.id,
      domain: domain.name,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    deps.cache.unverifiedUntil.set(domain.id, deps.now() + UNVERIFIED_RECHECK_MS);
    return null;
  }
}

/**
 * Re-verifies a domain whose stored DKIM flag is false, at most once per
 * {@link UNVERIFIED_RECHECK_MS} per domain. Returns the fresh flags, or
 * null when a recent failure is remembered or the check threw.
 */
async function recheckDomain(
  domain: Domain,
  ids: SendIds,
  deps: SenderDomainDeps,
): Promise<VerificationResult | null> {
  const until = deps.cache.unverifiedUntil.get(domain.id);
  if (until !== undefined) {
    if (until > deps.now()) {
      logger.debug("DKIM re-verification skipped: recent failure remembered", {
        ...ids,
        domainId: domain.id,
      });
      return null;
    }
    deps.cache.unverifiedUntil.delete(domain.id);
  }

  const pending = deps.cache.inFlight.get(domain.id);
  if (pending) return pending;

  const check = runRecheck(domain, ids, deps).finally(() => {
    deps.cache.inFlight.delete(domain.id);
  });
  deps.cache.inFlight.set(domain.id, check);
  return check;
}

/**
 * Resolves the sender domain of a send (#245): links the registered
 * domain for DKIM signing and reports which of its DNS records are not
 * verified.
 *
 * - Unregistered: rejected with {@link SenderDomainNotRegisteredError}
 *   in production or when `REQUIRE_VERIFIED_DOMAIN=true`; otherwise
 *   (development) allowed with a `domain_unregistered` warning.
 * - Registered with DKIM unverified and `REQUIRE_VERIFIED_DOMAIN=true`:
 *   re-verified inline once (see {@link recheckDomain}); still
 *   unverified → {@link SenderDomainUnverifiedError}.
 * - Otherwise allowed, with a warning per unverified record.
 */
export async function checkSenderDomain(
  name: string,
  ids: SendIds,
  deps: SenderDomainDeps = defaultDeps,
): Promise<SenderDomainCheck> {
  const [domain] = await db.select().from(domains).where(domainNameIs(name)).limit(1);
  const requireVerified = config.mail.requireVerifiedDomain;

  if (!domain) {
    if (config.env === "production" || requireVerified) {
      logger.warn("Send blocked: sender domain not registered", { ...ids, domain: name });
      throw new SenderDomainNotRegisteredError(name);
    }
    return { domainId: null, warnings: ["domain_unregistered"] };
  }

  let flags: VerificationResult = {
    spf: domain.spfVerified,
    dkim: domain.dkimVerified,
    dmarc: domain.dmarcVerified,
  };

  if (!flags.dkim && requireVerified) {
    const fresh = await recheckDomain(domain, ids, deps);
    if (!fresh?.dkim) {
      logger.warn("Send blocked: sender domain DKIM not verified", {
        ...ids,
        domainId: domain.id,
        domain: name,
      });
      throw new SenderDomainUnverifiedError(name);
    }
    flags = fresh;
  }

  return { domainId: domain.id, warnings: warningsFor(flags) };
}
