import { describe, test, expect } from "bun:test";
import {
  RecordingGuards,
  type GuardLimits,
} from "../../src/modules/tracking/services/tracking-guards.ts";
import type { TrackingHit } from "../../src/modules/tracking/types/tracking.types.ts";

/**
 * The in-process gate before the recording transaction (#187): dedupe and
 * per-email caps come first, only what passes is charged to the budget,
 * and at most `maxInFlight` recordings run at once.
 */

let clock = 1_000_000;

function guards(overrides: Partial<GuardLimits> = {}): RecordingGuards {
  return new RecordingGuards({
    dedupeWindowMs: 60_000,
    caps: { open: 3, click: 5 },
    budgetPerSecond: 100,
    maxInFlight: 100,
    maxEntries: 1000,
    now: () => clock,
    ...overrides,
  });
}

function open(emailId: string): TrackingHit {
  return { kind: "open", emailId, position: null, url: null, userAgent: null };
}

function click(emailId: string, position: number): TrackingHit {
  return {
    kind: "click",
    emailId,
    position,
    url: "https://example.com/",
    userAgent: null,
  };
}

describe("RecordingGuards", () => {
  test("the same email, type and link within the window is deduped", () => {
    const g = guards();
    expect(g.admit(open("msg_a"))).toBe("go");
    expect(g.admit(open("msg_a"))).toBe("deduped");
    expect(g.admit(click("msg_a", 0))).toBe("go");
    expect(g.admit(click("msg_a", 1))).toBe("go");
    expect(g.admit(click("msg_a", 1))).toBe("deduped");
    clock += 60_000;
    expect(g.admit(open("msg_a"))).toBe("go");
  });

  test("per-email caps, per kind", () => {
    const g = guards();
    for (let i = 0; i < 3; i += 1) {
      clock += 61_000;
      expect(g.admit(open("msg_b"))).toBe("go");
    }
    clock += 61_000;
    expect(g.admit(open("msg_b"))).toBe("capped");
    expect(g.admit(click("msg_b", 0))).toBe("go");
  });

  test("a replayed token is never charged to the budget, so other emails still get through", () => {
    const g = guards({ budgetPerSecond: 2 });
    expect(g.admit(open("msg_c"))).toBe("go");
    for (let i = 0; i < 1000; i += 1) expect(g.admit(open("msg_c"))).toBe("deduped");
    expect(g.admit(open("msg_d"))).toBe("go");
    expect(g.admit(open("msg_e"))).toBe("capped");
    clock += 1000;
    expect(g.admit(open("msg_e"))).toBe("go");
  });

  test("at most maxInFlight at once; release frees a slot", () => {
    const g = guards({ maxInFlight: 2 });
    expect(g.admit(open("msg_f"))).toBe("go");
    expect(g.admit(open("msg_g"))).toBe("go");
    expect(g.admit(open("msg_h"))).toBe("capped");
    g.release();
    expect(g.admit(open("msg_h"))).toBe("go");
  });

  test("a hit refused for concurrency is not remembered, so it can go later", () => {
    const g = guards({ maxInFlight: 1 });
    expect(g.admit(open("msg_i"))).toBe("go");
    expect(g.admit(open("msg_j"))).toBe("capped");
    g.release();
    expect(g.admit(open("msg_j"))).toBe("go");
  });

  test("the maps stay bounded: the oldest entry is forgotten first", () => {
    const g = guards({ maxEntries: 2 });
    expect(g.admit(open("msg_1"))).toBe("go");
    expect(g.admit(open("msg_2"))).toBe("go");
    expect(g.admit(open("msg_3"))).toBe("go");
    /** msg_1 was dropped: only the database dedupe would catch it now. */
    expect(g.admit(open("msg_1"))).toBe("go");
    expect(g.admit(open("msg_3"))).toBe("deduped");
  });
});
