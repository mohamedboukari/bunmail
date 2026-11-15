import { describe, test, expect, spyOn } from "bun:test";
import {
  classifyFeedbackType,
  handleFeedbackReport,
  type DkimCheck,
  type FeedbackHandlerDeps,
  type LinkedEmail,
} from "../../src/modules/inbound/services/feedback-handler.service.ts";
import type { FeedbackReport } from "../../src/modules/inbound/types/feedback-report.types.ts";
import { logger } from "../../src/utils/logger.ts";
import { redactEmail } from "../../src/utils/redact.ts";

/**
 * Unit tests for the feedback-loop handler's core (#191): which side
 * effects run for which report, with every dependency faked. The database
 * side (the suppression precedence) is covered by the integration test.
 */

/** The fake transaction handle: names the transaction a write ran in. */
interface FakeTx {
  txId: number;
}

interface Calls {
  lookups: string[];
  complaints: Array<{
    apiKeyId: string;
    email: string;
    emailId: string;
    verified: boolean;
  }>;
  unsubscribes: Array<{
    recipient: string;
    source: string;
    senderDomain: string;
    tags: Record<string, string> | null;
  }>;
  events: Array<{ event: string; data: Record<string, unknown>; apiKeyId: string }>;
  dkimChecks: number;
  /** How often the signed header view was read. */
  headerReads: number;
  /** Every write, with the transaction it ran in (`null`: outside one). */
  writes: Array<{ write: string; txId: number | null }>;
  /** How each transaction ended. */
  transactions: Array<"committed" | "rolled back">;
}

const EMAIL: LinkedEmail = {
  id: "msg_1",
  apiKeyId: "key_1",
  fromAddress: "hello@Example.com",
  toAddress: "reader@example.org",
  cc: null,
  bcc: null,
  tags: { flow: "reset" },
};

/** The fixture report's `From`: on the domain of the default passing signature. */
const REPORTER = "feedback@isp.example.net";

function makeDeps(opts: {
  email?: LinkedEmail;
  /** What addFromComplaint returns: a row (changed) or undefined (already on file). */
  complaintChanged?: boolean;
  unsubscribeCreated?: boolean;
  /** Make the outbox insert fail (#184). */
  enqueueFails?: boolean;
  /** The DKIM verdict on the report; default: one passing signature of isp.example.net. */
  dkim?: DkimCheck;
  /** `FEEDBACK_LOOP_DOMAINS`; default empty, so nothing is verified. */
  feedbackLoopDomains?: string[];
  /** `FEEDBACK_LOOP_SENDERS`; default: the fixture report's sender. */
  feedbackLoopSenders?: string[];
  /** The envelope `MAIL FROM`; default `null` (`<>`). */
  envelopeFrom?: string | null;
  /** The `From` a signature covers (verifier's view); default the fixture's sender. */
  signedFrom?: string | null;
  /** Whether the verifier's view has one top-level `Content-Type`; default true. */
  contentTypeSingle?: boolean;
}): { deps: FeedbackHandlerDeps<FakeTx>; calls: Calls } {
  const calls: Calls = {
    lookups: [],
    complaints: [],
    unsubscribes: [],
    events: [],
    dkimChecks: 0,
    headerReads: 0,
    writes: [],
    transactions: [],
  };
  /** The transaction currently open, if any. */
  let open: FakeTx | null = null;
  const inTx = (tx: FakeTx): number | null => (open === tx ? tx.txId : null);
  return {
    calls,
    deps: {
      findEmailByMessageId: async (messageId) => {
        calls.lookups.push(messageId);
        return opts.email;
      },
      transaction: async (work) => {
        const tx: FakeTx = { txId: calls.transactions.length + 1 };
        open = tx;
        try {
          const result = await work(tx);
          calls.transactions.push("committed");
          return result;
        } catch (error) {
          calls.transactions.push("rolled back");
          throw error;
        } finally {
          open = null;
        }
      },
      addFromComplaint: async (tx, input) => {
        calls.writes.push({ write: "addFromComplaint", txId: inTx(tx) });
        calls.complaints.push(input);
        return (opts.complaintChanged ?? true) ? { id: "sup_1" } : undefined;
      },
      unsubscribe: async (target, source) => {
        calls.unsubscribes.push({
          recipient: target.recipient,
          source,
          senderDomain: target.senderDomain,
          tags: target.tags,
        });
        return opts.unsubscribeCreated ?? true;
      },
      enqueueEvent: async (tx, event, data, scope) => {
        calls.writes.push({ write: "enqueueEvent", txId: inTx(tx) });
        if (opts.enqueueFails) throw new Error("outbox insert failed");
        calls.events.push({ event, data, apiKeyId: scope.apiKeyId });
        return 1;
      },
      verifyDkim: async () => {
        calls.dkimChecks += 1;
        return (
          opts.dkim ?? {
            result: "pass",
            signingDomain: "isp.example.net",
            passingDomains: ["isp.example.net"],
          }
        );
      },
      feedbackLoopDomains: opts.feedbackLoopDomains ?? [],
      feedbackLoopSenders: opts.feedbackLoopSenders ?? [REPORTER],
      envelopeFrom: opts.envelopeFrom ?? null,
      readSignedHeaders: () => {
        calls.headerReads += 1;
        return {
          from: opts.signedFrom === undefined ? REPORTER : opts.signedFrom,
          contentTypeSingle: opts.contentTypeSingle ?? true,
        };
      },
    },
  };
}

/** What `promise` rejects with, or `null` when it resolves. */
function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

function makeReport(overrides: Partial<FeedbackReport> = {}): FeedbackReport {
  return {
    feedbackType: "abuse",
    userAgent: "Example-Feedback/1.0",
    version: "1",
    originalMailFrom: "bounce@example.com",
    originalRcptTo: [],
    arrivalDate: new Date("2026-10-19T10:00:00Z"),
    reportedDomain: "example.com",
    sourceIp: "192.0.2.10",
    originalMessageId: "abc@mail.example.com",
    reporterDomain: "isp.example.net",
    reporterAddress: REPORTER,
    ...overrides,
  };
}

describe("classifyFeedbackType", () => {
  test.each([
    ["abuse", "complaint"],
    ["fraud", "complaint"],
    [null, "complaint"],
    ["opt-out", "opt-out"],
    ["not-spam", "ignore"],
    ["virus", "ignore"],
    ["other", "ignore"],
    ["something-new", "ignore"],
  ] as const)("%p is %p", (type, action) => {
    expect(classifyFeedbackType(type)).toBe(action);
  });
});

describe("handleFeedbackReport", () => {
  test("a linked abuse report suppresses the sole recipient and fires once", async () => {
    const { deps, calls } = makeDeps({ email: EMAIL });
    const result = await handleFeedbackReport(makeReport(), deps);

    expect(result).toEqual({ outcome: "complained", emailId: "msg_1" });
    expect(calls.lookups).toEqual(["abc@mail.example.com"]);
    /** A passing signature of a domain not listed: stored, but not verified. */
    expect(calls.complaints).toEqual([
      {
        apiKeyId: "key_1",
        email: "reader@example.org",
        emailId: "msg_1",
        verified: false,
      },
    ]);
    expect(calls.events).toHaveLength(1);
    expect(calls.events[0]).toMatchObject({
      event: "email.complained",
      apiKeyId: "key_1",
      data: {
        emailId: "msg_1",
        recipient: "reader@example.org",
        feedbackType: "abuse",
        reporter: "Example-Feedback/1.0",
        arrivalDate: "2026-10-19T10:00:00.000Z",
        /** The email's tags ride along (#189). */
        tags: { flow: "reset" },
      },
    });
    expect(typeof calls.events[0]?.data["receivedAt"]).toBe("string");
  });

  test("the reporter falls back to the report's domain, and arrivalDate to null", async () => {
    const { deps, calls } = makeDeps({ email: EMAIL });
    await handleFeedbackReport(makeReport({ userAgent: null, arrivalDate: null }), deps);
    expect(calls.events[0]?.data).toMatchObject({
      reporter: "isp.example.net",
      arrivalDate: null,
    });
  });

  test("a complaint already on file changes nothing and fires nothing", async () => {
    const { deps, calls } = makeDeps({ email: EMAIL, complaintChanged: false });
    const result = await handleFeedbackReport(makeReport(), deps);
    expect(result.outcome).toBe("already-complained");
    expect(calls.events).toHaveLength(0);
  });

  test("no or unknown Message-ID: dropped, nothing written, DKIM not checked", async () => {
    for (const report of [makeReport({ originalMessageId: null }), makeReport()]) {
      const { deps, calls } = makeDeps({});
      expect((await handleFeedbackReport(report, deps)).outcome).toBe(
        "dropped-no-original",
      );
      expect(calls.complaints).toHaveLength(0);
      expect(calls.events).toHaveLength(0);
      expect(calls.dkimChecks).toBe(0);
    }
  });

  test("an unparseable report is dropped", async () => {
    const { deps, calls } = makeDeps({ email: EMAIL });
    expect((await handleFeedbackReport(null, deps)).outcome).toBe("dropped-unparseable");
    expect(calls.lookups).toHaveLength(0);
  });

  test("not-spam, virus and unknown types are dropped before any lookup", async () => {
    for (const feedbackType of ["not-spam", "virus", "other"]) {
      const { deps, calls } = makeDeps({ email: EMAIL });
      expect(
        (await handleFeedbackReport(makeReport({ feedbackType }), deps)).outcome,
      ).toBe("dropped-ignored-type");
      expect(calls.lookups).toHaveLength(0);
      expect(calls.events).toHaveLength(0);
    }
  });

  test("a missing Feedback-Type counts as a complaint", async () => {
    const { deps, calls } = makeDeps({ email: EMAIL });
    const result = await handleFeedbackReport(makeReport({ feedbackType: null }), deps);
    expect(result.outcome).toBe("complained");
    expect(calls.events[0]?.data["feedbackType"]).toBeNull();
  });

  test("Original-Rcpt-To picks the recipient of a multi-recipient email", async () => {
    const email = {
      ...EMAIL,
      toAddress: "a@example.org, B@example.org",
      cc: "c@example.org",
      bcc: "d@example.org",
    };
    const { deps, calls } = makeDeps({ email });
    await handleFeedbackReport(
      makeReport({ originalRcptTo: ["stranger@example.org", "d@example.org"] }),
      deps,
    );
    expect(calls.complaints[0]?.email).toBe("d@example.org");

    const second = makeDeps({ email });
    await handleFeedbackReport(
      makeReport({ originalRcptTo: ["b@example.org"] }),
      second.deps,
    );
    expect(second.calls.complaints[0]?.email).toBe("b@example.org");
  });

  test("Original-Rcpt-To that matches no recipient: the sole recipient is used", async () => {
    const { deps, calls } = makeDeps({ email: EMAIL });
    await handleFeedbackReport(
      makeReport({ originalRcptTo: ["other@example.org"] }),
      deps,
    );
    expect(calls.complaints[0]?.email).toBe("reader@example.org");
  });

  test("several recipients and no usable Original-Rcpt-To: webhook with recipient null, no suppression", async () => {
    const email = { ...EMAIL, toAddress: "a@example.org", cc: "c@example.org" };
    const { deps, calls } = makeDeps({ email });
    const result = await handleFeedbackReport(makeReport(), deps);
    expect(result.outcome).toBe("complained-no-recipient");
    expect(calls.complaints).toHaveLength(0);
    expect(calls.events).toHaveLength(1);
    expect(calls.events[0]?.data["recipient"]).toBeNull();
  });

  test("opt-out goes through the unsubscribe path with source fbl", async () => {
    const { deps, calls } = makeDeps({ email: EMAIL });
    const result = await handleFeedbackReport(
      makeReport({ feedbackType: "opt-out" }),
      deps,
    );
    expect(result.outcome).toBe("unsubscribed");
    expect(calls.unsubscribes).toEqual([
      {
        recipient: "reader@example.org",
        source: "fbl",
        senderDomain: "example.com",
        tags: { flow: "reset" },
      },
    ]);
    expect(calls.complaints).toHaveLength(0);
    expect(calls.events).toHaveLength(0);
  });

  test("opt-out already on file, or without a recipient", async () => {
    const repeat = makeDeps({ email: EMAIL, unsubscribeCreated: false });
    expect(
      (await handleFeedbackReport(makeReport({ feedbackType: "opt-out" }), repeat.deps))
        .outcome,
    ).toBe("already-unsubscribed");

    const multi = makeDeps({ email: { ...EMAIL, cc: "c@example.org" } });
    expect(
      (await handleFeedbackReport(makeReport({ feedbackType: "opt-out" }), multi.deps))
        .outcome,
    ).toBe("dropped-no-recipient");
    expect(multi.calls.unsubscribes).toHaveLength(0);
  });
});

describe("handleFeedbackReport: one transaction (#184)", () => {
  test("the complaint suppression and its event are written in one transaction", async () => {
    const { deps, calls } = makeDeps({ email: EMAIL });
    await handleFeedbackReport(makeReport(), deps);
    expect(calls.writes).toEqual([
      { write: "addFromComplaint", txId: 1 },
      { write: "enqueueEvent", txId: 1 },
    ]);
    expect(calls.transactions).toEqual(["committed"]);
  });

  test("an enqueue failure rolls the suppression back and is thrown, not swallowed", async () => {
    const { deps, calls } = makeDeps({ email: EMAIL, enqueueFails: true });
    const error = await rejectionOf(handleFeedbackReport(makeReport(), deps));
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("outbox insert failed");
    expect(calls.transactions).toEqual(["rolled back"]);
    expect(calls.events).toHaveLength(0);
  });

  test("a complaint with no recipient enqueues its event in a transaction of its own", async () => {
    const email = { ...EMAIL, toAddress: "a@example.org", cc: "c@example.org" };
    const { deps, calls } = makeDeps({ email });
    await handleFeedbackReport(makeReport(), deps);
    expect(calls.writes).toEqual([{ write: "enqueueEvent", txId: 1 }]);
    expect(calls.transactions).toEqual(["committed"]);
  });
});

describe("handleFeedbackReport: verified complaints", () => {
  test("a passing signature of a listed domain stores the complaint as verified", async () => {
    const { deps, calls } = makeDeps({
      email: EMAIL,
      feedbackLoopDomains: ["isp.example.net"],
    });
    const result = await handleFeedbackReport(makeReport(), deps);
    expect(result.outcome).toBe("complained");
    expect(calls.complaints[0]?.verified).toBe(true);
    /** The webhook fires as for any complaint. */
    expect(calls.events).toHaveLength(1);
  });

  test("an unsigned report is stored unverified, still suppressed and still fired", async () => {
    const { deps, calls } = makeDeps({
      email: EMAIL,
      dkim: { result: "none", signingDomain: null, passingDomains: [] },
      feedbackLoopDomains: ["isp.example.net"],
    });
    const result = await handleFeedbackReport(makeReport(), deps);
    expect(result.outcome).toBe("complained");
    expect(calls.complaints[0]?.verified).toBe(false);
    expect(calls.events).toHaveLength(1);
  });

  test("the complaint log line carries verified and dkimDomain, and the address only redacted", async () => {
    const { deps } = makeDeps({ email: EMAIL, feedbackLoopDomains: ["isp.example.net"] });
    const infos: unknown[][] = [];
    const spy = spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      infos.push(args);
    });
    try {
      await handleFeedbackReport(makeReport(), deps);
    } finally {
      spy.mockRestore();
    }
    const line = infos.find((args) => args[0] === "Complaint handled");
    /**
     * The address goes through `redactEmail`, whatever the redaction setting
     * of this run: the config is not mutated here (another file's mock can
     * make it read-only in CI's random order).
     */
    expect(line?.[1]).toMatchObject({
      verified: true,
      dkim: "pass",
      dkimDomain: "isp.example.net",
      recipient: redactEmail("reader@example.org"),
    });
  });
});

/**
 * A verified complaint must also come from a configured feedback-loop
 * sender: a report signed by a listed domain but sent by an unlisted
 * address, or signed by a domain the `From` does not belong to, stays per
 * key, and the reason is logged.
 */
describe("handleFeedbackReport: the feedback-loop sender", () => {
  /** Runs `report` through the handler, capturing info and warn lines. */
  async function run(
    opts: Parameters<typeof makeDeps>[0],
    report: FeedbackReport = makeReport(),
  ): Promise<{ calls: Calls; lines: Array<{ level: string; args: unknown[] }> }> {
    const { deps, calls } = makeDeps(opts);
    const lines: Array<{ level: string; args: unknown[] }> = [];
    const info = spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      lines.push({ level: "info", args });
    });
    const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      lines.push({ level: "warn", args });
    });
    try {
      await handleFeedbackReport(report, deps);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
    return { calls, lines };
  }

  /** The "not verified" line, if one was logged. */
  function notVerifiedLine(
    lines: Array<{ level: string; args: unknown[] }>,
  ): { level: string; args: unknown[] } | undefined {
    return lines.find((line) =>
      String(line.args[0]).startsWith("Complaint not verified"),
    );
  }

  test("signed by a listed domain but from an unlisted sender: not verified, warned, still suppressed per key", async () => {
    const { calls, lines } = await run(
      {
        email: EMAIL,
        feedbackLoopDomains: ["isp.example.net"],
        signedFrom: "someone@isp.example.net",
      },
      makeReport({ reporterAddress: "someone@isp.example.net" }),
    );
    expect(calls.complaints[0]?.verified).toBe(false);
    expect(calls.events).toHaveLength(1);
    const line = notVerifiedLine(lines);
    expect(line?.level).toBe("warn");
    expect(line?.args[1]).toMatchObject({
      unverifiedReason: "sender_not_listed",
      reporter: redactEmail("someone@isp.example.net"),
      passingDomains: ["isp.example.net"],
      emailId: "msg_1",
    });
  });

  test("the same report from the listed sender: verified, no such line", async () => {
    const { calls, lines } = await run({
      email: EMAIL,
      feedbackLoopDomains: ["isp.example.net"],
    });
    expect(calls.complaints[0]?.verified).toBe(true);
    expect(notVerifiedLine(lines)).toBeUndefined();
  });

  test("a listed sender whose domain the signature does not cover: not_aligned", async () => {
    const { calls, lines } = await run(
      {
        email: EMAIL,
        feedbackLoopDomains: ["isp.example.net"],
        feedbackLoopSenders: ["feedback@other.example.org"],
        signedFrom: "feedback@other.example.org",
      },
      makeReport({ reporterAddress: "feedback@other.example.org" }),
    );
    expect(calls.complaints[0]?.verified).toBe(false);
    expect(notVerifiedLine(lines)?.args[1]).toMatchObject({
      unverifiedReason: "not_aligned",
    });
  });

  test("no single From address: sender_missing", async () => {
    const { calls, lines } = await run(
      { email: EMAIL, feedbackLoopDomains: ["isp.example.net"], signedFrom: null },
      makeReport({ reporterAddress: null }),
    );
    expect(calls.complaints[0]?.verified).toBe(false);
    expect(notVerifiedLine(lines)?.args[1]).toMatchObject({
      unverifiedReason: "sender_missing",
    });
  });

  test("an envelope sender that is not listed: envelope_not_listed; an empty one is accepted", async () => {
    const unlisted = await run({
      email: EMAIL,
      feedbackLoopDomains: ["isp.example.net"],
      envelopeFrom: "bounces@elsewhere.example",
    });
    expect(unlisted.calls.complaints[0]?.verified).toBe(false);
    expect(notVerifiedLine(unlisted.lines)?.args[1]).toMatchObject({
      unverifiedReason: "envelope_not_listed",
      envelopeFrom: redactEmail("bounces@elsewhere.example"),
    });

    const listed = await run({
      email: EMAIL,
      feedbackLoopDomains: ["isp.example.net"],
      envelopeFrom: REPORTER,
    });
    expect(listed.calls.complaints[0]?.verified).toBe(true);

    const empty = await run({
      email: EMAIL,
      feedbackLoopDomains: ["isp.example.net"],
      envelopeFrom: null,
    });
    expect(empty.calls.complaints[0]?.verified).toBe(true);
  });

  test("the From the report claims is not trusted: only the From a signature covers is checked", async () => {
    const { calls, lines } = await run(
      {
        email: EMAIL,
        feedbackLoopDomains: ["isp.example.net"],
        signedFrom: "user@isp.example.net",
      },
      makeReport({ reporterAddress: REPORTER }),
    );
    expect(calls.complaints[0]?.verified).toBe(false);
    expect(notVerifiedLine(lines)?.args[1]).toMatchObject({
      unverifiedReason: "sender_not_listed",
      reporter: redactEmail(REPORTER),
      signedFrom: redactEmail("user@isp.example.net"),
    });
  });

  test("no single top-level Content-Type in the signed view: not verified", async () => {
    const { calls, lines } = await run({
      email: EMAIL,
      feedbackLoopDomains: ["isp.example.net"],
      contentTypeSingle: false,
    });
    expect(calls.complaints[0]?.verified).toBe(false);
    expect(notVerifiedLine(lines)?.args[1]).toMatchObject({
      unverifiedReason: "content_type_ambiguous",
    });
  });

  test("no passing signature: the header section is not read again", async () => {
    const { calls } = await run({
      email: EMAIL,
      feedbackLoopDomains: ["isp.example.net"],
      dkim: { result: "none", signingDomain: null, passingDomains: [] },
    });
    expect(calls.headerReads).toBe(0);
    expect(calls.complaints[0]?.verified).toBe(false);
  });

  test("FEEDBACK_LOOP_SENDERS empty: fails closed, nothing verified, logged at info", async () => {
    const { calls, lines } = await run({
      email: EMAIL,
      feedbackLoopDomains: ["isp.example.net"],
      feedbackLoopSenders: [],
    });
    expect(calls.complaints[0]?.verified).toBe(false);
    expect(calls.events).toHaveLength(1);
    const line = notVerifiedLine(lines);
    expect(line?.level).toBe("info");
    expect(line?.args[1]).toMatchObject({ unverifiedReason: "no_feedback_loop_senders" });
  });

  test("FEEDBACK_LOOP_DOMAINS empty (feature off): no extra line, the reason rides on the complaint line", async () => {
    const { calls, lines } = await run({ email: EMAIL });
    expect(calls.complaints[0]?.verified).toBe(false);
    expect(notVerifiedLine(lines)).toBeUndefined();
    const handled = lines.find((line) => line.args[0] === "Complaint handled");
    expect(handled?.args[1]).toMatchObject({
      verified: false,
      unverifiedReason: "no_feedback_loop_domains",
    });
  });
});
