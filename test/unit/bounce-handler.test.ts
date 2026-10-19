import { describe, test, expect } from "bun:test";
import { handleBounce } from "../../src/modules/bounces/services/bounce-handler.service.ts";
import type {
  BounceHandlerDeps,
  ReturnPathBinding,
} from "../../src/modules/bounces/services/bounce-handler.service.ts";
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

/** The fake transaction handle: names the transaction a write ran in. */
interface FakeTx {
  txId: number;
}

interface CallLog {
  isSuppressed: Array<{ apiKeyId: string; email: string }>;
  addFromBounce: Array<{
    apiKeyId: string;
    email: string;
    bounceType: "hard" | "soft";
    expiresAt: Date | null | undefined;
  }>;
  markEmailBounced: string[];
  markEmailBlocked: Array<{ emailId: string; lastError: string }>;
  events: Array<{ event: string; data: Record<string, unknown> }>;
  /** Every write, with the transaction it ran in (`null`: outside one). */
  writes: Array<{ write: string; txId: number | null }>;
  /** How each transaction ended. */
  transactions: Array<"committed" | "rolled back">;
}

function makeDeps(opts: {
  existing?: { id: string; bounceType: string | null };
  /** A permanent suppression already on file, kept by addFromBounce (#191). */
  keptSuppressionId?: string;
  /** Make the outbox insert fail (#184). */
  enqueueFails?: boolean;
  /** A policy DSN for an email that is not `sent` (left alone). */
  emailNotSent?: boolean;
}): {
  deps: BounceHandlerDeps<FakeTx>;
  calls: CallLog;
} {
  const calls: CallLog = {
    isSuppressed: [],
    addFromBounce: [],
    markEmailBounced: [],
    markEmailBlocked: [],
    events: [],
    writes: [],
    transactions: [],
  };
  /** The transaction currently open, if any. */
  let open: FakeTx | null = null;
  const inTx = (tx: FakeTx): number | null => (open === tx ? tx.txId : null);

  return {
    calls,
    deps: {
      isSuppressed: async (apiKeyId, email) => {
        calls.isSuppressed.push({ apiKeyId, email });
        return opts.existing;
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
      addFromBounce: async (tx, apiKeyId, input) => {
        calls.writes.push({ write: "addFromBounce", txId: inTx(tx) });
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
      markEmailBounced: async (tx, emailId) => {
        calls.writes.push({ write: "markEmailBounced", txId: inTx(tx) });
        calls.markEmailBounced.push(emailId);
      },
      markEmailBlocked: async (tx, emailId, lastError) => {
        calls.writes.push({ write: "markEmailBlocked", txId: inTx(tx) });
        calls.markEmailBlocked.push({ emailId, lastError });
        return opts.emailNotSent
          ? null
          : {
              fromAddress: "hello@example.com",
              toAddress: "user@example.com",
              subject: "Welcome",
            };
      },
      enqueueEvent: async (tx, event, data) => {
        calls.writes.push({ write: "enqueueEvent", txId: inTx(tx) });
        if (opts.enqueueFails) throw new Error("outbox insert failed");
        calls.events.push({ event, data });
        return 1;
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
  email: { id: "msg_orig123", apiKeyId: "key_abc", tags: { flow: "reset" } },
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
    expect(calls.events).toHaveLength(1);
    expect(calls.events[0]!.event).toBe("email.bounced");
    expect(calls.events[0]!.data.bounceType).toBe("hard");
    expect(calls.events[0]!.data.suppressionId).toBe("sup_new123");
    /** The email's tags ride along (#189). */
    expect(calls.events[0]!.data.tags).toEqual({ flow: "reset" });
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
    expect(calls.events[0]!.data.bounceType).toBe("hard");
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
    expect(calls.events[0]!.data.to).toBe("user@example.com");
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
    expect(calls.events).toHaveLength(1);
    expect(calls.events[0]!.data.suppressionId).toBe("sup_complaint");
  });
});

describe("handleBounce: one transaction (#184)", () => {
  test("the suppression, the status and the event are written in one transaction", async () => {
    const { deps, calls } = makeDeps({});

    await handleBounce(HARD_BOUNCE, BOUND, deps);

    expect(calls.writes).toEqual([
      { write: "addFromBounce", txId: 1 },
      { write: "markEmailBounced", txId: 1 },
      { write: "enqueueEvent", txId: 1 },
    ]);
    expect(calls.transactions).toEqual(["committed"]);
  });

  test("an enqueue failure rolls the transaction back and is thrown, not swallowed", async () => {
    const { deps, calls } = makeDeps({ enqueueFails: true });

    const error = await rejectionOf(handleBounce(HARD_BOUNCE, BOUND, deps));
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("outbox insert failed");
    expect(calls.transactions).toEqual(["rolled back"]);
    expect(calls.events).toEqual([]);
  });
});

const POLICY_BOUNCE: ParsedBounce = {
  kind: "policy",
  recipient: "user@example.com",
  status: "5.7.1",
  diagnostic: "550 5.7.1 Message rejected due to DMARC policy",
  source: "rfc3464",
};

describe("handleBounce: policy DSN (#250)", () => {
  test("no suppression, no email.bounced: marked failed and email.failed with blocked, in one transaction", async () => {
    const { deps, calls } = makeDeps({});

    const result = await handleBounce(POLICY_BOUNCE, BOUND, deps);

    expect(result.outcome).toBe("blocked");
    expect(result.markedFailed).toBe(true);
    expect(result.bounceType).toBeUndefined();
    expect(calls.isSuppressed).toEqual([]);
    expect(calls.addFromBounce).toEqual([]);
    expect(calls.markEmailBounced).toEqual([]);
    expect(calls.markEmailBlocked).toEqual([
      {
        emailId: "msg_orig123",
        lastError:
          "Receiver refused the sender (DSN 5.7.1): 550 5.7.1 Message rejected due to DMARC policy",
      },
    ]);
    /** The inline policy failure's `email.failed`, field for field (#246). */
    expect(calls.events).toEqual([
      {
        event: "email.failed",
        data: {
          emailId: "msg_orig123",
          from: "hello@example.com",
          to: "user@example.com",
          subject: "Welcome",
          error:
            "Receiver refused the sender (DSN 5.7.1): 550 5.7.1 Message rejected due to DMARC policy",
          blocked: true,
          tags: { flow: "reset" },
        },
      },
    ]);
    expect(calls.writes).toEqual([
      { write: "markEmailBlocked", txId: 1 },
      { write: "enqueueEvent", txId: 1 },
    ]);
    expect(calls.transactions).toEqual(["committed"]);
  });

  test("an email that is not sent is left alone and fires nothing", async () => {
    const { deps, calls } = makeDeps({ emailNotSent: true });

    const result = await handleBounce(POLICY_BOUNCE, BOUND, deps);

    expect(result.outcome).toBe("blocked");
    expect(result.markedFailed).toBe(false);
    expect(calls.addFromBounce).toEqual([]);
    expect(calls.events).toEqual([]);
  });

  test("an existing soft suppression does not turn a policy DSN into a hard bounce", async () => {
    const { deps, calls } = makeDeps({
      existing: { id: "sup_existing", bounceType: "soft" },
    });

    const result = await handleBounce(POLICY_BOUNCE, BOUND, deps);

    expect(result.outcome).toBe("blocked");
    expect(calls.addFromBounce).toEqual([]);
  });

  test("the reason is capped: the diagnostic is free text", async () => {
    const { deps, calls } = makeDeps({});

    await handleBounce({ ...POLICY_BOUNCE, diagnostic: "x".repeat(5000) }, BOUND, deps);

    expect(calls.markEmailBlocked[0]!.lastError).toHaveLength(1000);
  });

  test("an enqueue failure rolls it back and is thrown (#184)", async () => {
    const { deps, calls } = makeDeps({ enqueueFails: true });

    const error = await rejectionOf(handleBounce(POLICY_BOUNCE, BOUND, deps));
    expect(String(error)).toContain("outbox insert failed");
    expect(calls.transactions).toEqual(["rolled back"]);
  });
});
