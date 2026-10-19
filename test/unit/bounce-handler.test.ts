import { describe, test, expect } from "bun:test";
import { handleBounce } from "../../src/modules/bounces/services/bounce-handler.service.ts";
import type { ReturnPathBinding } from "../../src/modules/bounces/services/bounce-handler.service.ts";
import type { ParsedBounce } from "../../src/modules/bounces/types/bounce.types.ts";

/**
 * Unit tests for the bounce handler's orchestration core.
 *
 * `handleBounce` takes its dependencies as injected callbacks (same
 * pattern as `resolveDomainForEmail`), so we can assert which side
 * effects fire and in what order without standing up a DB. Since #236 the
 * email and recipient come from the verified return path (`binding`),
 * never from the DSN body.
 */

interface CallLog {
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
  existing?: { id: string; bounceType: string | null };
  /** A permanent suppression already on file, kept by addFromBounce (#191). */
  keptSuppressionId?: string;
}): {
  deps: Parameters<typeof handleBounce>[2];
  calls: CallLog;
} {
  const calls: CallLog = {
    isSuppressed: [],
    addFromBounce: [],
    markEmailBounced: [],
    dispatchEvent: [],
  };

  return {
    calls,
    deps: {
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

/** The verified return path the DSN arrived at: email and recipient. */
const BOUND: ReturnPathBinding = {
  email: { id: "msg_orig123", apiKeyId: "key_abc" },
  recipient: "user@example.com",
};

describe("handleBounce: happy paths", () => {
  test("hard bounce: persists permanent suppression, marks email bounced, fires webhook", async () => {
    const { deps, calls } = makeDeps({});

    const result = await handleBounce(HARD_BOUNCE, BOUND, deps);

    expect(result.outcome).toBe("applied");
    expect(result.emailId).toBe("msg_orig123");
    expect(result.bounceType).toBe("hard");

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
    const { deps, calls } = makeDeps({});
    const before = Date.now();

    const result = await handleBounce(SOFT_BOUNCE, BOUND, deps);

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
      existing: { id: "sup_existing", bounceType: "soft" },
    });

    const result = await handleBounce(SOFT_BOUNCE, BOUND, deps);

    expect(result.outcome).toBe("escalated");
    expect(result.bounceType).toBe("hard");
    expect(calls.addFromBounce[0]!.bounceType).toBe("hard");
    /** Escalated → permanent. */
    expect(calls.addFromBounce[0]!.expiresAt).toBeNull();
    expect(calls.dispatchEvent[0]!.data.bounceType).toBe("hard");
  });

  test("hard bounce on top of existing hard suppression stays hard (no double-escalation)", async () => {
    const { deps } = makeDeps({
      existing: { id: "sup_existing", bounceType: "hard" },
    });

    const result = await handleBounce(HARD_BOUNCE, BOUND, deps);
    /** Already hard, this is a re-confirmation, not an escalation event. */
    expect(result.outcome).toBe("applied");
    expect(result.bounceType).toBe("hard");
  });
});

describe("handleBounce: the return path decides the recipient (#236)", () => {
  test("a DSN naming a co-recipient still affects only the bound recipient", async () => {
    const { deps, calls } = makeDeps({});

    const result = await handleBounce(
      { ...HARD_BOUNCE, recipient: "co-recipient@example.com" },
      BOUND,
      deps,
    );

    expect(result.outcome).toBe("applied");
    expect(calls.isSuppressed).toEqual([
      { apiKeyId: "key_abc", email: "user@example.com" },
    ]);
    expect(calls.addFromBounce.map((c) => c.email)).toEqual(["user@example.com"]);
    expect(calls.dispatchEvent[0]!.data.to).toBe("user@example.com");
  });

  test("a DSN without any Original-Message-ID still applies", async () => {
    const { deps, calls } = makeDeps({});
    const { originalMessageId: _unused, ...withoutId } = HARD_BOUNCE;

    const result = await handleBounce(withoutId, BOUND, deps);

    expect(result.outcome).toBe("applied");
    expect(calls.markEmailBounced).toEqual(["msg_orig123"]);
  });

  test("the suppression is filed for the bound recipient, not the address in the DSN", async () => {
    const { deps, calls } = makeDeps({});

    await handleBounce(
      { ...HARD_BOUNCE, recipient: "forwarded-target@example.net" },
      { ...BOUND, recipient: "copy@example.com" },
      deps,
    );

    expect(calls.addFromBounce[0]!.email).toBe("copy@example.com");
  });
});

describe("handleBounce: suppression kept (#191)", () => {
  test("a permanent suppression kept on file: still marked bounced and the webhook still fires (#191)", async () => {
    const { deps, calls } = makeDeps({
      keptSuppressionId: "sup_complaint",
    });

    const result = await handleBounce(HARD_BOUNCE, BOUND, deps);

    expect(result.outcome).toBe("applied");
    expect(result.suppressionApplied).toBe(false);
    expect(result.suppressionId).toBe("sup_complaint");
    expect(calls.markEmailBounced).toEqual(["msg_orig123"]);
    expect(calls.dispatchEvent).toHaveLength(1);
    expect(calls.dispatchEvent[0]!.data.suppressionId).toBe("sup_complaint");
  });
});
