import { describe, test, expect, afterEach } from "bun:test";
import {
  EXPORT_MAX_CONCURRENT,
  EXPORT_MAX_PER_WINDOW,
  EXPORT_WINDOW_MS,
  acquireExportSlot,
  activeExportCount,
  exportBudgetMap,
  resetExportSlots,
  takeExportBudget,
} from "../../src/pages/lib/export-limiter.ts";

/**
 * The CSV export limits (#430) on their own, in process memory (no
 * `REDIS_URL` in unit tests): the per-user budget and the per-process
 * slot cap. The routes' use of them is in the integration tier.
 */

afterEach(() => {
  resetExportSlots();
  exportBudgetMap.clear();
});

describe("acquireExportSlot", () => {
  test("at most EXPORT_MAX_CONCURRENT slots at once; a release frees one", () => {
    const releases = Array.from({ length: EXPORT_MAX_CONCURRENT }, () =>
      acquireExportSlot(),
    );
    expect(releases.every((release) => release !== null)).toBe(true);
    expect(activeExportCount()).toBe(EXPORT_MAX_CONCURRENT);
    expect(acquireExportSlot()).toBeNull();

    releases[0]?.();
    expect(activeExportCount()).toBe(EXPORT_MAX_CONCURRENT - 1);
    expect(acquireExportSlot()).not.toBeNull();
  });

  test("a release is idempotent: a second call does not free another export's slot", () => {
    const first = acquireExportSlot();
    const second = acquireExportSlot();
    first?.();
    first?.();
    expect(activeExportCount()).toBe(1);
    second?.();
    expect(activeExportCount()).toBe(0);
  });

  test("resetExportSlots forgets slots never released", () => {
    acquireExportSlot();
    acquireExportSlot();
    resetExportSlots();
    expect(activeExportCount()).toBe(0);
    expect(acquireExportSlot()).not.toBeNull();
  });
});

describe("takeExportBudget", () => {
  test("EXPORT_MAX_PER_WINDOW exports per user, then refused until the window ends", async () => {
    for (let i = 0; i < EXPORT_MAX_PER_WINDOW; i += 1) {
      expect(await takeExportBudget("usr_budget")).toEqual({ limited: false });
    }
    const refused = await takeExportBudget("usr_budget");
    expect(refused.limited).toBe(true);
    if (!refused.limited) return;
    /** Whole seconds, at least 1, never past the window. */
    expect(Number.isInteger(refused.retryAfterSec)).toBe(true);
    expect(refused.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(refused.retryAfterSec).toBeLessThanOrEqual(EXPORT_WINDOW_MS / 1000);
  });

  test("each user has a budget of their own", async () => {
    for (let i = 0; i < EXPORT_MAX_PER_WINDOW; i += 1) await takeExportBudget("usr_a");
    expect((await takeExportBudget("usr_a")).limited).toBe(true);
    expect(await takeExportBudget("usr_b")).toEqual({ limited: false });
  });
});
