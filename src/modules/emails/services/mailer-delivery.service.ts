import { SpanKind, SpanStatusCode, type Span } from "@opentelemetry/api";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { spanSafeMessage, withSpan } from "../../../utils/tracing.ts";
import { withMxLock } from "../../../utils/mx-throttle.ts";
import { providerBucket } from "./provider-bucket.ts";
import { mxRateBudget, type RateBudget } from "./rate-budget.ts";
import { runMxSession, type MxSessionOutcome } from "./mx-transport.ts";
import { deliverWithFailover, type MxAdmit, type RoutedOutcome } from "./mx-route.ts";
import { buildMailOptions, type MxGroupMessage } from "./mailer-message.service.ts";
import { verifiedTlsOptions } from "./mailer-mta-sts.service.ts";

/** One SMTP transaction to an MX: a delivery-state entry and its envelope. */
interface MxTransaction {
  /** Key of the entry in the delivery state. */
  key: string;
  /** RCPT TO of this transaction. */
  recipients: string[];
  /** MAIL FROM of this transaction. */
  envelopeFrom: string;
}

/** The parts of the message that are the same in every transaction. */
type MessageParts = Omit<MxGroupMessage, "recipients" | "envelopeFrom">;

/** The pending transactions of one or more domains that share their MX hosts. */
export interface MxSessionPlan {
  /** The MX hosts, in the order to try them (only the policy's in enforce mode). */
  hosts: string[];
  /** The recipient domains, for log lines. */
  domains: string[];
  transactions: MxTransaction[];
  /** The domains' MTA-STS policy is in enforce mode: required, verified TLS (#250). */
  verifiedTls: boolean;
}

/**
 * Submits the message to the plan's MX hosts (#250), one SMTP transaction
 * per entry. The `envelope.to` override pins RCPT TO to the entry's
 * recipients, even when the `To:`/`Cc:` headers list the full original
 * set: that's what makes cross-domain CC visible to all recipients without
 * delivering to the wrong server. With signed return paths (#236) each
 * entry is one recipient with its own `MAIL FROM`, so a co-recipient never
 * sees another recipient's return path; the entries share one connection.
 *
 * {@link deliverWithFailover} tries the hosts in order, each through the
 * address check (`resolveMxAddresses`: connect to a checked address, not
 * the name, whose DNS answer the recipient domain's owner controls; the
 * MX name still goes to TLS as SNI), in the `MAIL_IP_FAMILY` order (#250).
 * Each session ({@link runMxSession}: one pooled connection, TLS record,
 * deadline, the connection closed however it ends) runs under the throttle
 * (#91) of the provider bucket of the host it connects to (#250), released
 * before the next host is tried, and takes its rate tokens there
 * ({@link admitFor}). An enforced MTA-STS plan (#250) requires verified TLS
 * on every session.
 *
 * Never throws: every entry gets an outcome.
 */
export async function sendToMxHosts(
  plan: MxSessionPlan,
  message: MessageParts,
): Promise<RoutedOutcome[]> {
  /**
   * One `mx.deliver` span per group (#363), with an `mx.session` child per
   * connection tried. Host names, TLS and counts only: never a recipient
   * address or domain, never the message.
   */
  return withSpan(
    "mx.deliver",
    {
      attributes: {
        "bunmail.mx.host_count": plan.hosts.length,
        "bunmail.mx.transaction_count": plan.transactions.length,
        "bunmail.mx.recipient_count": plan.transactions.reduce(
          (sum, t) => sum + t.recipients.length,
          0,
        ),
        "bunmail.mx.verified_tls": plan.verifiedTls,
      },
    },
    async (span) => {
      const outcomes = await deliverToMxHosts(plan, message);
      recordDeliverySpan(span, outcomes);
      return outcomes;
    },
  );
}

/**
 * Sets the outcome of an `mx.deliver` or `mx.session` span (#363): the MX
 * host and TLS of the first outcome that has them, how many transactions
 * were delivered, failed or deferred, and, when any failed, an error
 * status with the first failure's sanitized text.
 */
function recordDeliverySpan(
  span: Span,
  outcomes: readonly (MxSessionOutcome &
    Partial<Pick<RoutedOutcome, "mxHost" | "deferredMs">>)[],
): void {
  const host = outcomes.find((o) => typeof o.mxHost === "string")?.mxHost;
  if (typeof host === "string") span.setAttribute("server.address", host);
  const tls = outcomes.find((o) => o.tls !== null)?.tls;
  if (typeof tls === "string") span.setAttribute("bunmail.mx.tls", tls);
  const deferred = outcomes.filter((o) => o.deferredMs !== undefined);
  const failed = outcomes.filter((o) => o.error !== undefined);
  span.setAttribute(
    "bunmail.mx.delivered",
    outcomes.length - deferred.length - failed.length,
  );
  span.setAttribute("bunmail.mx.failed", failed.length);
  span.setAttribute("bunmail.mx.deferred", deferred.length);
  const firstFailure = failed[0];
  if (firstFailure !== undefined) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: spanSafeMessage(firstFailure.error),
    });
  }
}

/** {@link sendToMxHosts} without its span. */
async function deliverToMxHosts(
  plan: MxSessionPlan,
  message: MessageParts,
): Promise<RoutedOutcome[]> {
  return deliverWithFailover({
    domain: plan.domains.join(","),
    hosts: plan.hosts,
    allowPrivate: config.mail.allowPrivateMx,
    transactions: plan.transactions.map((transaction) => ({
      key: transaction.key,
      mail: buildMailOptions({
        ...message,
        recipients: transaction.recipients,
        envelopeFrom: transaction.envelopeFrom,
      }),
    })),
    bucketOf: (mxHost) => {
      const bucket = providerBucket(mxHost);
      logger.debug("MX throttle bucket", { mxHost, bucket });
      return bucket;
    },
    lock: (bucket, fn) => withMxLock(bucket, config.mail.mxConcurrency, fn),
    admit: admitFor(mxRateBudget(config.mail.mxRatePerMin)),
    ipFamily: config.mail.ipFamily,
    runSession: (session) =>
      withSpan(
        "mx.session",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "server.address": session.mxHost,
            "server.port": session.port,
            /** The MX's own IP address, which the session connected to. */
            "network.peer.address": session.address,
            "bunmail.mx.transaction_count": session.transactions.length,
          },
        },
        async (span) => {
          const outcomes = await runMxSession({
            ...session,
            heloName: config.mail.hostname,
            ...(plan.verifiedTls ? { verifiedTls: verifiedTlsOptions() } : {}),
          });
          recordDeliverySpan(span, outcomes);
          return outcomes;
        },
      ),
  });
}

/**
 * The rate-budget check of a session (#250), or none without a budget:
 * takes the bucket's tokens, and logs at `info`, once a minute per bucket,
 * that the budget held messages back.
 */
function admitFor(budget: RateBudget | null): MxAdmit | undefined {
  if (budget === null) return undefined;
  return (bucket, count) => {
    const grant = budget.take(bucket, count);
    if (grant.granted < count && budget.shouldLog(bucket)) {
      logger.info("MX rate budget reached: deferring", {
        bucket,
        ratePerMin: budget.ratePerMin,
        deferred: count - grant.granted,
        waitMs: grant.waitMs,
      });
    }
    return grant;
  };
}
