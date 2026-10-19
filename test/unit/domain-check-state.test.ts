import { describe, test, expect } from "bun:test";
import {
  FLIP_AFTER_FAILURES,
  RECHECK_AFTER_PROBLEM_MS,
  RECHECK_JITTER_MS,
  nextCheckAfterPass,
  nextDomainCheckState,
  overallOutcome,
  type DomainCheckState,
} from "../../src/modules/domains/services/domain-check-state.ts";
import type {
  DnsCheckStatus,
  DomainCheckResult,
} from "../../src/modules/domains/types/domain-check.types.ts";

/**
 * The verification state machine (#250): a DNS error never counts, one
 * definitive failure only counts, the second in a row flips a verified
 * domain to failing, a pass resets the count and (re)sets `verifiedAt`.
 */

const NOW = new Date("2026-10-19T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** `Math.random` returning the middle of its range: no jitter. */
const noJitter = (): number => 0.5;

function result(
  spf: DnsCheckStatus,
  dkim: DnsCheckStatus,
  dmarc: DnsCheckStatus,
): DomainCheckResult {
  return {
    spf: { status: spf, reason: `spf ${spf}` },
    dkim: { status: dkim, reason: `dkim ${dkim}` },
    dmarc: { status: dmarc, reason: `dmarc ${dmarc}` },
    checkedAt: NOW.toISOString(),
  };
}

const PASS = result("pass", "pass", "pass");
const DKIM_FAIL = result("pass", "fail", "pass");
const DKIM_UNKNOWN = result("pass", "unknown", "pass");

const VERIFIED_AT = new Date("2026-10-01T00:00:00Z");

const verified: DomainCheckState = {
  spfVerified: true,
  dkimVerified: true,
  dmarcVerified: true,
  verifiedAt: VERIFIED_AT,
  consecutiveFailures: 0,
};

const unverified: DomainCheckState = {
  spfVerified: false,
  dkimVerified: false,
  dmarcVerified: false,
  verifiedAt: null,
  consecutiveFailures: 0,
};

/** Applies `results` one after the other, from `start`. */
function run(start: DomainCheckState, ...results: DomainCheckResult[]) {
  let state = start;
  const transitions = results.map((r) => {
    const t = nextDomainCheckState(state, r, NOW, DAY_MS, noJitter);
    state = t.next;
    return t;
  });
  return { state, transitions };
}

describe("overallOutcome", () => {
  test("one failure decides, then one unknown, else pass", () => {
    expect(overallOutcome(PASS)).toBe("pass");
    expect(overallOutcome(DKIM_UNKNOWN)).toBe("unknown");
    expect(overallOutcome(result("unknown", "fail", "pass"))).toBe("fail");
  });
});

describe("nextDomainCheckState", () => {
  test("a pass keeps verifiedAt, keeps the flags and schedules one interval later", () => {
    const t = nextDomainCheckState(verified, PASS, NOW, DAY_MS, noJitter);
    expect(t.outcome).toBe("pass");
    expect(t.next).toEqual(verified);
    expect(t.event).toBeNull();
    expect(t.nextCheckAt.getTime()).toBe(NOW.getTime() + DAY_MS);
  });

  test("unknown changes nothing and rechecks in an hour", () => {
    const failedOnce = { ...verified, consecutiveFailures: 1 };
    const t = nextDomainCheckState(failedOnce, DKIM_UNKNOWN, NOW, DAY_MS, noJitter);
    expect(t.outcome).toBe("unknown");
    expect(t.next).toEqual(failedOnce);
    expect(t.event).toBeNull();
    expect(t.nextCheckAt.getTime()).toBe(NOW.getTime() + RECHECK_AFTER_PROBLEM_MS);
  });

  test("unknown never flips, however often it repeats", () => {
    const { state, transitions } = run(
      verified,
      DKIM_UNKNOWN,
      DKIM_UNKNOWN,
      DKIM_UNKNOWN,
      result("unknown", "unknown", "unknown"),
    );
    expect(state).toEqual(verified);
    expect(transitions.every((t) => t.event === null)).toBe(true);
  });

  test("a first failure counts but keeps verifiedAt and the flags", () => {
    const t = nextDomainCheckState(verified, DKIM_FAIL, NOW, DAY_MS, noJitter);
    expect(t.outcome).toBe("fail");
    expect(t.next.consecutiveFailures).toBe(1);
    expect(t.next.verifiedAt).toEqual(VERIFIED_AT);
    expect(t.next.dkimVerified).toBe(true);
    expect(t.event).toBeNull();
    expect(t.failedChecks).toEqual(["dkim"]);
    expect(t.nextCheckAt.getTime()).toBe(NOW.getTime() + HOUR_MS);
  });

  test(`the ${FLIP_AFTER_FAILURES}nd failure in a row flips a verified domain`, () => {
    const { state, transitions } = run(verified, DKIM_FAIL, DKIM_FAIL);
    expect(state.verifiedAt).toBeNull();
    expect(state.dkimVerified).toBe(false);
    /** The other flags follow the result: they passed. */
    expect(state.spfVerified).toBe(true);
    expect(state.dmarcVerified).toBe(true);
    expect(state.consecutiveFailures).toBe(2);
    expect(transitions[1]?.event).toBe("failed");
    expect(transitions[1]?.failedChecks).toEqual(["dkim"]);
  });

  test("an unknown between two failures neither resets nor counts", () => {
    const { state, transitions } = run(verified, DKIM_FAIL, DKIM_UNKNOWN, DKIM_FAIL);
    expect(state.consecutiveFailures).toBe(2);
    expect(state.verifiedAt).toBeNull();
    expect(transitions.map((t) => t.event)).toEqual([null, null, "failed"]);
  });

  test("a pass between two failures resets the count: no flip", () => {
    const { state } = run(verified, DKIM_FAIL, PASS, DKIM_FAIL);
    expect(state.consecutiveFailures).toBe(1);
    expect(state.verifiedAt).toEqual(VERIFIED_AT);
  });

  test("further failures after the flip fire no second event", () => {
    const { state, transitions } = run(verified, DKIM_FAIL, DKIM_FAIL, DKIM_FAIL);
    expect(state.consecutiveFailures).toBe(3);
    expect(transitions.map((t) => t.event)).toEqual([null, "failed", null]);
  });

  test("a flipped domain that passes again is verified again", () => {
    const { state, transitions } = run(verified, DKIM_FAIL, DKIM_FAIL, PASS);
    expect(state.verifiedAt).toEqual(NOW);
    expect(state.dkimVerified).toBe(true);
    expect(state.consecutiveFailures).toBe(0);
    expect(transitions[2]?.event).toBe("verified");
  });

  test("a new domain passing every check becomes verified", () => {
    const t = nextDomainCheckState(unverified, PASS, NOW, DAY_MS, noJitter);
    expect(t.next.verifiedAt).toEqual(NOW);
    expect(t.event).toBe("verified");
  });

  test("a new domain with a partial result is not verified, passing flags are set", () => {
    const t = nextDomainCheckState(unverified, DKIM_FAIL, NOW, DAY_MS, noJitter);
    expect(t.next.verifiedAt).toBeNull();
    expect(t.next.spfVerified).toBe(true);
    expect(t.next.dkimVerified).toBe(false);
    expect(t.event).toBeNull();
  });

  test("a domain that never verified fires no failure event", () => {
    const { transitions } = run(unverified, DKIM_FAIL, DKIM_FAIL, DKIM_FAIL);
    expect(transitions.every((t) => t.event === null)).toBe(true);
  });

  test("a DKIM flag set by a partial pass survives one failure", () => {
    const partial = { ...unverified, dkimVerified: true };
    const once = nextDomainCheckState(partial, DKIM_FAIL, NOW, DAY_MS, noJitter);
    expect(once.next.dkimVerified).toBe(true);
    const twice = nextDomainCheckState(once.next, DKIM_FAIL, NOW, DAY_MS, noJitter);
    expect(twice.next.dkimVerified).toBe(false);
  });
});

describe("nextCheckAfterPass", () => {
  test("stays within one interval plus or minus an hour", () => {
    const low = nextCheckAfterPass(NOW, DAY_MS, () => 0);
    const high = nextCheckAfterPass(NOW, DAY_MS, () => 0.999_999);
    expect(low.getTime()).toBe(NOW.getTime() + DAY_MS - RECHECK_JITTER_MS);
    expect(high.getTime()).toBeLessThanOrEqual(
      NOW.getTime() + DAY_MS + RECHECK_JITTER_MS,
    );
    expect(high.getTime()).toBeGreaterThan(
      NOW.getTime() + DAY_MS + RECHECK_JITTER_MS - 1000,
    );
  });

  test("random draws always land in the window", () => {
    for (let i = 0; i < 1000; i++) {
      const at = nextCheckAfterPass(NOW, DAY_MS).getTime() - NOW.getTime();
      expect(at).toBeGreaterThanOrEqual(DAY_MS - RECHECK_JITTER_MS);
      expect(at).toBeLessThanOrEqual(DAY_MS + RECHECK_JITTER_MS);
    }
  });
});
