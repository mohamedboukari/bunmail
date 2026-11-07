import { describe, expect, test } from "bun:test";
import {
  MAX_DETAIL_ROWS_PER_REPORT,
  MAX_POLICIES_PER_REPORT,
  MAX_POLICY_TEXT_LENGTH,
  REPORT_DELAY_JITTER_MS,
  REPORT_DELAY_MIN_MS,
  joinBounded,
  policyHash,
  reportDueAt,
  resultKeyFor,
  resultKeyOf,
  utcDay,
  type ResultKey,
} from "../../src/modules/tls-rpt/services/tls-rpt-aggregate.ts";
import { tlsRptPolicyOf } from "../../src/modules/tls-rpt/services/tls-rpt-classify.ts";
import type { TlsRptPolicy } from "../../src/modules/tls-rpt/types/tls-rpt.types.ts";

/**
 * How sessions become a report's counters (#345), and the caps that keep a
 * report bounded whatever the receiving side does: few policies, a capped
 * number of detailed failure rows, exact totals past the cap.
 */

const NO_POLICY = tlsRptPolicyOf({ policy: null, failure: null });

/** An MTA-STS policy whose MX list is unique to `n`. */
function stsPolicy(n: number): TlsRptPolicy {
  return tlsRptPolicyOf({
    policy: {
      id: String(n),
      policy: { mode: "testing", mx: [`mx${n}.example.com`], maxAge: 60 },
    },
    failure: null,
  });
}

function failureKey(policy: TlsRptPolicy, host: string): ResultKey {
  return resultKeyOf(policy, {
    result: "starttls-not-supported",
    receivingMxHostname: host,
    receivingIp: "203.0.113.1",
    failureReasonCode: "",
  });
}

describe("resultKeyOf", () => {
  test("a success has no details; a failure keeps host, IP and reason", () => {
    expect(resultKeyOf(NO_POLICY, { result: "success" })).toEqual({
      policyType: "no-policy-found",
      policyHash: policyHash(NO_POLICY),
      resultType: "success",
      receivingMxHostname: "",
      receivingIp: "",
      failureReasonCode: "",
    });
    expect(failureKey(NO_POLICY, "mx.example.com")).toMatchObject({
      resultType: "starttls-not-supported",
      receivingMxHostname: "mx.example.com",
      receivingIp: "203.0.113.1",
    });
  });

  test("the policy hash depends on the policy, and is stable", () => {
    expect(policyHash(stsPolicy(1))).toBe(policyHash(stsPolicy(1)));
    expect(policyHash(stsPolicy(1))).not.toBe(policyHash(stsPolicy(2)));
    expect(policyHash(stsPolicy(1))).toHaveLength(32);
  });
});

describe("resultKeyFor (caps)", () => {
  test("an existing counter is always used", () => {
    const key = failureKey(NO_POLICY, "mx.example.com");
    expect(resultKeyFor([key], { ...key })).toEqual(key);
  });

  test("at most MAX_POLICIES_PER_REPORT policies; a further policy's session is dropped", () => {
    const existing = Array.from({ length: MAX_POLICIES_PER_REPORT }, (_, i) =>
      resultKeyOf(stsPolicy(i), { result: "success" }),
    );
    expect(
      resultKeyFor(existing, resultKeyOf(stsPolicy(99), { result: "success" })),
    ).toBeNull();
    /** A known policy still counts, success or failure. */
    expect(
      resultKeyFor(existing, failureKey(stsPolicy(0), "mx0.example.com")),
    ).not.toBeNull();
  });

  test("past MAX_DETAIL_ROWS_PER_REPORT, a new failure goes to its undetailed counter", () => {
    const existing = Array.from({ length: MAX_DETAIL_ROWS_PER_REPORT }, (_, i) =>
      failureKey(NO_POLICY, `mx${i}.example.com`),
    );
    const next = resultKeyFor(existing, failureKey(NO_POLICY, "new.example.com"));
    expect(next).toEqual({
      ...failureKey(NO_POLICY, "new.example.com"),
      receivingMxHostname: "",
      receivingIp: "",
      failureReasonCode: "",
    });
    /** Successes are never capped by the detail cap. */
    expect(
      resultKeyFor(existing, resultKeyOf(NO_POLICY, { result: "success" }))?.resultType,
    ).toBe("success");
  });

  test("undetailed counters do not count towards the detail cap", () => {
    const undetailed = { ...failureKey(NO_POLICY, ""), receivingIp: "" };
    const existing = [
      undetailed,
      ...Array.from({ length: MAX_DETAIL_ROWS_PER_REPORT - 1 }, (_, i) =>
        failureKey(NO_POLICY, `mx${i}.example.com`),
      ),
    ];
    const candidate = failureKey(NO_POLICY, "last.example.com");
    expect(resultKeyFor(existing, candidate)).toEqual(candidate);
  });
});

describe("joinBounded", () => {
  test("joins lines, keeping whole lines under the cap", () => {
    expect(joinBounded(["a", "b"])).toBe("a\nb");
    expect(joinBounded([])).toBe("");
    const long = Array.from({ length: 1000 }, (_, i) => `mx: host${i}.example.com`);
    const text = joinBounded(long);
    expect(text.length).toBeLessThanOrEqual(MAX_POLICY_TEXT_LENGTH);
    expect(text.split("\n").every((line) => long.includes(line))).toBe(true);
  });
});

describe("day boundary", () => {
  test("utcDay is the UTC calendar day", () => {
    expect(utcDay(new Date("2026-11-06T23:59:59.999Z"))).toBe("2026-11-06");
    expect(utcDay(new Date("2026-11-07T00:00:00.000Z"))).toBe("2026-11-07");
    /** 23:30 in New York on the 6th is already the 7th in UTC. */
    expect(utcDay(new Date("2026-11-06T23:30:00-05:00"))).toBe("2026-11-07");
  });

  test("a report is due one to five hours after its day ends", () => {
    const end = Date.parse("2026-11-07T00:00:00Z");
    expect(reportDueAt("2026-11-06", 0).getTime()).toBe(end + REPORT_DELAY_MIN_MS);
    const latest = reportDueAt("2026-11-06", 0.999999).getTime();
    expect(latest).toBeGreaterThan(end + REPORT_DELAY_MIN_MS);
    expect(latest).toBeLessThan(end + REPORT_DELAY_MIN_MS + REPORT_DELAY_JITTER_MS);
  });
});
