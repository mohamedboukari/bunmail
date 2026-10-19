import { describe, test, expect } from "bun:test";
import { exhaustedSoftBounces } from "../../src/modules/emails/services/queue.service.ts";
import type {
  DeliveryGroup,
  DeliveryState,
} from "../../src/modules/emails/models/email.schema.ts";
import { classifySendFailure } from "../../src/utils/smtp-error.ts";

/**
 * The soft suppression after an exhausted retry window (#250): only an
 * entry whose LAST failure was a `4.2.2` SMTP reply (mailbox full) files
 * one. Every other temporary failure ends `failed` with nothing, as
 * before: `4.2.0`, `4.7.x`, other 4xx codes, and failures with no SMTP
 * reply at all (DNS, network, TLS, MTA-STS).
 *
 * Entries are built the way the mailer builds them: classified from the
 * error with `classifySendFailure`, the classification only stored when
 * the error carries an SMTP reply.
 */

/** An SMTP reply error, the shape nodemailer throws. */
function smtpReply(code: number, response: string): Error {
  const error = new Error(`Can't send mail - all recipients were rejected: ${response}`);
  Reflect.set(error, "responseCode", code);
  Reflect.set(error, "response", response);
  return error;
}

/** A `retry` entry after a failed attempt, as the mailer records it. */
function retryEntry(error: Error, recipients = ["reader@example.org"]): DeliveryGroup {
  const parsed = classifySendFailure(error);
  return {
    status: "retry",
    recipients,
    attempts: 12,
    lastError: error.message,
    ...(parsed ? { failureKind: parsed.kind, failureCode: parsed.code } : {}),
  };
}

/** The terminal state once the window is over: every `retry` entry flips to `failed`. */
function exhausted(state: DeliveryState): DeliveryState {
  const final: DeliveryState = {};
  for (const [key, group] of Object.entries(state)) {
    final[key] = group.status === "retry" ? { ...group, status: "failed" } : group;
  }
  return final;
}

function softBouncesAtExhaustion(group: DeliveryGroup): string[] {
  const state: DeliveryState = { "example.org": group };
  return exhaustedSoftBounces(state, exhausted(state)).map((b) => b.code);
}

describe("exhaustedSoftBounces: which last failure files a soft suppression", () => {
  test("452 4.2.2 mailbox full: one soft bounce per recipient", () => {
    const group = retryEntry(smtpReply(452, "452 4.2.2 Mailbox full"), [
      "a@example.org",
      "b@example.org",
    ]);
    const state: DeliveryState = { "example.org": group };

    expect(exhaustedSoftBounces(state, exhausted(state))).toEqual([
      {
        recipient: "a@example.org",
        bounceType: "soft",
        code: "4.2.2",
        diagnostic: group.lastError ?? "",
      },
      {
        recipient: "b@example.org",
        bounceType: "soft",
        code: "4.2.2",
        diagnostic: group.lastError ?? "",
      },
    ]);
  });

  test.each([
    ["4.2.0 (mailbox status unspecified)", smtpReply(450, "450 4.2.0 Mailbox busy")],
    ["4.7.1 (sender policy)", smtpReply(451, "451 4.7.1 Please try again later")],
    ["4.7.0 (greylisting)", smtpReply(450, "450 4.7.0 Greylisted")],
    ["4.4.1 (no answer from host)", smtpReply(421, "421 4.4.1 Connection timed out")],
    ["4.3.0 (system problem)", smtpReply(451, "451 4.3.0 Temporary system problem")],
    ["452 without an enhanced code", smtpReply(452, "452 Mailbox full")],
  ])("%s: nothing", (_name, error) => {
    expect(softBouncesAtExhaustion(retryEntry(error))).toEqual([]);
  });

  test.each([
    [
      "network error naming a 4.2.2.x address",
      new Error("connect ECONNREFUSED 4.2.2.1:25"),
    ],
    ["DNS failure", new Error("queryMx ESERVFAIL example.org")],
    [
      "TLS failure",
      new Error("unable to verify the first certificate (452 4.2.2 in the subject)"),
    ],
    ["MTA-STS refusal", new Error("MTA-STS enforce: no MX host matches the policy")],
  ])("no SMTP reply (%s): nothing", (_name, error) => {
    const group = retryEntry(error);
    expect(group.failureKind).toBeUndefined();
    expect(softBouncesAtExhaustion(group)).toEqual([]);
  });

  test("an entry with no stored classification is never read from lastError", () => {
    const group: DeliveryGroup = {
      status: "retry",
      recipients: ["reader@example.org"],
      attempts: 3,
      lastError: "452 4.2.2 Mailbox full",
    };
    expect(softBouncesAtExhaustion(group)).toEqual([]);
  });
});

describe("exhaustedSoftBounces: only at the end of the retry window", () => {
  const mailboxFull = retryEntry(smtpReply(452, "452 4.2.2 Mailbox full"));

  test("still retrying (the window is not over): nothing", () => {
    const state: DeliveryState = { "example.org": mailboxFull };
    expect(exhaustedSoftBounces(state, state)).toEqual([]);
  });

  test("an entry already failed before this attempt: nothing", () => {
    const state: DeliveryState = {
      "example.org": { ...mailboxFull, status: "failed" },
    };
    expect(exhaustedSoftBounces(state, state)).toEqual([]);
  });

  test("a mixed state: only the 4.2.2 entry, never the sent or 4.7.1 ones", () => {
    const state: DeliveryState = {
      "example.org": mailboxFull,
      "example.net": retryEntry(smtpReply(451, "451 4.7.1 Try later"), [
        "other@example.net",
      ]),
      "example.com": {
        status: "sent",
        recipients: ["ok@example.com"],
        attempts: 1,
        deliveredAt: new Date().toISOString(),
      },
    };
    expect(exhaustedSoftBounces(state, exhausted(state)).map((b) => b.recipient)).toEqual(
      ["reader@example.org"],
    );
  });
});
