/**
 * Unit tests for the webhook delivery retry scheduler (#30).
 *
 * `nextAttemptAt(attempts, now)` is the pure function the worker uses
 * after a failed attempt to decide:
 *   - Should we reschedule? (return a Date)
 *   - Or have we exhausted retries? (return null → flip status to `failed`)
 *
 * The contract is documented on `RETRY_BACKOFF_MINUTES`:
 *   attempts=1 just-failed → wait 1m
 *   attempts=2 just-failed → wait 5m
 *   attempts=3 just-failed → wait 15m
 *   attempts=4 just-failed → wait 1h
 *   attempts=5 just-failed → null (cap reached, terminate at `failed`)
 */

import { describe, test, expect } from "bun:test";
import {
  nextAttemptAt,
  RETRY_BACKOFF_MINUTES,
  MAX_DELIVERY_ATTEMPTS,
} from "../../src/modules/webhooks/services/webhook-delivery.service.ts";

const NOW = new Date("2026-05-10T12:00:00.000Z");

describe("nextAttemptAt — backoff schedule", () => {
  test("attempts=1 → wait 1 minute", () => {
    const next = nextAttemptAt(1, NOW)!;
    expect(next.getTime() - NOW.getTime()).toBe(1 * 60_000);
  });

  test("attempts=2 → wait 5 minutes", () => {
    const next = nextAttemptAt(2, NOW)!;
    expect(next.getTime() - NOW.getTime()).toBe(5 * 60_000);
  });

  test("attempts=3 → wait 15 minutes", () => {
    const next = nextAttemptAt(3, NOW)!;
    expect(next.getTime() - NOW.getTime()).toBe(15 * 60_000);
  });

  test("attempts=4 → wait 1 hour", () => {
    const next = nextAttemptAt(4, NOW)!;
    expect(next.getTime() - NOW.getTime()).toBe(60 * 60_000);
  });

  test("attempts=5 → null (cap reached, terminate at failed)", () => {
    /** RETRY_BACKOFF_MINUTES has 4 entries; the 5th attempt is the final one,
     *  after which the row settles at `failed` with no further reschedule. */
    expect(nextAttemptAt(5, NOW)).toBeNull();
  });

  test("attempts=99 (defensive) → null", () => {
    expect(nextAttemptAt(99, NOW)).toBeNull();
  });

  test("attempts=0 (defensive — caller bug) → null", () => {
    /** A fresh enqueue has attempts=0; we should never call this with 0
     *  in production, but if we do, return null rather than fall off the
     *  end of the array. */
    expect(nextAttemptAt(0, NOW)).toBeNull();
  });
});

describe("schedule constants — contract", () => {
  test("RETRY_BACKOFF_MINUTES matches the documented schedule", () => {
    /** If this changes, update CHANGELOG, docs/webhooks.md, and the
     *  acceptance criteria in #30 in lockstep — it's a behavioural
     *  contract operators rely on. */
    expect([...RETRY_BACKOFF_MINUTES]).toEqual([1, 5, 15, 60]);
  });

  test("MAX_DELIVERY_ATTEMPTS is one more than the schedule length", () => {
    /** The first attempt fires immediately on enqueue — it doesn't use
     *  the schedule. Each subsequent attempt consumes one schedule entry.
     *  So with 4 schedule entries, we get 5 attempts total. */
    expect(MAX_DELIVERY_ATTEMPTS).toBe(RETRY_BACKOFF_MINUTES.length + 1);
    expect(MAX_DELIVERY_ATTEMPTS).toBe(5);
  });
});
