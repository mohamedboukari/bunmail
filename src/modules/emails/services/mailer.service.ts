/**
 * The mailer's entry module: {@link sendMail} and its result type, plus the
 * rest of the public surface re-exported (#380). The helpers live in one
 * file per concern, beside this one:
 *
 *   - `mailer-message.service.ts`: the message (headers, unsubscribe, Feedback-ID) and its signing
 *   - `dkim-signer.service.ts`: BunMail's own DKIM signer, with over-signed headers (#345)
 *   - `mailer-state.service.ts`: the starting delivery state and signed return paths
 *   - `mailer-mta-sts.service.ts`: the MTA-STS mode, hosts and verified TLS of a domain
 *   - `mailer-delivery.service.ts`: the MX sessions, throttle, rate budget and spans
 *   - `mailer-outcome.service.ts`: recording each transaction's outcome on its entry
 *
 * Importers keep using this module.
 */
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { recipientOrder } from "../../bounces/services/return-path.ts";
import { composeMessageBody } from "./message-body.ts";
import { resolveMxRoute } from "./mx-route.ts";
import { discoverMtaSts, type MtaStsDiscovery } from "./mta-sts.ts";
import { tlsRptPolicyOf } from "../../tls-rpt/services/tls-rpt-classify.ts";
import { observeUnconnectedAttempt } from "../../tls-rpt/services/tls-rpt-observe.service.ts";
import type {
  CustomHeaders,
  DeliveryMtaSts,
  DeliveryState,
} from "../models/email.schema.ts";
import type { EmailCategory } from "../types/email.types.ts";
import {
  safeCustomHeaders,
  signMessage,
  type MessageParts,
  type SignedMessage,
  type DkimOptions,
  type FeedbackSource,
  type MailReport,
  type OutboundAttachment,
  type UnsubscribeOptions,
} from "./mailer-message.service.ts";
import {
  buildInitialState,
  envelopeSenderFor,
  returnPathsFor,
  splitPerRecipient,
  withDomains,
} from "./mailer-state.service.ts";
import {
  mtaStsModeOf,
  policyHosts,
  warnTestingPolicy,
} from "./mailer-mta-sts.service.ts";
import {
  sendToMxHosts,
  type DeliveryLimits,
  type MxSessionPlan,
} from "./mailer-delivery.service.ts";
import { recordOutcome, recordUnsent } from "./mailer-outcome.service.ts";

export {
  DkimSigningFailedError,
  buildMailOptions,
  buildTransactionMails,
  carriesListUnsubscribe,
  feedbackIdHeader,
  signMessage,
} from "./mailer-message.service.ts";
export type { DeliveryLimits } from "./mailer-delivery.service.ts";
export type {
  DkimOptions,
  FeedbackSource,
  MailReport,
  OutboundAttachment,
  UnsubscribeOptions,
} from "./mailer-message.service.ts";

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
 * its MX set ({@link discoverMtaSts}). In `enforce` mode only the MX
 * hosts the policy names are tried, over required and verified TLS; no
 * matching host, or a TLS or certificate failure, leaves the group in
 * `retry` (never a bounce), and the retry window gives the RFC's eventual
 * failure. In `testing` mode the group is delivered as without a policy,
 * and what enforce mode would have refused is logged once per policy.
 * The mode is recorded on each entry (`mtaSts`).
 *
 * **TLS-RPT (#345):** with `TLSRPT_ENABLED`, each MX session's TLS outcome
 * is recorded for the report of every recipient domain that publishes a
 * `_smtp._tls` record (`tls-rpt-observe.service.ts`), in the background:
 * the send never waits for it. A `report` (a TLS report itself) is sent
 * without MTA-STS and is not recorded (RFC 8460 section 5.3).
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
 * **DKIM (#345):** with `dkim`, the message is composed and signed once by
 * BunMail's own signer, before any DNS lookup or connection. A key that
 * cannot sign makes the call throw {@link DkimSigningFailedError}: nothing
 * is sent, and never unsigned. Without `dkim` the message goes out unsigned.
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
  /**
   * Attachments (#181), loaded by the queue for this attempt: the same on
   * every transaction and every retry, so each recipient gets the whole
   * message. Inline ones (with a Content-ID) go beside the HTML.
   */
  attachments?: readonly OutboundAttachment[];
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
  /**
   * The message is a report (#345, `multipart/report`): BunMail's own TLS
   * report (RFC 8460). Needs `dkim`, one text part and the report as the
   * attachment. MTA-STS is not applied to it and its sessions are not
   * recorded for TLS-RPT: a report about TLS failures must get through
   * them (RFC 8460 section 5.3).
   */
  report?: MailReport;
  /**
   * Tighter delivery limits for this call (#345, TLS reports): the
   * attempt's total session time and the most MX hosts tried. Absent: the
   * defaults, as for every other send.
   */
  deliveryLimits?: DeliveryLimits;
}): Promise<SendMailResult> {
  if (options.report && !options.dkim) {
    throw new Error("A report is only sent DKIM-signed");
  }
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
    /** Count only: filenames may carry personal data (#181). */
    attachmentCount: options.attachments?.length ?? 0,
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

  /** The parts of the message that are the same in every transaction. */
  const parts: MessageParts = {
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
    attachments: options.attachments ?? [],
    dkim: options.dkim,
    unsubscribe: options.unsubscribe,
    feedback: options.feedback,
    autoSubmitted: options.autoSubmitted === true,
    category: options.category ?? null,
    ...(options.report ? { report: options.report } : {}),
  };

  /**
   * DKIM (#345): composed and signed once per call, before any DNS lookup
   * or connection, so every transaction carries the same signed bytes. A
   * key that cannot sign throws {@link DkimSigningFailedError} here: nothing
   * is sent, never unsigned. A message that cannot be composed fails each
   * transaction as it would without a key. Nothing pending (every entry
   * already settled): nothing to sign.
   */
  const signed: SignedMessage =
    pendingByDomain.size > 0 ? await signMessage(parts) : { kind: "unsigned" };

  /**
   * Each domain resolved once per attempt, in parallel, never cached
   * (#250), its MTA-STS policy discovered alongside (cached per its `id`
   * and `max_age`, see `mta-sts.ts`). Not for a report (#345).
   */
  const noPolicy: MtaStsDiscovery = { policy: null, failure: null };
  const routes = new Map(
    await Promise.all(
      [...pendingByDomain.keys()].map(async (domain) => {
        const [route, discovery] = await Promise.all([
          resolveMxRoute(domain),
          options.report
            ? noPolicy
            : discoverMtaSts(domain, { allowPrivate: config.mail.allowPrivateMx }),
        ]);
        return [domain, { route, policy: discovery.policy, discovery }] as const;
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
    const { route, policy, discovery } = resolved;
    const mtaSts = mtaStsModeOf(policy);
    /** The domain and its policy for TLS-RPT (#345); none for a report. */
    const tlsRpt = options.report ? null : { domain, policy: tlsRptPolicyOf(discovery) };
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
      if (tlsRpt) observeUnconnectedAttempt(tlsRpt);
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
      tlsRpt: [],
      ...(options.deliveryLimits ? { limits: options.deliveryLimits } : {}),
    };
    plan.domains.push(domain);
    if (tlsRpt) plan.tlsRpt.push(tlsRpt);
    for (const key of keys) {
      const group = state[key];
      if (!group) continue;
      plan.transactions.push({
        key,
        domain,
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
    const outcomes = await sendToMxHosts(plan, parts, signed);
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
