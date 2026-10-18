/**
 * Overall deadline on one outbound SMTP session (#250). Pure: a fake
 * transport, no SMTP and no database; in the integration tier because the
 * mailer module reads the real config, which unit tests stub.
 */
import { describe, test, expect } from "bun:test";
import { sendWithDeadline } from "../../src/modules/emails/services/mailer.service.ts";
import { classifySendFailure } from "../../src/utils/smtp-error.ts";

function fakeTransport(send: () => Promise<unknown>) {
  let closed = 0;
  return {
    transport: { sendMail: send, close: () => void (closed += 1) },
    closed: () => closed,
  };
}

describe("sendWithDeadline", () => {
  test("a session past the deadline is closed and fails as retryable", async () => {
    const { transport, closed } = fakeTransport(() => new Promise(() => {}));
    let caught: unknown;
    try {
      await sendWithDeadline(transport, {}, 50);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain("SMTP session exceeded");
    expect(closed()).toBe(1);
    /** No SMTP reply in it: retried later, never read as a bounce. */
    expect(classifySendFailure(caught)).toBeNull();
  });

  test("a session that finishes in time is not closed", async () => {
    const { transport, closed } = fakeTransport(async () => ({
      accepted: ["a@example.org"],
    }));
    await sendWithDeadline(transport, {}, 1_000);
    await Bun.sleep(20);
    expect(closed()).toBe(0);
  });

  test("an SMTP rejection passes through unchanged", async () => {
    const reject = Object.assign(new Error("550 5.1.1 unknown"), {
      responseCode: 550,
      response: "550 5.1.1 unknown",
    });
    const { transport } = fakeTransport(() => Promise.reject(reject));
    let caught: unknown;
    try {
      await sendWithDeadline(transport, {}, 1_000);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBe(reject);
    expect(classifySendFailure(caught)?.kind).toBe("hard");
  });
});
