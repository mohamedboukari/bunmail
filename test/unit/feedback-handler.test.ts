import { describe, test, expect } from "bun:test";
import {
  classifyFeedbackType,
  handleFeedbackReport,
  type FeedbackHandlerDeps,
  type LinkedEmail,
} from "../../src/modules/inbound/services/feedback-handler.service.ts";
import type { FeedbackReport } from "../../src/modules/inbound/types/feedback-report.types.ts";

/**
 * Unit tests for the feedback-loop handler's core (#191): which side
 * effects run for which report, with every dependency faked. The database
 * side (the suppression precedence) is covered by the integration test.
 */

interface Calls {
  lookups: string[];
  complaints: Array<{ apiKeyId: string; email: string; emailId: string }>;
  unsubscribes: Array<{ recipient: string; source: string; senderDomain: string }>;
  events: Array<{ event: string; data: Record<string, unknown>; apiKeyId: string }>;
  dkimChecks: number;
}

const EMAIL: LinkedEmail = {
  id: "msg_1",
  apiKeyId: "key_1",
  fromAddress: "hello@Example.com",
  toAddress: "reader@example.org",
  cc: null,
  bcc: null,
};

function makeDeps(opts: {
  email?: LinkedEmail;
  /** What addFromComplaint returns: a row (changed) or undefined (already on file). */
  complaintChanged?: boolean;
  unsubscribeCreated?: boolean;
}): { deps: FeedbackHandlerDeps; calls: Calls } {
  const calls: Calls = {
    lookups: [],
    complaints: [],
    unsubscribes: [],
    events: [],
    dkimChecks: 0,
  };
  return {
    calls,
    deps: {
      findEmailByMessageId: async (messageId) => {
        calls.lookups.push(messageId);
        return opts.email;
      },
      addFromComplaint: async (input) => {
        calls.complaints.push(input);
        return (opts.complaintChanged ?? true) ? { id: "sup_1" } : undefined;
      },
      unsubscribe: async (target, source) => {
        calls.unsubscribes.push({
          recipient: target.recipient,
          source,
          senderDomain: target.senderDomain,
        });
        return opts.unsubscribeCreated ?? true;
      },
      dispatchEvent: (event, data, scope) => {
        calls.events.push({ event, data, apiKeyId: scope.apiKeyId });
      },
      verifyDkim: async () => {
        calls.dkimChecks += 1;
        return { result: "pass", signingDomain: "isp.example.net" };
      },
    },
  };
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
    expect(calls.complaints).toEqual([
      { apiKeyId: "key_1", email: "reader@example.org", emailId: "msg_1" },
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
      { recipient: "reader@example.org", source: "fbl", senderDomain: "example.com" },
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
