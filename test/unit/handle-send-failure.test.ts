import { describe, test, expect } from "bun:test";
import {
  handleSendFailure,
  type SendFailureContext,
  type SendFailureDeps,
} from "../../src/modules/emails/services/queue.service.ts";

/**
 * Unit tests for `handleSendFailure` — the queue's send-failure
 * classification + side-effect orchestration. Same testing pattern as
 * `bounce-handler.test.ts`: inject every side effect as a callback,
 * assert which ones fired and with what args.
 *
 * Coverage:
 *   - Inline 5xx on attempt 1 → suppress, mark bounced, fire
 *     email.bounced, **stop retrying** (no markEmailFailed,
 *     no markEmailRequeued)
 *   - Inline 5xx on a later attempt also auto-suppresses (operator
 *     could have raised MAX_ATTEMPTS, behaviour shouldn't depend on
 *     attempt number when it's a known hard bounce)
 *   - Soft 4xx with attempts < MAX_ATTEMPTS → requeue, no suppression
 *   - Soft 4xx with attempts == MAX_ATTEMPTS → mark failed, fire
 *     email.failed (not email.bounced — soft escalation lives in the
 *     async DSN path, see #24)
 *   - Non-SMTP (network/DNS/TLS) error with attempts < MAX_ATTEMPTS →
 *     requeue, no suppression
 *   - Non-SMTP with attempts == MAX_ATTEMPTS → mark failed, fire
 *     email.failed
 */

interface CallLog {
  markEmailBounced: Array<{ id: string; lastError: string }>;
  markEmailFailed: Array<{ id: string; lastError: string }>;
  markEmailRequeued: Array<{ id: string; lastError: string }>;
  addFromBounce: Array<{
    apiKeyId: string;
    email: string;
    bounceType: "hard";
    diagnosticCode: string;
    sourceEmailId: string;
    expiresAt: null;
  }>;
  dispatchEvent: Array<{ event: string; data: Record<string, unknown> }>;
}

function makeDeps(): { deps: SendFailureDeps; calls: CallLog } {
  const calls: CallLog = {
    markEmailBounced: [],
    markEmailFailed: [],
    markEmailRequeued: [],
    addFromBounce: [],
    dispatchEvent: [],
  };

  return {
    calls,
    deps: {
      markEmailBounced: async (id, lastError) => {
        calls.markEmailBounced.push({ id, lastError });
      },
      markEmailFailed: async (id, lastError) => {
        calls.markEmailFailed.push({ id, lastError });
      },
      markEmailRequeued: async (id, lastError) => {
        calls.markEmailRequeued.push({ id, lastError });
      },
      addFromBounce: async (apiKeyId, input) => {
        calls.addFromBounce.push({ apiKeyId, ...input });
        return { id: "sup_inline123" };
      },
      dispatchEvent: (event, data) => {
        calls.dispatchEvent.push({ event, data });
      },
    },
  };
}

const EMAIL = {
  id: "msg_abc",
  apiKeyId: "key_xyz",
  fromAddress: "hello@yourdns.example",
  toAddress: "bad@example.com",
  subject: "test",
};

const GMAIL_550 =
  "Can't send mail - all recipients were rejected: 550-5.1.1 The email account that you tried to reach does not exist...";

const SOFT_452 = "452 4.2.2 Mailbox over quota; please try again later";

const NETWORK_ERR = "Error: connect ETIMEDOUT 142.250.65.108:25";

function ctx(attempt: number, errorMessage: string): SendFailureContext {
  return { email: EMAIL, attempt, errorMessage };
}

describe("handleSendFailure — inline 5xx (#68)", () => {
  test("attempt 1: suppresses, marks bounced, fires email.bounced, stops retrying", async () => {
    const { deps, calls } = makeDeps();

    const result = await handleSendFailure(ctx(1, GMAIL_550), deps);

    expect(result.outcome).toBe("auto-suppressed");
    expect(result.suppressionId).toBe("sup_inline123");

    /** Suppression created with the right shape. */
    expect(calls.addFromBounce).toHaveLength(1);
    expect(calls.addFromBounce[0]!.apiKeyId).toBe("key_xyz");
    expect(calls.addFromBounce[0]!.email).toBe("bad@example.com");
    expect(calls.addFromBounce[0]!.bounceType).toBe("hard");
    expect(calls.addFromBounce[0]!.diagnosticCode).toBe("5.1.1");
    expect(calls.addFromBounce[0]!.sourceEmailId).toBe("msg_abc");
    expect(calls.addFromBounce[0]!.expiresAt).toBeNull();

    /** Email marked bounced (not failed, not requeued). */
    expect(calls.markEmailBounced).toEqual([{ id: "msg_abc", lastError: GMAIL_550 }]);
    expect(calls.markEmailFailed).toEqual([]);
    expect(calls.markEmailRequeued).toEqual([]);

    /** Webhook fires email.bounced (not email.failed) with bounceType:hard + suppressionId. */
    expect(calls.dispatchEvent).toHaveLength(1);
    expect(calls.dispatchEvent[0]!.event).toBe("email.bounced");
    expect(calls.dispatchEvent[0]!.data.bounceType).toBe("hard");
    expect(calls.dispatchEvent[0]!.data.status).toBe("5.1.1");
    expect(calls.dispatchEvent[0]!.data.suppressionId).toBe("sup_inline123");
    expect(calls.dispatchEvent[0]!.data.source).toBe("inline");
  });

  test("auto-suppression doesn't depend on attempt number — 5xx on attempt 3 also suppresses", async () => {
    const { deps, calls } = makeDeps();

    const result = await handleSendFailure(ctx(3, GMAIL_550), deps);

    expect(result.outcome).toBe("auto-suppressed");
    expect(calls.markEmailBounced).toHaveLength(1);
    expect(calls.markEmailFailed).toEqual([]);
  });
});

describe("handleSendFailure — soft 4xx", () => {
  test("attempt 1 of 3: requeues, no suppression, no webhook", async () => {
    const { deps, calls } = makeDeps();

    const result = await handleSendFailure(ctx(1, SOFT_452), deps);

    expect(result.outcome).toBe("requeued");
    expect(calls.markEmailRequeued).toEqual([{ id: "msg_abc", lastError: SOFT_452 }]);
    expect(calls.markEmailBounced).toEqual([]);
    expect(calls.markEmailFailed).toEqual([]);
    expect(calls.addFromBounce).toEqual([]);
    expect(calls.dispatchEvent).toEqual([]);
  });

  test("attempt 3 of 3: marks failed, fires email.failed (no suppression on 4xx exhaustion)", async () => {
    const { deps, calls } = makeDeps();

    const result = await handleSendFailure(ctx(3, SOFT_452), deps);

    expect(result.outcome).toBe("permanently-failed");
    expect(calls.markEmailFailed).toEqual([{ id: "msg_abc", lastError: SOFT_452 }]);
    expect(calls.markEmailBounced).toEqual([]);
    expect(calls.markEmailRequeued).toEqual([]);
    expect(calls.addFromBounce).toEqual([]);
    expect(calls.dispatchEvent).toHaveLength(1);
    expect(calls.dispatchEvent[0]!.event).toBe("email.failed");
  });
});

describe("handleSendFailure — non-SMTP (infrastructure) errors", () => {
  test("network timeout on attempt 1 of 3: requeues with no SMTP-specific side effects", async () => {
    const { deps, calls } = makeDeps();

    const result = await handleSendFailure(ctx(1, NETWORK_ERR), deps);

    expect(result.outcome).toBe("requeued");
    expect(calls.markEmailRequeued).toHaveLength(1);
    expect(calls.addFromBounce).toEqual([]);
  });

  test("network timeout on attempt 3 of 3: marks failed, fires email.failed", async () => {
    const { deps, calls } = makeDeps();

    const result = await handleSendFailure(ctx(3, NETWORK_ERR), deps);

    expect(result.outcome).toBe("permanently-failed");
    expect(calls.markEmailFailed).toHaveLength(1);
    expect(calls.dispatchEvent[0]!.event).toBe("email.failed");
    expect(calls.addFromBounce).toEqual([]);
  });
});
