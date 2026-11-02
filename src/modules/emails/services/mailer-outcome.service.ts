import { logger } from "../../../utils/logger.ts";
import { redactEmail, redactEmailsInText } from "../../../utils/redact.ts";
import { classifySendFailure } from "../../../utils/smtp-error.ts";
import type { RejectedRecipient } from "./mx-transport.ts";
import type { MxRoute, RoutedOutcome } from "./mx-route.ts";
import type {
  DeliveryGroup,
  DeliveryMtaSts,
  DeliveryState,
} from "../models/email.schema.ts";
import { mxDeliveries } from "../../metrics/services/metrics.service.ts";

/** A failure's text, as stored in `lastError`. */
function errorText(err: unknown): string {
  return err instanceof Error
    ? err.message
    : typeof err === "string"
      ? err
      : "Unknown send failure";
}

/**
 * The entry after a failed transaction, for `recipients`. Hard 5xx and
 * policy blocks are terminal `failed` (a block won't clear within the
 * retry window); soft errors (4xx, transport) stay `retry` and follow the
 * queue's backoff. Classified from the SMTP reply only, never from a
 * transport error's text (#250); a classification from an earlier attempt
 * is not carried over.
 */
function failedEntry(
  group: DeliveryGroup,
  recipients: string[],
  err: unknown,
  outcome: {
    tls: DeliveryGroup["tls"];
    mxHost: string | undefined;
    mtaSts: DeliveryMtaSts | null;
    updatedAt: string;
  },
): DeliveryGroup {
  const parsed = classifySendFailure(err);
  const { failureKind: _kind, failureCode: _code, blocked: _blocked, ...rest } = group;
  return {
    ...rest,
    recipients,
    status: parsed?.kind === "hard" || parsed?.kind === "policy" ? "failed" : "retry",
    attempts: group.attempts + 1,
    lastError: errorText(err),
    ...(parsed ? { failureKind: parsed.kind, failureCode: parsed.code } : {}),
    ...(parsed?.kind === "policy" ? { blocked: true } : {}),
    tls: outcome.tls,
    mxHost: outcome.mxHost,
    mtaSts: outcome.mtaSts,
    updatedAt: outcome.updatedAt,
  };
}

/**
 * Records an outcome that sends nothing (#250): `failed` when the domain
 * cannot receive mail, `retry` when the lookup failed for now or, in
 * MTA-STS enforce mode, no MX host matches the policy. No SMTP reply, so
 * no failure classification and no suppression.
 */
export function recordUnsent(
  state: DeliveryState,
  key: string,
  unsent: Exclude<MxRoute, { kind: "hosts" }>,
  mtaSts: DeliveryMtaSts | null,
  messageId: string,
  logMessage: string,
): void {
  const group = state[key];
  if (!group) return;
  const { failureKind: _kind, failureCode: _code, blocked: _blocked, ...rest } = group;
  state[key] = {
    ...rest,
    status: unsent.kind,
    attempts: group.attempts + 1,
    lastError: unsent.error,
    tls: null,
    mtaSts,
    updatedAt: new Date().toISOString(),
  };
  logger.warn(logMessage, {
    domain: group.domain,
    group: key,
    recipientCount: group.recipients.length,
    nextStatus: unsent.kind,
    error: unsent.error,
    messageId,
  });
}

/**
 * Records one transaction's outcome on its entry (#97, #250). An accepted
 * transaction whose MX refused some of its recipients is split: the entry
 * keeps the accepted ones as `sent`, and each refused recipient gets its
 * own entry with its own reply's classification (see {@link failedEntry}),
 * so the queue retries only the 4xx ones and suppresses only the 5xx ones.
 * Every recipient refused is a failed transaction, recorded as a whole.
 */
export function recordOutcome(
  state: DeliveryState,
  outcome: RoutedOutcome,
  messageId: string,
  order: string[],
  /** The recipient domain's MTA-STS mode on this attempt (#250). */
  mtaSts: DeliveryMtaSts | null,
): void {
  const { key, tls } = outcome;
  const group = state[key];
  if (!group) return;
  /** When this outcome happened, and the session's encryption (#250). */
  const updatedAt = new Date().toISOString();
  const mxHost = outcome.mxHost ?? group.mxHost;
  const refused = refusedRecipients(group.recipients, outcome.rejected ?? [], key);
  const accepted = group.recipients.filter(
    (r) => !refused.some((x) => x.recipient === r),
  );

  if (outcome.error === undefined && accepted.length > 0) {
    state[key] = {
      ...group,
      recipients: accepted,
      status: "sent",
      attempts: group.attempts + 1,
      deliveredAt: updatedAt,
      messageId,
      tls,
      mxHost,
      mtaSts,
      updatedAt,
    };
    logger.info("MX group delivered", {
      mxHost,
      group: key,
      recipientCount: accepted.length,
      refusedCount: refused.length,
      messageId,
      tls,
      mtaSts,
    });
    mxDeliveries.inc({ tls: tls ?? "unknown" });
    for (const { recipient, error } of refused) {
      const entryKey = refusedKey(state, key, recipient, order);
      const entry = failedEntry(group, [recipient], error, {
        tls,
        mxHost,
        mtaSts,
        updatedAt,
      });
      state[entryKey] = entry;
      logger.warn("MX refused a recipient", {
        mxHost,
        group: entryKey,
        recipient: redactEmail(recipient),
        nextStatus: entry.status,
        /** The remote reply often quotes the recipient address (#260). */
        error: redactEmailsInText(errorText(error)),
        messageId,
      });
    }
    return;
  }

  /** A failed transaction; an accepted one with nobody left accepted counts as one too. */
  const err = outcome.error ?? refused[0]?.error;
  const entry = failedEntry(group, group.recipients, err, {
    tls,
    mxHost,
    mtaSts,
    updatedAt,
  });
  state[key] = entry;
  logger.warn("MX group send failed", {
    mxHost,
    group: key,
    recipientCount: group.recipients.length,
    nextStatus: entry.status,
    /** The remote reply often quotes the recipient address (#260). */
    error: redactEmailsInText(entry.lastError ?? ""),
    messageId,
    tls,
    mtaSts,
  });
}

/**
 * The entry's recipients an MX refused (#250), matched case-insensitively
 * to the addresses as stored. A refused address that is not one of them
 * (nodemailer normalized it beyond case) is logged and left out.
 */
function refusedRecipients(
  recipients: string[],
  rejected: RejectedRecipient[],
  key: string,
): RejectedRecipient[] {
  const found: RejectedRecipient[] = [];
  let unmatched = 0;
  for (const rejection of rejected) {
    const recipient = recipients.find(
      (r) => r.toLowerCase() === rejection.recipient.toLowerCase(),
    );
    if (recipient === undefined) unmatched += 1;
    else if (!found.some((f) => f.recipient === recipient)) {
      found.push({ recipient, error: rejection.error });
    }
  }
  if (unmatched > 0) {
    logger.warn("MX refused recipients not in the transaction", {
      group: key,
      unmatched,
    });
  }
  return found;
}

/**
 * Key of the entry for a recipient split from `key` by a partial
 * rejection (#250): `<key>#<recipient index>` like a per-recipient entry
 * (#236), with a suffix in the unlikely case it is taken.
 */
function refusedKey(
  state: DeliveryState,
  key: string,
  recipient: string,
  order: string[],
): string {
  const index = order.indexOf(recipient.toLowerCase());
  const base = index >= 0 ? `${key}#${index}` : `${key}#u`;
  let candidate = base;
  for (let n = 1; Object.hasOwn(state, candidate); n += 1) candidate = `${base}.${n}`;
  return candidate;
}
