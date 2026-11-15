/**
 * A send attempt that fails before reaching an MX host, against a real
 * Postgres.
 *
 * #458: a drizzle query error's message embeds the query and its bound
 * values (the recipient, the subject), and the queue used to store it in
 * `emails.last_error` (shown in the dashboard and the API), copy it into
 * the `email.failed` webhook payload and log it. All three now carry
 * `loggableError`'s text: the SQLSTATE only.
 *
 * #474: only an input error (`UnsendableEmailError`) fails the email at
 * once. A database error, or one nobody expected, puts it back on the
 * retry backoff, with no webhook, until `MAIL_RETRY_MAX_AGE_HOURS`.
 *
 * The logger is spied, not mocked: the assertions read the raw arguments
 * of each call, so they check the call sites, not the logger's redaction.
 */
import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  spyOn,
  type Mock,
} from "bun:test";
import { DrizzleQueryError, eq, sql } from "drizzle-orm";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import { attachmentStorage } from "../../src/modules/emails/services/attachment-storage.ts";
import { UnsendableEmailError } from "../../src/modules/emails/errors.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import { logger } from "../../src/utils/logger.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";

const RECIPIENT = "reader@example.org";
const SUBJECT = "Quarterly numbers for the board";

/** A failed query as drizzle raises it: the message carries every parameter. */
function drizzleError(sqlState: string, params: unknown[]): DrizzleQueryError {
  const cause = Object.assign(new Error("injected failure"), { errno: sqlState });
  return new DrizzleQueryError(
    "select * from email_attachments where email = $1 and subject = $2",
    params,
    cause,
  );
}

/** The mailer must not be reached when preparing the send fails. */
let mailerCalls = 0;
const deps = {
  sendMail: () => {
    mailerCalls += 1;
    return Promise.reject(new Error("the mailer must not be called"));
  },
  signedReturnPath: () => Promise.resolve(false),
};

let spies: Mock<(message: string, data?: Record<string, unknown>) => void>[] = [];

beforeEach(async () => {
  await truncateAll();
  mailerCalls = 0;
  spies = (["debug", "info", "warn", "error"] as const).map((level) =>
    spyOn(logger, level).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

/** Makes the attachments load, a database read while preparing the send, throw. */
function failAttachmentsLoad(error: unknown): { mockRestore(): void } {
  return spyOn(attachmentStorage, "loadAttachments").mockRejectedValue(error);
}

async function row(emailId: string) {
  const [r] = await db
    .select({
      status: emails.status,
      lastError: emails.lastError,
      attempts: emails.attempts,
      lockedBy: emails.lockedBy,
      leaseUntil: emails.leaseUntil,
      inFuture: sql<boolean>`${emails.nextAttemptAt} > NOW() + interval '4 minutes'`,
    })
    .from(emails)
    .where(eq(emails.id, emailId));
  if (!r) throw new Error(`email ${emailId} not found`);
  return r;
}

async function failedEvents() {
  return db
    .select({ payload: webhookDeliveries.payload })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.event, "email.failed"));
}

/** Calls to one logger level (2 `warn`, 3 `error`) with this message. */
function logged(level: 2 | 3, message: string) {
  return spies[level]!.mock.calls.filter(([text]) => text === message);
}

/** A queued email from a key that has an `email.failed` webhook. */
async function queuedEmail(): Promise<string> {
  const { id: apiKeyId } = await seed.apiKey();
  await seed.webhook({
    apiKeyId,
    url: "https://93.184.216.34/hook",
    events: ["email.failed"],
  });
  const { id } = await seed.email({ apiKeyId, toAddress: RECIPIENT, subject: SUBJECT });
  return id;
}

describe("queue send path: a transient database error (#474)", () => {
  for (const sqlState of ["40001", "08006"]) {
    test(`SQLSTATE ${sqlState} requeues the email on the backoff, no webhook`, async () => {
      const emailId = await queuedEmail();
      const sanitized = `Database query failed (SQLSTATE ${sqlState})`;
      const load = failAttachmentsLoad(drizzleError(sqlState, [RECIPIENT, SUBJECT]));
      try {
        await runQueueCycle(deps);
      } finally {
        load.mockRestore();
      }

      expect(mailerCalls).toBe(0);
      expect(await row(emailId)).toEqual({
        status: "queued",
        lastError: sanitized,
        /** Counted like a temporary SMTP failure: the claim's increment stays. */
        attempts: 1,
        lockedBy: null,
        leaseUntil: null,
        /** Attempt 1 waits 5 minutes (`retry-schedule.ts`). */
        inFuture: true,
      });
      expect(await failedEvents()).toHaveLength(0);

      const warnings = logged(2, "Email requeued: temporary error before sending");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.[1]).toMatchObject({
        emailId,
        attempt: 1,
        error: sanitized,
        retryInSeconds: 300,
      });
      expect(logged(3, "Email permanently failed (input error)")).toHaveLength(0);

      /** No hot loop: the next cycle finds nothing due. */
      await runQueueCycle(deps);
      expect((await row(emailId)).attempts).toBe(1);

      expect(JSON.stringify(spies.map((spy) => spy.mock.calls))).not.toContain(SUBJECT);
      const failures = JSON.stringify([spies[2]!.mock.calls, spies[3]!.mock.calls]);
      expect(failures).not.toContain(RECIPIENT);
    });
  }

  test("past the retry window, it fails with a sanitized email.failed", async () => {
    const emailId = await queuedEmail();
    await db
      .update(emails)
      .set({ createdAt: sql`NOW() - interval '49 hours'` })
      .where(eq(emails.id, emailId));
    const sanitized = "Database query failed (SQLSTATE 08006)";
    const load = failAttachmentsLoad(drizzleError("08006", [RECIPIENT, SUBJECT]));
    try {
      await runQueueCycle(deps);
    } finally {
      load.mockRestore();
    }

    const r = await row(emailId);
    expect(r.status).toBe("failed");
    expect(r.lastError).toBe(sanitized);

    const [delivery] = await failedEvents();
    const envelope: { data: { error: unknown } } = JSON.parse(delivery?.payload ?? "{}");
    expect(envelope.data.error).toBe(sanitized);

    const errors = logged(
      3,
      "Email failed: error before sending for the whole retry window",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[1]).toMatchObject({ emailId, error: sanitized });
    expect(JSON.stringify(spies.map((spy) => spy.mock.calls))).not.toContain(SUBJECT);
  });

  test("an unexpected error is retried too, logged at error", async () => {
    const emailId = await queuedEmail();

    await runQueueCycle({
      ...deps,
      sendMail: () => Promise.reject(new Error("something nobody expected")),
    });

    const r = await row(emailId);
    expect(r.status).toBe("queued");
    expect(r.lastError).toBe("something nobody expected");
    expect(r.inFuture).toBe(true);
    expect(await failedEvents()).toHaveLength(0);
    expect(logged(3, "Email requeued: unexpected error before sending")).toHaveLength(1);
  });
});

describe("queue send path: an input error", () => {
  test("fails the email at once with email.failed and its own message", async () => {
    const emailId = await queuedEmail();
    const message = "No valid recipients after parsing to/cc/bcc";

    await runQueueCycle({
      ...deps,
      sendMail: () => Promise.reject(new UnsendableEmailError(message)),
    });

    const r = await row(emailId);
    expect(r.status).toBe("failed");
    expect(r.lastError).toBe(message);

    const [delivery] = await failedEvents();
    const envelope: { data: { error: unknown } } = JSON.parse(delivery?.payload ?? "{}");
    expect(envelope.data.error).toBe(message);

    const errors = logged(3, "Email permanently failed (input error)");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[1]).toMatchObject({ emailId, error: message });
  });
});
