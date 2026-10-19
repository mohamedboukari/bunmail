/**
 * `SUPPRESSIONS_SHARED_HARD` (#250), against a real Postgres: with the
 * flag on, every send gate (`createEmail` for the REST API and SMTP
 * submission, and the queue's re-check before a retry, #262) also refuses
 * an address that ANOTHER key holds an automatic permanent hard bounce or
 * complaint for. With it off (the default) suppressions stay per key.
 *
 * Unsubscribe, manual (whatever reason the tenant gave) and temporary
 * rows never cross keys, and the refusal never names the other key or
 * its row. The last test checks the partial index serves the lookup.
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { config } from "../../src/config.ts";
import { createEmail } from "../../src/modules/emails/services/email.service.ts";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import type { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import {
  addFromBounce,
  addFromComplaint,
  addFromUnsubscribe,
  createSuppression,
  isSuppressed,
  sharedHardSuppressionWhere,
} from "../../src/modules/suppressions/services/suppression.service.ts";
import { SuppressedRecipientError } from "../../src/modules/suppressions/errors.ts";
import * as smtpSubmission from "../../src/modules/smtp-submission/services/smtp-submission.service.ts";
import { logger } from "../../src/utils/logger.ts";
import { truncateAll, seed, db, emails, suppressions } from "./_helpers.ts";

const RECIPIENT = "shared@example.org";

/** Isolated port for the submission server of the SMTP test. */
const TEST_PORT = 12611;

/** Runtime handles on the flags (config is read at import time). */
const flags = config.suppressions as { sharedHard: boolean };
const originalShared = config.suppressions.sharedHard;
const logFlags = config as { logRedactPii: boolean };
const originalRedact = config.logRedactPii;

interface Keys {
  keyA: string;
  keyB: string;
  /** Key B's raw key, for SMTP submission. */
  rawB: string;
  /** An email key A sent to `RECIPIENT`, the source of its automatic rows. */
  emailA: string;
}

async function keys(): Promise<Keys> {
  const { id: keyA } = await seed.apiKey({ name: "tenant-a" });
  const { id: keyB, rawKey: rawB } = await seed.apiKey({ name: "tenant-b" });
  const { id: emailA } = await seed.email({
    apiKeyId: keyA,
    toAddress: RECIPIENT,
    status: "sent",
  });
  return { keyA, keyB, rawB, emailA };
}

/** Key A's inline hard bounce, as the queue files it. */
async function hardBounceUnderA(k: Keys): Promise<string> {
  const { suppression } = await addFromBounce(k.keyA, {
    email: RECIPIENT,
    bounceType: "hard",
    diagnosticCode: "5.1.1",
    sourceEmailId: k.emailA,
    expiresAt: null,
  });
  return suppression?.id ?? "";
}

/** A REST send from key B to `RECIPIENT`; the error it throws, if any. */
async function sendAsB(k: Keys): Promise<unknown> {
  return createEmail(
    { from: "hello@example.com", to: RECIPIENT, subject: "hi", html: "<p>hi</p>" },
    k.keyB,
  ).then(
    () => null,
    (error: unknown) => error,
  );
}

beforeEach(async () => {
  await truncateAll();
  flags.sharedHard = originalShared;
});

afterEach(() => {
  flags.sharedHard = originalShared;
  logFlags.logRedactPii = originalRedact;
});

describe("SUPPRESSIONS_SHARED_HARD=false (default)", () => {
  test("a hard bounce under key A does not block key B", async () => {
    flags.sharedHard = false;
    const k = await keys();
    await hardBounceUnderA(k);

    expect(await isSuppressed(k.keyA, RECIPIENT)).toMatchObject({ shared: false });
    expect(await isSuppressed(k.keyB, RECIPIENT)).toBeUndefined();
    expect(await sendAsB(k)).toBeNull();
  });
});

describe("SUPPRESSIONS_SHARED_HARD=true", () => {
  beforeEach(() => {
    flags.sharedHard = true;
  });

  test("a hard bounce under key A blocks key B with the usual error, naming nothing of A", async () => {
    const k = await keys();
    const rowA = await hardBounceUnderA(k);
    /** Production redaction, so the log lines can be checked for the address. */
    logFlags.logRedactPii = true;

    const infos: unknown[][] = [];
    const warns: unknown[][] = [];
    const infoSpy = spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      infos.push(args);
    });
    const warnSpy = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args);
    });
    let error: unknown;
    try {
      error = await sendAsB(k);
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(error).toBeInstanceOf(SuppressedRecipientError);
    if (!(error instanceof SuppressedRecipientError)) return;
    expect(error.suppressionId).toBeNull();
    expect(error.message).toMatch(/Recipient is on the suppression list/);
    const exposed = JSON.stringify({
      message: error.message,
      suppressionId: error.suppressionId,
      recipient: error.recipient,
    });
    expect(exposed).not.toContain(k.keyA);
    expect(exposed).not.toContain(rowA);

    /** Logged as shared, with the requesting key and a redacted address only. */
    expect(infos).toContainEqual([
      "Shared suppression applied",
      { apiKeyId: k.keyB, email: expect.not.stringContaining("shared@") },
    ]);
    const logged = JSON.stringify([...infos, ...warns]);
    expect(logged).not.toContain(k.keyA);
    expect(logged).not.toContain(rowA);
    expect(logged).not.toContain(RECIPIENT);

    /** Nothing was queued for key B. */
    const queued = await db.select().from(emails).where(eq(emails.apiKeyId, k.keyB));
    expect(queued).toEqual([]);
  });

  test("a complaint under key A blocks key B", async () => {
    const k = await keys();
    await addFromComplaint({ apiKeyId: k.keyA, email: RECIPIENT, emailId: k.emailA });

    expect(await isSuppressed(k.keyB, RECIPIENT)).toEqual({ shared: true });
    expect(await sendAsB(k)).toBeInstanceOf(SuppressedRecipientError);
  });

  test("key B's own row wins: its id is returned as before", async () => {
    const k = await keys();
    await hardBounceUnderA(k);
    const own = await createSuppression(k.keyB, { email: RECIPIENT, reason: "manual" });

    const error = await sendAsB(k);
    expect(error).toBeInstanceOf(SuppressedRecipientError);
    if (error instanceof SuppressedRecipientError) {
      expect(error.suppressionId).toBe(own.id);
    }
  });

  test("key A's unsubscribe and manual rows never block key B, whatever reason they give", async () => {
    const k = await keys();
    await addFromUnsubscribe({
      apiKeyId: k.keyA,
      email: RECIPIENT,
      emailId: k.emailA,
      source: "one_click",
    });
    await createSuppression(k.keyA, { email: "manual@example.org", reason: "manual" });
    /** A tenant's manual entry labelled `bounce` or `complaint` is still its own decision. */
    await createSuppression(k.keyA, { email: "labelled@example.org", reason: "bounce" });
    await createSuppression(k.keyA, {
      email: "claimed@example.org",
      reason: "complaint",
    });

    for (const address of [
      RECIPIENT,
      "manual@example.org",
      "labelled@example.org",
      "claimed@example.org",
    ]) {
      expect(await isSuppressed(k.keyA, address)).toMatchObject({ shared: false });
      expect(await isSuppressed(k.keyB, address)).toBeUndefined();
    }
    expect(await sendAsB(k)).toBeNull();
  });

  test("temporary rows under key A never block key B", async () => {
    const k = await keys();
    await addFromBounce(k.keyA, {
      email: RECIPIENT,
      bounceType: "soft",
      diagnosticCode: "4.2.2",
      sourceEmailId: k.emailA,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    /** A complaint entry with an expiry (a manual upsert can give one) is temporary too. */
    await seed.suppression({
      apiKeyId: k.keyA,
      email: "expiring@example.org",
      reason: "complaint",
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });

    expect(await isSuppressed(k.keyB, RECIPIENT)).toBeUndefined();
    expect(await isSuppressed(k.keyB, "expiring@example.org")).toBeUndefined();
    expect(await sendAsB(k)).toBeNull();
  });

  test("the queue's re-check before a retry (#262) drops the recipient", async () => {
    const k = await keys();
    const { id } = await seed.email({ apiKeyId: k.keyB, toAddress: RECIPIENT });
    await db
      .update(emails)
      .set({
        attempts: 1,
        deliveryState: {
          "example.org": {
            status: "retry",
            recipients: [RECIPIENT],
            attempts: 1,
            lastError: "421 later",
          },
        },
      })
      .where(eq(emails.id, id));
    await hardBounceUnderA(k);

    const seen: Array<Parameters<typeof sendMail>[0]["existingState"]> = [];
    const mailer: typeof sendMail = async (options) => {
      seen.push(options.existingState);
      return { messageId: options.messageId, deliveryState: options.existingState ?? {} };
    };
    await runQueueCycle({ sendMail: mailer, signedReturnPath: async () => false });

    expect(seen[0]?.["example.org"]?.status).toBe("failed");
    const [row] = await db.select().from(emails).where(eq(emails.id, id));
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("suppressed before this retry");
  });

  describe("SMTP submission", () => {
    beforeAll(() => {
      smtpSubmission.start(TEST_PORT);
    });

    afterAll(() => {
      smtpSubmission.stop();
    });

    test("refuses key B's message with 550 and queues nothing", async () => {
      const k = await keys();
      await hardBounceUnderA(k);
      const transport = createTransport({
        host: "127.0.0.1",
        port: TEST_PORT,
        secure: false,
        ignoreTLS: true,
        auth: { user: "apikey", pass: k.rawB },
      });

      const error = await transport
        .sendMail({
          from: "hello@unregistered.test",
          to: RECIPIENT,
          subject: "via smtp",
          text: "hi",
        })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error ? error.message : "").toContain("550");
      expect(error instanceof Error ? error.message : "").not.toContain(k.keyA);
      const queued = await db.select().from(emails).where(eq(emails.apiKeyId, k.keyB));
      expect(queued).toEqual([]);
    });
  });
});

describe("the shared lookup uses suppressions_shared_hard_email_idx", () => {
  test("EXPLAIN on a seeded table names the partial index", async () => {
    const k = await keys();
    /** 4000 rows over two keys, most of them per-key reasons, then fresh statistics. */
    await db.execute(sql`
      INSERT INTO suppressions (id, api_key_id, email, reason, bounce_type, expires_at)
      SELECT 'sup_seed' || g,
        CASE WHEN g % 2 = 0 THEN ${k.keyA} ELSE ${k.keyB} END,
        'user' || g || '@example.net',
        CASE g % 4 WHEN 0 THEN 'bounce' WHEN 1 THEN 'complaint'
          WHEN 2 THEN 'unsubscribe' ELSE 'manual' END,
        CASE WHEN g % 4 = 0 THEN 'hard' END,
        CASE WHEN g % 8 = 0 THEN NOW() + interval '1 day' END
      FROM generate_series(1, 4000) AS g`);
    await db.execute(sql`ANALYZE suppressions`);

    const plan = await db.execute(
      sql`EXPLAIN SELECT ${suppressions.id} FROM ${suppressions} WHERE ${sharedHardSuppressionWhere("user8@example.net")} LIMIT 1`,
    );
    const text = JSON.stringify(plan);
    expect(text).toContain("suppressions_shared_hard_email_idx");
  });
});
