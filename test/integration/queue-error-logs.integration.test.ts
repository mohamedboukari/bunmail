/**
 * A send attempt that fails on a database error (#458), against a real
 * Postgres. A drizzle query error's message embeds the query and its bound
 * values (the recipient, the subject), and the queue's one-shot failure
 * path used to store it in `emails.last_error` (shown in the dashboard and
 * the API), copy it into the `email.failed` webhook payload and log it.
 * All three now carry `loggableError`'s text: the SQLSTATE only.
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
import { DrizzleQueryError, eq } from "drizzle-orm";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import { logger } from "../../src/utils/logger.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";

const RECIPIENT = "reader@example.org";
const SUBJECT = "Quarterly numbers for the board";
const SANITIZED = "Database query failed (SQLSTATE 23514)";

/** A failed query as drizzle raises it: the message carries every parameter. */
function drizzleError(params: unknown[]): DrizzleQueryError {
  const cause = Object.assign(new Error("injected failure"), { errno: "23514" });
  return new DrizzleQueryError(
    "select * from suppressions where email = $1 and subject = $2",
    params,
    cause,
  );
}

let spies: Mock<(message: string, data?: Record<string, unknown>) => void>[] = [];

beforeEach(async () => {
  await truncateAll();
  spies = (["debug", "info", "warn", "error"] as const).map((level) =>
    spyOn(logger, level).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

describe("queue send path: a database error", () => {
  test("never reaches last_error, the email.failed payload or the log", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34/hook",
      events: ["email.failed"],
    });
    const { id: emailId } = await seed.email({
      apiKeyId,
      toAddress: RECIPIENT,
      subject: SUBJECT,
    });

    await runQueueCycle({
      sendMail: () => Promise.reject(drizzleError([RECIPIENT, SUBJECT])),
      signedReturnPath: () => Promise.resolve(false),
    });

    const [row] = await db
      .select({ status: emails.status, lastError: emails.lastError })
      .from(emails)
      .where(eq(emails.id, emailId));
    expect(row).toEqual({ status: "failed", lastError: SANITIZED });

    const [delivery] = await db
      .select({ payload: webhookDeliveries.payload })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.event, "email.failed"));
    const envelope: { data: { error: unknown } } = JSON.parse(delivery?.payload ?? "{}");
    expect(envelope.data.error).toBe(SANITIZED);

    const errorCalls = spies[3]!.mock.calls.filter(
      ([text]) => text === "Email permanently failed (input error)",
    );
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]?.[1]).toMatchObject({ emailId, error: SANITIZED });

    /**
     * `Processing email` names the first recipient through `redactEmail`,
     * which leaves it whole with `LOG_REDACT_PII` off (tests): the failure
     * lines are checked for it, everything for the subject.
     */
    expect(JSON.stringify(spies.map((spy) => spy.mock.calls))).not.toContain(SUBJECT);
    const failures = JSON.stringify([spies[2]!.mock.calls, spies[3]!.mock.calls]);
    expect(failures).not.toContain(RECIPIENT);
  });

  test("an input error keeps its own message", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: emailId } = await seed.email({ apiKeyId });

    await runQueueCycle({
      sendMail: () =>
        Promise.reject(new Error("No valid recipients after parsing to/cc/bcc")),
      signedReturnPath: () => Promise.resolve(false),
    });

    const [row] = await db
      .select({ lastError: emails.lastError })
      .from(emails)
      .where(eq(emails.id, emailId));
    expect(row?.lastError).toBe("No valid recipients after parsing to/cc/bcc");
  });
});
