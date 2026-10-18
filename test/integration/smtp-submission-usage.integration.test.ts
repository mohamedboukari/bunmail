/**
 * Integration tests for SMTP submission usage tracking + per-key daily
 * quota (#123) against a real Postgres and a real Nodemailer client.
 *
 * Covers the usage service (recordOutcome / getAcceptedToday / getStats)
 * directly, and the quota-enforcement branch end-to-end through the live
 * submission server.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createTransport } from "nodemailer";
import * as smtpSubmission from "../../src/modules/smtp-submission/services/smtp-submission.service.ts";
import * as usage from "../../src/modules/smtp-submission/services/usage.service.ts";
import { config } from "../../src/config.ts";
import { truncateAll, seed, db } from "./_helpers.ts";
import { smtpSubmissionUsage } from "../../src/modules/smtp-submission/models/smtp-submission-usage.schema.ts";

const TEST_PORT = 12588;

function transport(pass: string) {
  return createTransport({
    host: "127.0.0.1",
    port: TEST_PORT,
    secure: false,
    ignoreTLS: true,
    auth: { user: "apikey", pass },
    tls: { rejectUnauthorized: false },
  });
}

/** Runtime handle to flip the daily quota per-test (config is import-time). */
const quotaConfig = config.smtpSubmission as { dailyQuota: number };
const originalQuota = quotaConfig.dailyQuota;

/** Awaits a send that must fail and returns its error message. */
async function failureOf(send: Promise<unknown>): Promise<string> {
  try {
    await send;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the submission to be rejected");
}

beforeAll(() => {
  smtpSubmission.start(TEST_PORT);
});

afterAll(() => {
  smtpSubmission.stop();
  quotaConfig.dailyQuota = originalQuota;
});

beforeEach(async () => {
  await truncateAll();
  quotaConfig.dailyQuota = originalQuota;
});

describe("usage service", () => {
  test("recordOutcome upserts and increments the day's counters", async () => {
    const { id: apiKeyId } = await seed.apiKey();

    await usage.recordOutcome(apiKeyId, "accepted");
    await usage.recordOutcome(apiKeyId, "accepted");
    await usage.recordOutcome(apiKeyId, "rejected");

    expect(await usage.getAcceptedToday(apiKeyId)).toBe(2);

    /** Exactly one row per (key, day): the upsert, not one row per event. */
    const rows = await db.select().from(smtpSubmissionUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accepted).toBe(2);
    expect(rows[0]!.rejected).toBe(1);
  });

  test("getAcceptedToday is 0 for a key with no usage", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    expect(await usage.getAcceptedToday(apiKeyId)).toBe(0);
  });

  test("getStats returns per-day rows and window totals", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    await usage.recordOutcome(apiKeyId, "accepted");
    await usage.recordOutcome(apiKeyId, "rejected");

    const stats = await usage.getStats(apiKeyId, 7);
    expect(stats.days).toBe(7);
    expect(stats.totals).toEqual({ accepted: 1, rejected: 1 });
    expect(stats.daily).toHaveLength(1);
    expect(stats.daily[0]!.accepted).toBe(1);
    expect(stats.daily[0]!.rejected).toBe(1);
  });

  test("usage is isolated per API key", async () => {
    const { id: keyA } = await seed.apiKey({ name: "a" });
    const { id: keyB } = await seed.apiKey({ name: "b" });
    await usage.recordOutcome(keyA, "accepted");

    expect(await usage.getAcceptedToday(keyA)).toBe(1);
    expect(await usage.getAcceptedToday(keyB)).toBe(0);
  });
});

describe("daily quota enforcement (live server)", () => {
  test("submissions beyond the quota are rejected with a temporary failure", async () => {
    quotaConfig.dailyQuota = 1;
    const { id: apiKeyId, rawKey } = await seed.apiKey();

    /** First send is within quota → accepted. */
    const first = await transport(rawKey).sendMail({
      from: "hello@unregistered.test",
      to: "user@example.org",
      subject: "one",
      text: "hi",
    });
    expect(first.accepted.length).toBeGreaterThan(0);

    /** Second send is over quota → rejected. */
    expect(
      transport(rawKey).sendMail({
        from: "hello@unregistered.test",
        to: "user@example.org",
        subject: "two",
        text: "hi",
      }),
    ).rejects.toThrow();

    /** Exactly one accepted; the over-quota attempt counted as rejected. */
    expect(await usage.getAcceptedToday(apiKeyId)).toBe(1);
    const stats = await usage.getStats(apiKeyId, 1);
    expect(stats.totals.accepted).toBe(1);
    expect(stats.totals.rejected).toBeGreaterThanOrEqual(1);
  });

  test("quota of 0 (unlimited) never rejects on volume", async () => {
    quotaConfig.dailyQuota = 0;
    const { id: apiKeyId, rawKey } = await seed.apiKey();

    for (const subject of ["a", "b", "c"]) {
      await transport(rawKey).sendMail({
        from: "hello@unregistered.test",
        to: "user@example.org",
        subject,
        text: "hi",
      });
    }
    expect(await usage.getAcceptedToday(apiKeyId)).toBe(3);
  });
});

describe("atomic daily quota (#190)", () => {
  test("concurrent reservations never take more than the quota", async () => {
    const { id: apiKeyId } = await seed.apiKey();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => usage.reserveAccepted(apiKeyId, 3)),
    );

    expect(results.filter((day) => day !== null)).toHaveLength(3);
    expect(await usage.getAcceptedToday(apiKeyId)).toBe(3);
  });

  test("a released reservation frees its slot and is recorded as rejected", async () => {
    const { id: apiKeyId } = await seed.apiKey();

    const day = await usage.reserveAccepted(apiKeyId, 1);
    expect(day).not.toBeNull();
    expect(await usage.reserveAccepted(apiKeyId, 1)).toBeNull();

    await usage.releaseReservation(apiKeyId, day ?? "");
    const stats = await usage.getStats(apiKeyId, 1);
    expect(stats.totals).toEqual({ accepted: 0, rejected: 1 });

    expect(await usage.reserveAccepted(apiKeyId, 1)).not.toBeNull();
  });

  test("a rejected submission does not use up the quota (live server)", async () => {
    quotaConfig.dailyQuota = 1;
    const { id: apiKeyId, rawKey } = await seed.apiKey();

    /** Headers name a recipient that was never in RCPT TO: rejected after the reservation. */
    const rejected = await failureOf(
      transport(rawKey).sendMail({
        from: "hello@unregistered.test",
        to: "user@example.org",
        envelope: { from: "hello@unregistered.test", to: ["other@example.org"] },
        subject: "rejected",
        text: "hi",
      }),
    );
    expect(rejected).toContain("550");

    const accepted = await transport(rawKey).sendMail({
      from: "hello@unregistered.test",
      to: "user@example.org",
      subject: "accepted",
      text: "hi",
    });
    expect(accepted.accepted.length).toBeGreaterThan(0);

    const stats = await usage.getStats(apiKeyId, 1);
    expect(stats.totals).toEqual({ accepted: 1, rejected: 1 });
  });
});
