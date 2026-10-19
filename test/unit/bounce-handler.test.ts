import { describe, test, expect } from "bun:test";
import { handleBounce } from "../../src/modules/bounces/services/bounce-handler.service.ts";
import type { OriginalEmail } from "../../src/modules/bounces/services/bounce-handler.service.ts";
import type { ParsedBounce } from "../../src/modules/bounces/types/bounce.types.ts";

/**
 * Unit tests for the bounce handler's orchestration core.
 *
 * `handleBounce` takes its dependencies as injected callbacks (same
 * pattern as `resolveDomainForEmail`), so we can assert which side
 * effects fire and in what order without standing up a DB.
 */

interface CallLog {
  findEmailByMessageId: string[];
  isSuppressed: Array<{ apiKeyId: string; email: string }>;
  addFromBounce: Array<{
    apiKeyId: string;
    email: string;
    bounceType: "hard" | "soft";
    expiresAt: Date | null | undefined;
  }>;
  markEmailBounced: string[];
  dispatchEvent: Array<{ event: string; data: Record<string, unknown> }>;
}

function makeDeps(opts: {
  email?: OriginalEmail;
  existing?: { id: string; bounceType: string | null };
  /** A permanent suppression already on file, kept by addFromBounce (#191). */
  keptSuppressionId?: string;
}): {
  deps: Parameters<typeof handleBounce>[1];
  calls: CallLog;
} {
  const calls: CallLog = {
    findEmailByMessageId: [],
    isSuppressed: [],
    addFromBounce: [],
    markEmailBounced: [],
    dispatchEvent: [],
  };

  return {
    calls,
    deps: {
      findEmailByMessageId: async (messageId) => {
        calls.findEmailByMessageId.push(messageId);
        return opts.email;
      },
      isSuppressed: async (apiKeyId, email) => {
        calls.isSuppressed.push({ apiKeyId, email });
        return opts.existing;
      },
      addFromBounce: async (apiKeyId, input) => {
        calls.addFromBounce.push({
          apiKeyId,
          email: input.email,
          bounceType: input.bounceType,
          expiresAt: input.expiresAt,
        });
        return opts.keptSuppressionId === undefined
          ? { suppressionId: "sup_new123", applied: true }
          : { suppressionId: opts.keptSuppressionId, applied: false };
      },
      markEmailBounced: async (emailId) => {
        calls.markEmailBounced.push(emailId);
      },
      dispatchEvent: (event, data) => {
        calls.dispatchEvent.push({ event, data });
      },
    },
  };
}

const HARD_BOUNCE: ParsedBounce = {
  kind: "hard",
  recipient: "user@example.com",
  originalMessageId: "abc-123@yourdns.example",
  status: "5.1.1",
  diagnostic: "User unknown",
  source: "rfc3464",
};

const SOFT_BOUNCE: ParsedBounce = {
  kind: "soft",
  recipient: "user@example.com",
  originalMessageId: "abc-123@yourdns.example",
  status: "4.2.2",
  diagnostic: "Mailbox over quota",
  source: "rfc3464",
};

const ORIGINAL = {
  id: "msg_orig123",
  apiKeyId: "key_abc",
  toAddress: "user@example.com",
  cc: null,
  bcc: null,
};

describe("handleBounce: happy paths", () => {
  test("hard bounce: persists permanent suppression, marks email bounced, fires webhook", async () => {
    const { deps, calls } = makeDeps({ email: ORIGINAL });

    const result = await handleBounce(HARD_BOUNCE, deps);

    expect(result.outcome).toBe("applied");
    expect(result.emailId).toBe("msg_orig123");
    expect(result.bounceType).toBe("hard");

    expect(calls.findEmailByMessageId).toEqual(["abc-123@yourdns.example"]);
    expect(calls.isSuppressed).toEqual([
      { apiKeyId: "key_abc", email: "user@example.com" },
    ]);
    expect(calls.addFromBounce).toHaveLength(1);
    expect(calls.addFromBounce[0]!.bounceType).toBe("hard");
    /** Hard bounce → permanent (null expiresAt). */
    expect(calls.addFromBounce[0]!.expiresAt).toBeNull();
    expect(calls.markEmailBounced).toEqual(["msg_orig123"]);
    expect(calls.dispatchEvent).toHaveLength(1);
    expect(calls.dispatchEvent[0]!.event).toBe("email.bounced");
    expect(calls.dispatchEvent[0]!.data.bounceType).toBe("hard");
    expect(calls.dispatchEvent[0]!.data.suppressionId).toBe("sup_new123");
  });

  test("first soft bounce: persists soft suppression with future expiresAt", async () => {
    const { deps, calls } = makeDeps({ email: ORIGINAL });
    const before = Date.now();

    const result = await handleBounce(SOFT_BOUNCE, deps);

    expect(result.outcome).toBe("applied");
    expect(result.bounceType).toBe("soft");

    expect(calls.addFromBounce[0]!.bounceType).toBe("soft");
    /** Soft bounce → time-windowed suppression. Window is 24h. */
    const expiresAt = calls.addFromBounce[0]!.expiresAt;
    expect(expiresAt).not.toBeNull();
    expect(expiresAt!.getTime()).toBeGreaterThan(before);
    /** Should be roughly 24h out (allow ±5s slack for test execution). */
    expect(expiresAt!.getTime()).toBeGreaterThanOrEqual(
      before + 24 * 60 * 60 * 1000 - 5000,
    );
  });
});

describe("handleBounce: escalation", () => {
  test("second soft bounce while previous soft suppression active escalates to hard", async () => {
    const { deps, calls } = makeDeps({
      email: ORIGINAL,
      existing: { id: "sup_existing", bounceType: "soft" },
    });

    const result = await handleBounce(SOFT_BOUNCE, deps);

    expect(result.outcome).toBe("escalated");
    expect(result.bounceType).toBe("hard");
    expect(calls.addFromBounce[0]!.bounceType).toBe("hard");
    /** Escalated → permanent. */
    expect(calls.addFromBounce[0]!.expiresAt).toBeNull();
    expect(calls.dispatchEvent[0]!.data.bounceType).toBe("hard");
  });

  test("hard bounce on top of existing hard suppression stays hard (no double-escalation)", async () => {
    const { deps } = makeDeps({
      email: ORIGINAL,
      existing: { id: "sup_existing", bounceType: "hard" },
    });

    const result = await handleBounce(HARD_BOUNCE, deps);
    /** Already hard, this is a re-confirmation, not an escalation event. */
    expect(result.outcome).toBe("applied");
    expect(result.bounceType).toBe("hard");
  });
});

describe("handleBounce: drop paths", () => {
  test("returns dropped-no-original when the original email isn't found", async () => {
    const { deps, calls } = makeDeps({ email: undefined });

    const result = await handleBounce(HARD_BOUNCE, deps);

    expect(result.outcome).toBe("dropped-no-original");
    /** Nothing else should have run. */
    expect(calls.isSuppressed).toEqual([]);
    expect(calls.addFromBounce).toEqual([]);
    expect(calls.markEmailBounced).toEqual([]);
    expect(calls.dispatchEvent).toEqual([]);
  });

  test("drops a bounce for an address the email was not sent to", async () => {
    const { deps, calls } = makeDeps({ email: ORIGINAL });

    const result = await handleBounce(
      { ...HARD_BOUNCE, recipient: "someone-else@example.com" },
      deps,
    );

    expect(result.outcome).toBe("dropped-recipient-mismatch");
    /** Nothing is suppressed, marked or dispatched for a forged bounce. */
    expect(calls.isSuppressed).toEqual([]);
    expect(calls.addFromBounce).toEqual([]);
    expect(calls.markEmailBounced).toEqual([]);
    expect(calls.dispatchEvent).toEqual([]);
  });
});

describe("handleBounce: recipient matching", () => {
  test("accepts a cc or bcc recipient of the original email", async () => {
    const { deps, calls } = makeDeps({
      email: { ...ORIGINAL, cc: "copy@example.com", bcc: "Hidden@Example.com" },
    });

    expect(
      (await handleBounce({ ...HARD_BOUNCE, recipient: "copy@example.com" }, deps))
        .outcome,
    ).toBe("applied");
    expect(
      (await handleBounce({ ...HARD_BOUNCE, recipient: "hidden@example.com" }, deps))
        .outcome,
    ).toBe("applied");
    expect(calls.addFromBounce.map((c) => c.email)).toEqual([
      "copy@example.com",
      "hidden@example.com",
    ]);
  });

  test("accepts Original-Recipient and suppresses the address we sent to", async () => {
    const { deps, calls } = makeDeps({ email: ORIGINAL });

    const result = await handleBounce(
      {
        ...HARD_BOUNCE,
        recipient: "forwarded-target@example.net",
        originalRecipient: "user@example.com",
      },
      deps,
    );

    expect(result.outcome).toBe("applied");
    expect(calls.addFromBounce[0]!.email).toBe("user@example.com");
    expect(calls.dispatchEvent[0]!.data.to).toBe("user@example.com");
  });

  test("a permanent suppression kept on file: still marked bounced and the webhook still fires (#191)", async () => {
    const { deps, calls } = makeDeps({
      email: ORIGINAL,
      keptSuppressionId: "sup_complaint",
    });

    const result = await handleBounce(HARD_BOUNCE, deps);

    expect(result.outcome).toBe("applied");
    expect(result.suppressionApplied).toBe(false);
    expect(result.suppressionId).toBe("sup_complaint");
    expect(calls.markEmailBounced).toEqual(["msg_orig123"]);
    expect(calls.dispatchEvent).toHaveLength(1);
    expect(calls.dispatchEvent[0]!.data.suppressionId).toBe("sup_complaint");
  });
});
