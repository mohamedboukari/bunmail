import type Mail from "nodemailer/lib/mailer";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail, redactEmailsInText } from "../../../utils/redact.ts";
import { withMxLock } from "../../../utils/mx-throttle.ts";
import { parseRecipients, groupByDomain } from "../../../utils/recipients.ts";
import { classifySendFailure } from "../../../utils/smtp-error.ts";
import { mintReturnPath, recipientOrder } from "../../bounces/services/return-path.ts";
import { filterCustomHeaders } from "./custom-headers.ts";
import { composeMessageBody } from "./message-body.ts";
import { providerBucket } from "./provider-bucket.ts";
import { mxRateBudget, type RateBudget } from "./rate-budget.ts";
import {
  runMxSession,
  type RejectedRecipient,
  type VerifiedTls,
} from "./mx-transport.ts";
import {
  deliverWithFailover,
  resolveMxRoute,
  type MxAdmit,
  type MxRoute,
  type RoutedOutcome,
} from "./mx-route.ts";
import {
  discoverMtaStsPolicy,
  matchingMxHosts,
  mtaStsCache,
  mtaStsTrustAnchors,
  type ActiveMtaStsPolicy,
} from "./mta-sts.ts";
import type {
  CustomHeaders,
  DeliveryGroup,
  DeliveryMtaSts,
  DeliveryState,
} from "../models/email.schema.ts";
import type { EmailCategory } from "../types/email.types.ts";

/**
 * Result of a `sendMail` call. The `messageId` is the canonical
 * `Message-ID:` header: set by the caller (queue), pinned to every
 * MX group's submission, and preserved across retries so feedback
 * loops join on a single identifier.
 *
 * `deliveryState` is the per-group outcome map (#97). The mailer
 * doesn't decide whether to schedule another retry: that's the
 * queue's call. The mailer just reports what each group's status is
 * **after this attempt** so the queue can apply its retry policy.
 */
export interface SendMailResult {
  messageId: string;
  deliveryState: DeliveryState;
  /**
   * Entries not attempted because their provider bucket's rate budget
   * (`MAIL_MX_RATE_PER_MIN`, #250) was spent: their keys, left unchanged in
   * `deliveryState` (still `retry`), and the shortest wait until one of
   * their buckets has a token again. Absent when nothing was deferred.
   */
  deferred?: { keys: string[]; waitMs: number };
}

/**
 * Headers covered by the DKIM signature. Setting `headerFieldNames`
 * replaces nodemailer's default list, so the defaults are restated, plus
 * `List-Unsubscribe-Post` (RFC 8058 requires it to be signed for one-click
 * unsubscribe, which Gmail and Yahoo rely on) and `Feedback-ID`. Listing a
 * header that a message doesn't have costs nothing.
 */
export const DKIM_SIGNED_HEADERS = [
  "From",
  "Sender",
  "Reply-To",
  "Subject",
  "Date",
  "Message-ID",
  "To",
  "Cc",
  "MIME-Version",
  "Content-Type",
  "Content-Transfer-Encoding",
  "Content-ID",
  "Content-Description",
  "Resent-Date",
  "Resent-From",
  "Resent-Sender",
  "Resent-To",
  "Resent-Cc",
  "Resent-Message-ID",
  "In-Reply-To",
  "References",
  "List-Id",
  "List-Help",
  "List-Unsubscribe",
  "List-Unsubscribe-Post",
  "List-Subscribe",
  "List-Post",
  "List-Owner",
  "List-Archive",
  "Feedback-ID",
].join(":");

/** DKIM signing options passed from the queue processor. */
export interface DkimOptions {
  domainName: string;
  keySelector: string;
  privateKey: string;
}

/**
 * Inputs for the `List-Unsubscribe` header. Both fields optional:
 * the mailer emits the mailto form (defaulting to
 * `unsubscribe@<from-domain>` when `mailto` is omitted, left out when it
 * is `null`), and adds the HTTPS / `List-Unsubscribe-Post: One-Click`
 * form whenever a URL is provided. The queue builds them per email
 * (`list-unsubscribe.ts`, #249).
 */
export interface UnsubscribeOptions {
  /** `null`: no mailto form (only valid together with `url`). */
  mailto?: string | null;
  url?: string;
}

/**
 * Sends a single email row to its full recipient set.
 *
 * **Stateful retry (#97):** the mailer reads `existingState` when
 * provided (set by the queue on retry passes) and **skips every group
 * already in `sent` status**, so a Gmail group that succeeded on
 * attempt 1 never gets a duplicate on attempt 2 when an Outlook group
 * 4xx-retries. Returns a fresh `DeliveryState` reflecting every
 * group's outcome **after this attempt**. The queue decides whether
 * to schedule another pass based on the returned state vs its own
 * retry policy.
 *
 * **Status semantics:**
 *   - `sent`: accepted by the receiving MX this attempt. Won't be retried.
 *   - `retry`: transient failure (4xx, transport timeout, …). Queue may retry.
 *   - `failed`: hard 5xx rejection. Terminal; auto-suppress fires in queue.
 *
 * **First-send vs retry:** on first send (`existingState` undefined),
 * the mailer parses `to/cc/bcc`, groups by recipient domain, and starts
 * every group in `retry` before attempting.
 *
 * **Routing (#250):** every attempt resolves each pending domain's MX set
 * again ({@link resolveMxRoute}): NXDOMAIN, a null MX, or no MX and no
 * address records fail the group; a temporary DNS error leaves it in
 * `retry`; no MX records means the implicit MX (the domain's own A/AAAA).
 * The group then goes to the hosts in preference order, failing over on
 * connection-level errors and `421` only ({@link deliverWithFailover}).
 *
 * **MTA-STS (#250):** each pending domain's policy is discovered alongside
 * its MX set ({@link discoverMtaStsPolicy}). In `enforce` mode only the MX
 * hosts the policy names are tried, over required and verified TLS; no
 * matching host, or a TLS or certificate failure, leaves the group in
 * `retry` (never a bounce), and the retry window gives the RFC's eventual
 * failure. In `testing` mode the group is delivered as without a policy,
 * and what enforce mode would have refused is logged once per policy.
 * The mode is recorded on each entry (`mtaSts`).
 *
 * **Signed return paths (#236):** with `returnPath`, a pending group of
 * several recipients is split into one entry per recipient, and each is
 * its own SMTP transaction whose `MAIL FROM` is that recipient's signed
 * return path. The transactions of one MX share one connection. Outcomes,
 * failure classification and retries are then per recipient.
 *
 * **Throttle and rate budget (#250):** sessions are throttled per provider
 * bucket (`provider-bucket.ts`), not per MX host name. With
 * `MAIL_MX_RATE_PER_MIN`, an entry whose bucket has no token left is not
 * attempted: it stays as it was (no attempt counted, no error), and the
 * result's `deferred` lists it with the wait until a token is due. Entries
 * of other buckets go ahead.
 *
 * **Partial `RCPT TO` rejections (#250):** when a transaction of several
 * recipients is accepted for some and refused for others, the accepted
 * ones are `sent`, and each refused one gets its own entry (keyed
 * `<group key>#<recipient index>`), classified from its own reply: `retry`
 * for a 4xx, `failed` for a 5xx.
 *
 * **Body (#250):** composed once per call ({@link composeMessageBody}): an
 * HTML fragment gets a minimal document wrapper, and HTML without a text
 * part gets a text alternative derived from it. Neither is stored.
 *
 * **Identity:** the caller passes `messageId` so the canonical
 * `Message-ID:` header is pinned across retries. Previously the
 * mailer minted it itself, which would have produced fresh ids per
 * retry: bounce / complaint correlation breaks down without a
 * stable identifier.
 */
export async function sendMail(options: {
  from: string;
  /**
   * Display name for the `From:` header (#250), already checked
   * (`from-name.ts`). `from` stays the bare address: envelope, DKIM
   * domain, return path.
   */
  fromName?: string | null;
  to: string;
  cc?: string | null;
  bcc?: string | null;
  /** Reply-To header (#169). Same on every MX group; not part of the envelope. */
  replyTo?: string | null;
  subject: string;
  html?: string | null;
  text?: string | null;
  /** Canonical Message-ID, set by the caller so retries reuse it. */
  messageId: string;
  /**
   * Custom headers stored on the email (#177). Re-checked here (see
   * {@link safeCustomHeaders}) so a row that bypassed `createEmail` can
   * never override BunMail's own headers or split a header line.
   */
  headers?: CustomHeaders | null;
  /** Prior delivery state when this is a retry pass; undefined on first send. */
  existingState?: DeliveryState | null;
  dkim?: DkimOptions;
  unsubscribe?: UnsubscribeOptions;
  /**
   * Who the mail is sent for, for the `Feedback-ID` header (#250). Typed,
   * never caller-supplied text: BunMail builds the header itself.
   */
  feedback?: FeedbackSource;
  /**
   * BunMail's own automatic mail (inbound notifications, invitations,
   * sign-in alerts): adds `Auto-Submitted: auto-generated` and
   * `X-Auto-Response-Suppress: All` so auto-responders don't reply (#250),
   * and never `List-Unsubscribe` ({@link carriesListUnsubscribe}).
   */
  autoSubmitted?: boolean;
  /**
   * `transactional` mail is sent without `List-Unsubscribe` (#250).
   * `marketing` and unset behave as before: the queue's `unsubscribe`
   * options decide the header.
   */
  category?: EmailCategory | null;
  /**
   * Signed per-recipient return paths (#236): set by the queue when inbound
   * SMTP is enabled, the only setup where a DSN can reach BunMail. Each
   * recipient then gets its own SMTP transaction with envelope sender
   * `b+<id>.<index>.<MAC>@<sender domain>`. Absent: the envelope sender
   * is the From address and each MX gets one transaction, as before.
   */
  returnPath?: { emailId: string };
}): Promise<SendMailResult> {
  /** Build the starting state: either a fresh one from the inputs
   *  or a deep clone of the row's prior state. We always clone so the
   *  caller can compare `before` vs `after` for change detection. */
  let state: DeliveryState = options.existingState
    ? withDomains(structuredClone(options.existingState))
    : buildInitialState(options.to, options.cc, options.bcc);

  if (Object.keys(state).length === 0) {
    /** No groups at all (no valid recipients after parsing). Treat as
     *  programmer error: the caller shouldn't have reached this code
     *  path. The queue's full-failure path catches the throw. */
    throw new Error("No valid recipients after parsing to/cc/bcc");
  }

  logger.info("Sending email via SMTP", {
    from: redactEmail(options.from),
    groupCount: Object.keys(state).length,
    pendingCount: Object.values(state).filter((g) => g.status === "retry").length,
    subject: options.subject,
    dkim: options.dkim ? options.dkim.domainName : "none",
    messageId: options.messageId,
    retry: options.existingState ? "yes" : "no",
    returnPath: options.returnPath ? "signed" : "plain",
  });

  const customHeaders = safeCustomHeaders(options.headers, options.messageId);

  /** Wrapper and text alternative (#250): once per call, the same for every transaction. */
  const body = composeMessageBody(options.html ?? null, options.text ?? null);
  if (body.wrapped || body.textDerived) {
    logger.debug("Message body composed", {
      messageId: options.messageId,
      wrapped: body.wrapped,
      textDerived: body.textDerived,
    });
  }

  /**
   * Signed return paths (#236): one entry, and later one SMTP transaction,
   * per recipient, each with its own envelope sender. Groups already
   * `sent` or `failed` are left as they are.
   */
  const returnPaths = options.returnPath
    ? returnPathsFor(
        options.returnPath.emailId,
        options.from,
        options.to,
        options.cc,
        options.bcc,
      )
    : null;
  if (returnPaths) state = splitPerRecipient(state, returnPaths);

  /** Recipient indexes, for the keys of entries split by a partial rejection. */
  const order = recipientOrder(options.to, options.cc, options.bcc);

  /** Pending entries by recipient domain; insertion order keeps logs stable. */
  const pendingByDomain = new Map<string, string[]>();
  for (const [key, group] of Object.entries(state)) {
    if (group.status !== "retry" || group.domain === undefined) continue;
    const keys = pendingByDomain.get(group.domain) ?? [];
    keys.push(key);
    pendingByDomain.set(group.domain, keys);
  }

  /**
   * Each domain resolved once per attempt, in parallel, never cached
   * (#250), its MTA-STS policy discovered alongside (cached per its `id`
   * and `max_age`, see `mta-sts.ts`).
   */
  const routes = new Map(
    await Promise.all(
      [...pendingByDomain.keys()].map(async (domain) => {
        const [route, policy] = await Promise.all([
          resolveMxRoute(domain),
          discoverMtaStsPolicy(domain, { allowPrivate: config.mail.allowPrivateMx }),
        ]);
        return [domain, { route, policy }] as const;
      }),
    ),
  );
  /** The MTA-STS mode each domain is delivered under, recorded on its entries. */
  const mtaStsByDomain = new Map<string, DeliveryMtaSts | null>();
  const mtaStsOf = (key: string): DeliveryMtaSts | null => {
    const domain = state[key]?.domain;
    return domain === undefined ? null : (mtaStsByDomain.get(domain) ?? null);
  };

  /**
   * Sessions: the entries of every domain that resolved to the same hosts,
   * in the same order, go out together, one transaction each. Without
   * return paths a domain normally has one entry, so one transaction per
   * domain; with them, one per recipient.
   */
  const sessions = new Map<string, MxSessionPlan>();
  for (const [domain, keys] of pendingByDomain) {
    const resolved = routes.get(domain);
    if (!resolved) continue;
    const { route, policy } = resolved;
    const mtaSts = mtaStsModeOf(policy);
    mtaStsByDomain.set(domain, mtaSts);
    if (route.kind !== "hosts") {
      for (const key of keys) {
        recordUnsent(
          state,
          key,
          route,
          mtaSts,
          options.messageId,
          "Recipient domain not routable",
        );
      }
      continue;
    }
    if (route.implicit) {
      logger.debug("No MX records: delivering to the domain's own address", { domain });
    }
    const hosts = policyHosts(domain, route.hosts, policy);
    if (hosts.length === 0) {
      /** Enforce mode and no MX host the policy names: nothing is connected to. */
      const unsent = {
        kind: "retry" as const,
        error: `${domain}: no MX host matches the MTA-STS policy; will retry`,
      };
      for (const key of keys) {
        recordUnsent(
          state,
          key,
          unsent,
          mtaSts,
          options.messageId,
          "No MX host matches the MTA-STS policy",
        );
      }
      continue;
    }
    const verifiedTls = mtaSts === "enforce";
    /** Enforced domains never share a session with unverified ones. */
    const id = `${verifiedTls ? "mta-sts " : ""}${hosts.join(" ")}`;
    const plan = sessions.get(id) ?? {
      hosts,
      domains: [],
      transactions: [],
      verifiedTls,
    };
    plan.domains.push(domain);
    for (const key of keys) {
      const group = state[key];
      if (!group) continue;
      plan.transactions.push({
        key,
        recipients: group.recipients,
        envelopeFrom: envelopeSenderFor(group.recipients, returnPaths, options.from),
      });
    }
    sessions.set(id, plan);
  }

  /** Entries deferred by the rate budget, and the shortest wait among them. */
  const deferredKeys: string[] = [];
  let deferredWaitMs = Number.POSITIVE_INFINITY;
  for (const plan of sessions.values()) {
    const outcomes = await sendToMxHosts(plan, {
      from: options.from,
      fromName: options.fromName ?? null,
      headerTo: options.to,
      headerCc: options.cc ?? null,
      replyTo: options.replyTo ?? null,
      subject: options.subject,
      html: body.html,
      text: body.text,
      messageId: options.messageId,
      headers: customHeaders,
      dkim: options.dkim,
      unsubscribe: options.unsubscribe,
      feedback: options.feedback,
      autoSubmitted: options.autoSubmitted === true,
      category: options.category ?? null,
    });
    for (const outcome of outcomes) {
      if (outcome.deferredMs !== undefined) {
        /** Not attempted: the entry stays exactly as it was. */
        deferredKeys.push(outcome.key);
        deferredWaitMs = Math.min(deferredWaitMs, outcome.deferredMs);
        continue;
      }
      const domain = state[outcome.key]?.domain;
      const policy = domain === undefined ? null : (routes.get(domain)?.policy ?? null);
      if (
        domain !== undefined &&
        policy?.policy.mode === "testing" &&
        outcome.tls === "plaintext"
      ) {
        warnTestingPolicy(domain, policy, "the MX host did not offer STARTTLS");
      }
      recordOutcome(state, outcome, options.messageId, order, mtaStsOf(outcome.key));
    }
  }

  if (deferredKeys.length > 0) {
    logger.debug("MX rate budget deferred entries", {
      messageId: options.messageId,
      deferred: deferredKeys.length,
      waitMs: deferredWaitMs,
    });
    return {
      messageId: options.messageId,
      deliveryState: state,
      deferred: { keys: deferredKeys, waitMs: deferredWaitMs },
    };
  }
  return { messageId: options.messageId, deliveryState: state };
}

/**
 * Builds the initial state for a fresh send: one entry per recipient
 * domain (#250), keyed by the domain, at `status: "retry"` so the attempt
 * loop picks it up. No DNS here: each attempt resolves the domains itself.
 */
function buildInitialState(
  to: string,
  cc: string | null | undefined,
  bcc: string | null | undefined,
): DeliveryState {
  const state: DeliveryState = {};
  for (const [domain, rcpts] of groupByDomain(parseRecipients(to, cc, bcc))) {
    state[domain] = {
      status: "retry",
      recipients: rcpts.map((r) => r.address),
      attempts: 0,
      domain,
    };
  }
  return state;
}

/** The lowercased domain of an address. */
function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * Gives every pending entry written before #250 its recipient domain, so
 * it is routed like a new one. Such an entry is keyed by its MX, which is
 * kept as its last known `mxHost`; one whose recipients span several
 * domains (two domains that shared an MX) is split into one entry per
 * domain, keyed `<old key>|<domain>`. Other entries are unchanged.
 */
function withDomains(state: DeliveryState): DeliveryState {
  const next: DeliveryState = {};
  for (const [key, group] of Object.entries(state)) {
    if (
      group.status !== "retry" ||
      group.domain !== undefined ||
      key.startsWith("<dns:") ||
      group.recipients.length === 0
    ) {
      next[key] = group;
      continue;
    }
    const byDomain = new Map<string, string[]>();
    for (const recipient of group.recipients) {
      const domain = domainOf(recipient);
      byDomain.set(domain, [...(byDomain.get(domain) ?? []), recipient]);
    }
    const mxHost = group.mxHost ?? key;
    if (byDomain.size === 1) {
      next[key] = { ...group, domain: domainOf(group.recipients[0] ?? ""), mxHost };
      continue;
    }
    for (const [domain, recipients] of byDomain) {
      next[`${key}|${domain}`] = { ...group, recipients, domain, mxHost };
    }
  }
  return next;
}

/** A recipient's return-path index and address (#236); `address` is null when none could be minted. */
interface RecipientReturnPath {
  index: number;
  address: string | null;
}

/** Return paths of an email, by lowercased recipient (#236). */
type ReturnPaths = Map<string, RecipientReturnPath>;

/**
 * Mints the signed return path of every recipient of an email (#236), in
 * the documented recipient order (`recipientOrder`). A recipient that gets
 * none (an email id not in the `msg_` shape, which the queue never sends)
 * keeps the plain envelope sender; that is logged, since a DSN for it will
 * have no effect.
 */
function returnPathsFor(
  emailId: string,
  from: string,
  to: string,
  cc: string | null | undefined,
  bcc: string | null | undefined,
): ReturnPaths {
  const senderDomain = from.slice(from.lastIndexOf("@") + 1);
  const paths: ReturnPaths = new Map();
  let unsigned = 0;
  recipientOrder(to, cc, bcc).forEach((recipient, index) => {
    const address = mintReturnPath({ emailId, index, recipient }, senderDomain);
    if (address === null) unsigned += 1;
    paths.set(recipient, { index, address });
  });
  if (unsigned > 0) {
    logger.warn("Signed return path unavailable: plain envelope sender used", {
      emailId,
      recipients: unsigned,
    });
  }
  return paths;
}

/**
 * Splits every pending group of several recipients into one entry per
 * recipient (#236), keyed `<group key>#<recipient index>` (the group key
 * is the domain, or the MX on an entry from before #250), so each
 * recipient is its own SMTP transaction and keeps its own outcome and
 * retries. Groups already `sent` or `failed`, and single-recipient groups,
 * are kept unchanged (a single-recipient email stays one entry keyed by
 * its domain, as without return paths).
 */
function splitPerRecipient(
  state: DeliveryState,
  returnPaths: ReturnPaths,
): DeliveryState {
  const next: DeliveryState = {};
  for (const [key, group] of Object.entries(state)) {
    if (
      group.status !== "retry" ||
      group.recipients.length <= 1 ||
      key.startsWith("<dns:")
    ) {
      next[key] = group;
      continue;
    }
    group.recipients.forEach((recipient, position) => {
      const index = returnPaths.get(recipient.toLowerCase())?.index;
      const entryKey = index === undefined ? `${key}#u${position}` : `${key}#${index}`;
      next[entryKey] = { ...group, recipients: [recipient] };
    });
  }
  return next;
}

/**
 * The envelope sender of one transaction: the recipient's signed return
 * path when return paths are on and the transaction has exactly one
 * recipient (#236), else the From address.
 */
function envelopeSenderFor(
  recipients: string[],
  returnPaths: ReturnPaths | null,
  from: string,
): string {
  const only = recipients.length === 1 ? recipients[0] : undefined;
  if (!returnPaths || only === undefined) return from;
  return returnPaths.get(only.toLowerCase())?.address ?? from;
}

/** The mode recorded on entries: `enforce` or `testing`, else `null` (no policy, or `none`). */
function mtaStsModeOf(policy: ActiveMtaStsPolicy | null): DeliveryMtaSts | null {
  const mode = policy?.policy.mode;
  return mode === "enforce" || mode === "testing" ? mode : null;
}

/**
 * The MX hosts to try for `domain` under its MTA-STS policy (#250): in
 * `enforce` mode only those matching a policy pattern, in their order
 * (none: the caller retries without connecting); otherwise all of them.
 * In `testing` mode, no matching host is what enforce would have refused,
 * which is logged once per policy.
 */
function policyHosts(
  domain: string,
  hosts: string[],
  policy: ActiveMtaStsPolicy | null,
): string[] {
  if (policy === null || policy.policy.mode === "none") return hosts;
  const matching = matchingMxHosts(hosts, policy.policy);
  if (policy.policy.mode === "testing") {
    if (matching.length === 0) {
      warnTestingPolicy(domain, policy, "no MX host matches the policy");
    }
    return hosts;
  }
  if (matching.length < hosts.length) {
    logger.debug("MX hosts outside the MTA-STS policy not tried", {
      domain,
      policyId: policy.id,
      skipped: hosts.filter((host) => !matching.includes(host)),
    });
  }
  return matching;
}

/**
 * Logs, once per domain and policy `id`, that a `testing` policy would
 * have failed this delivery in enforce mode (#250). BunMail sends no
 * TLS-RPT report, so the operator's log is where this shows.
 */
function warnTestingPolicy(
  domain: string,
  policy: ActiveMtaStsPolicy,
  reason: string,
): void {
  if (!mtaStsCache().firstWarning(domain, policy.id)) return;
  logger.warn("MTA-STS testing policy would fail in enforce mode", {
    domain,
    policyId: policy.id,
    reason,
  });
}

/** Everything one MX group's message is built from. */
interface MxGroupMessage {
  /** RCPT TO for this group only. */
  recipients: string[];
  from: string;
  /** Display name of the `From:` header (#250); the address is always `from`. */
  fromName?: string | null;
  /**
   * `MAIL FROM` of this transaction: the recipient's signed return path
   * (#236). Defaults to `from`. The `From:` header is always `from`.
   */
  envelopeFrom?: string;
  headerTo: string;
  headerCc: string | null;
  replyTo: string | null;
  subject: string;
  html: string | null;
  text: string | null;
  messageId: string;
  /** Custom headers (#177), already passed through {@link safeCustomHeaders}. */
  headers: CustomHeaders;
  dkim?: DkimOptions;
  unsubscribe?: UnsubscribeOptions;
  /** For the `Feedback-ID` header (#250). */
  feedback?: FeedbackSource;
  /** BunMail's own automatic mail: `Auto-Submitted` and friends (#250). */
  autoSubmitted?: boolean;
  /** `transactional`: no `List-Unsubscribe` (#250). */
  category?: EmailCategory | null;
}

/** What a `Feedback-ID` header identifies (#250). */
export interface FeedbackSource {
  /** How the mail entered BunMail: `api`, `smtp` or `system`. */
  source: "api" | "smtp" | "system";
  /** The sending API key; `null` for BunMail's own mail. */
  apiKeyId: string | null;
}

/** Keeps a `Feedback-ID` field to safe characters (it is a header value). */
function feedbackField(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64) || "none";
}

/**
 * `Feedback-ID: <source>:<key>:<sender domain>:bunmail` (#250): Gmail's
 * feedback loop aggregates complaints by it. Low cardinality on purpose
 * (no per-message id, which would defeat the aggregation). The API key
 * id goes in hashed, so recipients see a stable per-tenant value but no
 * internal identifier. The id is not a secret, so a fast deterministic
 * non-cryptographic hash (`Bun.hash`, wyhash) is all this tag needs.
 */
export function feedbackIdHeader(feedback: FeedbackSource, senderDomain: string): string {
  const key = feedback.apiKeyId
    ? Bun.hash(feedback.apiKeyId).toString(16).padStart(16, "0").slice(0, 12)
    : "system";
  return [feedback.source, key, senderDomain, "bunmail"].map(feedbackField).join(":");
}

/**
 * Re-applies the custom-header rules (#177) to the headers stored on a
 * row: the send API already refused anything invalid, so this only drops
 * something when a row was written another way (a manual insert, a future
 * bug). It is what guarantees a custom header never overrides
 * `Message-ID`, `List-Unsubscribe` or any other reserved header, whatever
 * its case. Logs the dropped names only, never values.
 */
function safeCustomHeaders(
  headers: CustomHeaders | null | undefined,
  messageId: string,
): CustomHeaders {
  if (!headers) return {};
  const { headers: kept, dropped } = filterCustomHeaders(Object.entries(headers));
  if (dropped.length > 0) {
    logger.warn("Stored custom headers dropped before sending", {
      messageId,
      dropped: dropped.map((d) => ({ name: d.name, problem: d.problem })),
    });
  }
  return kept;
}

/**
 * Whether a message carries `List-Unsubscribe` (#250): not when it is
 * `transactional`, and never on BunMail's own automatic mail (invitations,
 * alerts, inbound notifications), which nobody subscribed to.
 */
export function carriesListUnsubscribe(
  args: Pick<MxGroupMessage, "category" | "autoSubmitted">,
): boolean {
  return args.category !== "transactional" && args.autoSubmitted !== true;
}

/**
 * Builds the Nodemailer options for one MX group's message: headers,
 * envelope, the custom headers (#177), `List-Unsubscribe`, DKIM. The body
 * is used as given: `sendMail` composes it first ({@link composeMessageBody}).
 * Pure, so tests can render the exact message with a stream transport.
 */
export function buildMailOptions(args: MxGroupMessage): Mail.Options {
  const mailOptions: Mail.Options = {
    /**
     * With a display name (#250), Nodemailer quotes it and RFC 2047-encodes
     * it when it is not ASCII. The address, and the envelope below, stay
     * the bare `from`.
     */
    from: args.fromName ? { name: args.fromName, address: args.from } : args.from,
    /** Headers carry the *original* recipient lists so each recipient
     *  sees who else was addressed. The actual RCPT TO list is the
     *  envelope override below. */
    to: args.headerTo,
    cc: args.headerCc ?? undefined,
    replyTo: args.replyTo ?? undefined,
    subject: args.subject,
    html: args.html ?? undefined,
    text: args.text ?? undefined,
    messageId: args.messageId,
    envelope: {
      from: args.envelopeFrom ?? args.from,
      to: args.recipients,
    },
  };

  /**
   * Extra headers: the custom ones (#177) first, then BunMail's own
   * `List-Unsubscribe` pair, which is written last so it wins on the same
   * key. The reserved-name filter already keeps every name BunMail sets
   * (in any case) out of the custom set, and Nodemailer's own options
   * (`messageId`, `from`, ...) take precedence over `headers` anyway.
   */
  const headers: Record<string, string> = { ...args.headers };

  /** `List-Unsubscribe` (+ optional `One-Click` POST). Same content
   *  across groups: the header is about the message, not the
   *  recipient set. */
  const senderDomain = args.from.split("@")[1];
  if (senderDomain && carriesListUnsubscribe(args)) {
    /**
     * Strip any CR/LF from the unsubscribe mailto/url before they go into a
     * header value (#133, header-injection defense-in-depth). These come
     * from the operator-set domain record, so this is belt-and-braces, but
     * a stray newline must never split the header.
     */
    const stripCrlf = (v: string): string => v.replace(/[\r\n]/g, "");
    const url = args.unsubscribe?.url ? stripCrlf(args.unsubscribe.url) : undefined;
    /** No mailto only when asked for and a URL is there: the header is never empty. */
    const mailto =
      args.unsubscribe?.mailto === null && url
        ? null
        : stripCrlf(args.unsubscribe?.mailto ?? `unsubscribe@${senderDomain}`);
    headers["List-Unsubscribe"] = [
      ...(mailto === null ? [] : [`<mailto:${mailto}>`]),
      ...(url ? [`<${url}>`] : []),
    ].join(", ");
    if (url) headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  if (senderDomain && args.feedback) {
    headers["Feedback-ID"] = feedbackIdHeader(args.feedback, senderDomain);
  }
  if (args.autoSubmitted) {
    headers["Auto-Submitted"] = "auto-generated";
    headers["X-Auto-Response-Suppress"] = "All";
  }
  if (Object.keys(headers).length > 0) mailOptions.headers = headers;

  if (args.dkim) {
    mailOptions.dkim = {
      domainName: args.dkim.domainName,
      keySelector: args.dkim.keySelector,
      privateKey: args.dkim.privateKey,
      headerFieldNames: DKIM_SIGNED_HEADERS,
    };
  }

  return mailOptions;
}

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
interface MxSessionPlan {
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
async function sendToMxHosts(
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
      runMxSession({
        ...session,
        heloName: config.mail.hostname,
        ...(plan.verifiedTls ? { verifiedTls: verifiedTlsOptions() } : {}),
      }),
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

/** Verified TLS for an enforce-mode session: the system trust store, or the test CA. */
function verifiedTlsOptions(): VerifiedTls {
  const ca = mtaStsTrustAnchors();
  return ca === undefined ? {} : { ca };
}

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
function recordUnsent(
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
function recordOutcome(
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
