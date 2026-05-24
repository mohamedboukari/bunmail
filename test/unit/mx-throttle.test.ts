import { describe, test, expect, beforeEach } from "bun:test";
import { withMxLock, _inspectLock, _resetLocks } from "../../src/utils/mx-throttle.ts";

/**
 * Unit tests for the per-MX outbound throttle (#91).
 *
 * The throttle's contract:
 *   - Sends to the same MX serialize when concurrency = 1.
 *   - Sends to different MXs run in parallel.
 *   - With concurrency > 1, up to N callers run simultaneously on the
 *     same MX; the N+1th waits.
 *   - A throwing `fn` still releases the slot so the next waiter
 *     proceeds (no permanent deadlock on a single failure).
 *   - The lock table entry is removed when an MX drains to zero so
 *     the map doesn't grow unbounded under churn.
 *
 * Ordering is asserted by recording event timestamps rather than
 * faking timers — keeps the tests resilient to the exact resolution
 * of `setTimeout` while still proving "second call started AFTER
 * first call finished" (or didn't).
 */

/** Resolves after `ms` real ms — used to make ordering observable. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  _resetLocks();
});

describe("withMxLock", () => {
  test("two calls to the same MX with concurrency=1 serialize", async () => {
    const events: string[] = [];

    const a = withMxLock("mx.example.com", 1, async () => {
      events.push("a-start");
      await delay(40);
      events.push("a-end");
    });

    const b = withMxLock("mx.example.com", 1, async () => {
      events.push("b-start");
      await delay(10);
      events.push("b-end");
    });

    await Promise.all([a, b]);

    /** `b-start` must come after `a-end` — i.e. b waited for a to
     *  finish, even though b's own `fn` is much faster. */
    expect(events).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  test("calls to different MXs run in parallel", async () => {
    const events: string[] = [];

    const a = withMxLock("mx-a.example.com", 1, async () => {
      events.push("a-start");
      await delay(30);
      events.push("a-end");
    });

    const b = withMxLock("mx-b.example.com", 1, async () => {
      events.push("b-start");
      await delay(10);
      events.push("b-end");
    });

    await Promise.all([a, b]);

    /** b finishes before a — only possible if they ran concurrently. */
    expect(events).toEqual(["a-start", "b-start", "b-end", "a-end"]);
  });

  test("with concurrency=2, two callers same MX run in parallel, third waits", async () => {
    const events: string[] = [];

    const tasks = [
      withMxLock("mx.example.com", 2, async () => {
        events.push("1-start");
        await delay(40);
        events.push("1-end");
      }),
      withMxLock("mx.example.com", 2, async () => {
        events.push("2-start");
        await delay(40);
        events.push("2-end");
      }),
      withMxLock("mx.example.com", 2, async () => {
        events.push("3-start");
        await delay(10);
        events.push("3-end");
      }),
    ];

    await Promise.all(tasks);

    /** 1 and 2 start back-to-back (both grab a slot). 3 has to wait
     *  for one of them to release. So `3-start` appears after at
     *  least one of `1-end` / `2-end`. */
    const idx3Start = events.indexOf("3-start");
    const idx1End = events.indexOf("1-end");
    const idx2End = events.indexOf("2-end");
    expect(idx3Start).toBeGreaterThan(Math.min(idx1End, idx2End));

    /** And 1 + 2 do start before either one ends — proving parallelism. */
    expect(events.indexOf("1-start")).toBeLessThan(idx1End);
    expect(events.indexOf("2-start")).toBeLessThan(idx2End);
    expect(events.indexOf("2-start")).toBeLessThan(idx1End);
  });

  test("a throwing fn still releases the slot for the next waiter", async () => {
    const events: string[] = [];

    const a = withMxLock("mx.example.com", 1, async () => {
      events.push("a-start");
      await delay(10);
      throw new Error("boom");
    });

    const b = withMxLock("mx.example.com", 1, async () => {
      events.push("b-start");
    });

    /** a rejects but we still expect b to run — Promise.allSettled
     *  surfaces both outcomes without aborting on the rejection. */
    const results = await Promise.allSettled([a, b]);
    expect(results[0]!.status).toBe("rejected");
    expect(results[1]!.status).toBe("fulfilled");
    expect(events).toEqual(["a-start", "b-start"]);
  });

  test("lock entry is GC'd after the last caller releases", async () => {
    await withMxLock("mx-cleanup.example.com", 1, async () => {
      /** Mid-flight, the entry exists with active=1. */
      expect(_inspectLock("mx-cleanup.example.com")).toEqual({ active: 1, waiting: 0 });
    });

    /** Once the last caller releases, the entry is removed entirely. */
    expect(_inspectLock("mx-cleanup.example.com")).toBeUndefined();
  });

  test("returns the value resolved by fn", async () => {
    const value = await withMxLock("mx.example.com", 1, async () => 42);
    expect(value).toBe(42);
  });

  test("FIFO order is preserved when multiple callers wait", async () => {
    const events: string[] = [];

    const tasks = [
      withMxLock("mx.example.com", 1, async () => {
        events.push("1");
        await delay(20);
      }),
      withMxLock("mx.example.com", 1, async () => {
        events.push("2");
        await delay(5);
      }),
      withMxLock("mx.example.com", 1, async () => {
        events.push("3");
        await delay(5);
      }),
      withMxLock("mx.example.com", 1, async () => {
        events.push("4");
        await delay(5);
      }),
    ];

    await Promise.all(tasks);

    /** All four queued at submit-time; the queue must drain in order. */
    expect(events).toEqual(["1", "2", "3", "4"]);
  });
});
