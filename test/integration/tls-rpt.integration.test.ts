/**
 * SMTP TLS reporting (RFC 8460, #345) against the real database:
 *
 * - recording: one report per domain and UTC day, counters that add up
 *   under concurrency, the policy cap and the detail cap (totals exact);
 * - the claim: only reports whose day is over and whose due time passed,
 *   with a lease, and the retention delete;
 * - the job with the real store and stubbed senders: deleted once
 *   delivered, rescheduled with the delivered address remembered;
 * - the mailer end to end: sessions to real receiving servers
 *   (`test/smtp-fixture.ts`) recorded on the domain's report.
 *
 * No real DNS, no real mail or HTTP: the TLS-RPT record lookup, the MX
 * route and MTA-STS are stubbed, the receivers run on 127.0.0.1.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.ts";
import { config } from "../../src/config.ts";
import { generateId } from "../../src/utils/id.ts";
import { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import { setMxRouteDeps } from "../../src/modules/emails/services/mx-route.ts";
import { setMtaStsDeps } from "../../src/modules/emails/services/mta-sts.ts";
import {
  tlsRptDailySends,
  tlsRptDestinationSends,
} from "../../src/modules/tls-rpt/models/tls-rpt-daily-send.schema.ts";
import { tlsRptReports } from "../../src/modules/tls-rpt/models/tls-rpt-report.schema.ts";
import { tlsRptResults } from "../../src/modules/tls-rpt/models/tls-rpt-result.schema.ts";
import {
  MAX_DETAIL_ROWS_PER_REPORT,
  MAX_POLICIES_PER_REPORT,
  REPORT_DELAY_JITTER_MS,
  REPORT_DELAY_MIN_MS,
  utcDay,
} from "../../src/modules/tls-rpt/services/tls-rpt-aggregate.ts";
import { tlsRptPolicyOf } from "../../src/modules/tls-rpt/services/tls-rpt-classify.ts";
import {
  RETRY_BACKOFF_MINUTES,
  ruaHash,
} from "../../src/modules/tls-rpt/services/tls-rpt-deliver.service.ts";
import { runTlsRptCycle } from "../../src/modules/tls-rpt/services/tls-rpt-job.service.ts";
import type { TlsRptJobDeps } from "../../src/modules/tls-rpt/types/tls-rpt-job.types.ts";
import { isSuppressedForAnyKey } from "../../src/modules/suppressions/services/suppression-check.service.ts";
import {
  setTlsRptObserveDeps,
  settleTlsRptRecordings,
} from "../../src/modules/tls-rpt/services/tls-rpt-observe.service.ts";
import {
  parseRua,
  setTlsRptRecordDeps,
} from "../../src/modules/tls-rpt/services/tls-rpt-record.ts";
import {
  claimDailyCapWarning,
  claimDueReports,
  dailySendCapReached,
  deferReport,
  deferUnsentReports,
  deleteExpiredReports,
  deleteReport,
  loadReportResults,
  recordObservation,
  releaseReport,
  releaseSend,
  rescheduleReport,
  reserveSend,
} from "../../src/modules/tls-rpt/services/tls-rpt-store.service.ts";
import { suppressions } from "../../src/modules/suppressions/models/suppression.schema.ts";
import type {
  TlsRptPolicy,
  TlsRptRua,
} from "../../src/modules/tls-rpt/types/tls-rpt.types.ts";
import { installHermeticMtaSts } from "./_dns-stub.ts";
import { seed, truncateAll } from "./_helpers.ts";
import { startFixtureServer, type FixtureServer } from "../smtp-fixture.ts";

const DAY_MS = 24 * 60 * 60_000;
const NO_POLICY = tlsRptPolicyOf({ policy: null, failure: null });

/** A reporting address as the record parser makes it. */
function rua(uri: string): TlsRptRua {
  const parsed = parseRua(uri);
  if (parsed === null) throw new Error(`not a usable rua: ${uri}`);
  return parsed;
}

/** An MTA-STS policy unique to `n`. */
function stsPolicy(n: number): TlsRptPolicy {
  return tlsRptPolicyOf({
    policy: {
      id: String(n),
      policy: { mode: "testing", mx: [`mx${n}.example.net`], maxAge: 60 },
    },
    failure: null,
  });
}

const savedTlsRpt = { ...config.tlsRpt };
const savedAllowPrivate = config.mail.allowPrivateMx;
const running: FixtureServer[] = [];

beforeAll(() => {
  Object.assign(config.tlsRpt, {
    enabled: true,
    organizationName: "Example Org",
    contactEmail: "tls@example.com",
    submitter: "example.com",
  });
  Object.assign(config.mail, { allowPrivateMx: true });
});

afterAll(() => {
  Object.assign(config.tlsRpt, savedTlsRpt);
  Object.assign(config.mail, { allowPrivateMx: savedAllowPrivate });
  for (const server of running) server.stop();
});

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  setTlsRptObserveDeps(null);
  setTlsRptRecordDeps(null);
  setMxRouteDeps(null);
  installHermeticMtaSts();
});

/** Inserts a report row directly, for the claim and retention tests. */
async function insertReport(
  day: string,
  nextAttemptAt: Date,
  domain = "example.net",
): Promise<string> {
  const id = generateId("trp");
  await db.insert(tlsRptReports).values({
    id,
    day,
    policyDomain: domain,
    rfcReportId: crypto.randomUUID(),
    nextAttemptAt,
  });
  return id;
}

describe("recording", () => {
  test("one report per domain and UTC day, due after the day ends, counters per result", async () => {
    const at = new Date();
    await recordObservation({
      domain: "example.net",
      policy: NO_POLICY,
      observation: { result: "success" },
      at,
    });
    await recordObservation({
      domain: "example.net",
      policy: NO_POLICY,
      observation: { result: "success" },
      at,
    });
    await recordObservation({
      domain: "example.net",
      policy: NO_POLICY,
      observation: {
        result: "starttls-not-supported",
        receivingMxHostname: "mx.example.net",
        receivingIp: "203.0.113.5",
        failureReasonCode: "",
      },
      at,
    });

    const reports = await db.select().from(tlsRptReports);
    expect(reports).toHaveLength(1);
    const report = reports[0];
    expect(report?.day).toBe(utcDay(at));
    expect(report?.attempts).toBe(0);
    const dayEnd = Date.parse(`${utcDay(at)}T00:00:00Z`) + DAY_MS;
    expect(report?.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      dayEnd + REPORT_DELAY_MIN_MS,
    );
    expect(report?.nextAttemptAt.getTime()).toBeLessThan(
      dayEnd + REPORT_DELAY_MIN_MS + REPORT_DELAY_JITTER_MS,
    );

    const results = await loadReportResults(report?.id ?? "");
    expect(results.find((r) => r.resultType === "success")?.sessionCount).toBe(2);
    expect(results.find((r) => r.resultType === "starttls-not-supported")).toMatchObject({
      receivingMxHostname: "mx.example.net",
      receivingIp: "203.0.113.5",
      sessionCount: 1,
    });
  });

  test("concurrent sessions all count (the report row serializes them)", async () => {
    const at = new Date();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        recordObservation({
          domain: "example.net",
          policy: NO_POLICY,
          observation: { result: "success" },
          at,
        }),
      ),
    );
    const [row] = await db.select().from(tlsRptResults);
    expect(row?.sessionCount).toBe(20);
    expect(await db.select().from(tlsRptReports)).toHaveLength(1);
  });

  test("a policy past the cap is dropped", async () => {
    const at = new Date();
    const outcomes: string[] = [];
    for (let n = 0; n <= MAX_POLICIES_PER_REPORT; n++) {
      outcomes.push(
        await recordObservation({
          domain: "example.net",
          policy: stsPolicy(n),
          observation: { result: "success" },
          at,
        }),
      );
    }
    expect(outcomes.filter((o) => o === "recorded")).toHaveLength(
      MAX_POLICIES_PER_REPORT,
    );
    expect(outcomes.at(-1)).toBe("dropped");
  });

  test("past the detail cap, failures keep counting without details (exact totals)", async () => {
    const at = new Date();
    const extra = 5;
    for (let i = 0; i < MAX_DETAIL_ROWS_PER_REPORT + extra; i++) {
      await recordObservation({
        domain: "example.net",
        policy: NO_POLICY,
        observation: {
          result: "starttls-not-supported",
          receivingMxHostname: `mx${i}.example.net`,
          receivingIp: "203.0.113.5",
          failureReasonCode: "",
        },
        at,
      });
    }
    const rows = await db.select().from(tlsRptResults);
    expect(rows).toHaveLength(MAX_DETAIL_ROWS_PER_REPORT + 1);
    const undetailed = rows.find((r) => r.receivingMxHostname === "");
    expect(undetailed?.sessionCount).toBe(extra);
    expect(rows.reduce((sum, r) => sum + r.sessionCount, 0)).toBe(
      MAX_DETAIL_ROWS_PER_REPORT + extra,
    );
  });

  test("deleting a report deletes its counters", async () => {
    await recordObservation({
      domain: "example.net",
      policy: NO_POLICY,
      observation: { result: "success" },
      at: new Date(),
    });
    const [report] = await db.select().from(tlsRptReports);
    await deleteReport(report?.id ?? "");
    expect(await db.select().from(tlsRptResults)).toHaveLength(0);
  });
});

describe("claim and retention", () => {
  test("only reports whose day is over and whose due time passed; leased once", async () => {
    const now = Date.now();
    const today = utcDay(new Date(now));
    const yesterday = utcDay(new Date(now - DAY_MS));
    const due = await insertReport(yesterday, new Date(now - 60_000), "due.example");
    await insertReport(today, new Date(now - 60_000), "today.example");
    await insertReport(yesterday, new Date(now + 60 * 60_000), "later.example");

    const claimed = await claimDueReports(10);
    expect(claimed.map((r) => r.id)).toEqual([due]);
    expect(claimed[0]?.attempts).toBe(1);
    expect(claimed[0]?.nextAttemptAt.getTime()).toBeGreaterThan(now + 60 * 60_000);
    /** Leased: a second claim (another replica) gets nothing. */
    expect(await claimDueReports(10)).toEqual([]);
  });

  test("reports past the retention period are deleted, sent or not", async () => {
    const now = Date.now();
    const old = await insertReport(
      utcDay(new Date(now - 8 * DAY_MS)),
      new Date(now),
      "old.example",
    );
    const kept = await insertReport(
      utcDay(new Date(now - 6 * DAY_MS)),
      new Date(now),
      "kept.example",
    );
    expect(await deleteExpiredReports(7)).toBe(1);
    const left = (await db.select({ id: tlsRptReports.id }).from(tlsRptReports)).map(
      (r) => r.id,
    );
    expect(left).toEqual([kept]);
    expect(left).not.toContain(old);
  });

  test("rescheduling stores the next attempt and the delivered set", async () => {
    const id = await insertReport(utcDay(new Date()), new Date());
    const next = new Date(Date.now() + 30 * 60_000);
    await rescheduleReport(id, next, ["aaaa", "bbbb"]);
    const [row] = await db.select().from(tlsRptReports).where(eq(tlsRptReports.id, id));
    expect(row?.deliveredRua).toBe("aaaa\nbbbb");
    expect(row?.nextAttemptAt.getTime()).toBe(next.getTime());
  });
});

describe("the job with the real store", () => {
  const MAILTO = "mailto:tls-reports@example.net";
  const HTTPS = "https://reports.example.net/v1/tlsrpt";

  /** Real claim, read, reschedule, delete and caps; stubbed record lookup and senders. */
  function deps(
    post: "sent" | "failed",
    cap = 1_000,
    perDestination = 1_000,
  ): {
    deps: TlsRptJobDeps;
    mailed: number;
    posted: number;
  } {
    const seen = { mailed: 0, posted: 0 };
    return {
      get mailed() {
        return seen.mailed;
      },
      get posted() {
        return seen.posted;
      },
      deps: {
        now: () => new Date(),
        claimOne: async () => (await claimDueReports(1))[0] ?? null,
        loadResults: loadReportResults,
        lookup: async () => ({ kind: "record", rua: [rua(MAILTO), rua(HTTPS)] }),
        mail: async () => {
          seen.mailed++;
          return { kind: "sent" };
        },
        post: async () => {
          seen.posted++;
          return post === "sent"
            ? { kind: "sent" }
            : { kind: "failed", reason: "HTTP 500" };
        },
        reschedule: rescheduleReport,
        remove: deleteReport,
        deleteExpired: (days) => deleteExpiredReports(days),
        reserve: (destination) =>
          reserveSend(destination, { perDay: cap, perDestination }),
        release: releaseSend,
        capReached: () => dailySendCapReached(cap),
        deferAll: () => deferUnsentReports(),
        defer: deferReport,
        releaseClaim: releaseReport,
        claimCapWarning: () => claimDailyCapWarning(),
        isSuppressed: isSuppressedForAnyKey,
      },
    };
  }

  /** A report of yesterday, due now, with one success counter. */
  async function dueReport(): Promise<string> {
    const yesterday = new Date(Date.now() - DAY_MS);
    await recordObservation({
      domain: "example.net",
      policy: NO_POLICY,
      observation: { result: "success" },
      at: yesterday,
    });
    await db.execute(
      sql`UPDATE tlsrpt_reports SET next_attempt_at = NOW() - interval '1 minute'`,
    );
    const [row] = await db.select({ id: tlsRptReports.id }).from(tlsRptReports);
    return row?.id ?? "";
  }

  test("delivered to every address: the report and its counters are deleted", async () => {
    await dueReport();
    const run = deps("sent");
    const summary = await runTlsRptCycle(run.deps);
    expect(summary).toMatchObject({ reports: 1, sent: 2, finished: 1 });
    expect(run.mailed).toBe(1);
    expect(run.posted).toBe(1);
    expect(await db.select().from(tlsRptReports)).toHaveLength(0);
    expect(await db.select().from(tlsRptResults)).toHaveLength(0);
  });

  test("an address that failed: rescheduled on the backoff, the delivered one remembered", async () => {
    const id = await dueReport();
    const before = Date.now();
    await runTlsRptCycle(deps("failed").deps);
    const [row] = await db.select().from(tlsRptReports).where(eq(tlsRptReports.id, id));
    expect(row?.attempts).toBe(1);
    expect(row?.deliveredRua).toBe(ruaHash(rua(MAILTO).key));
    expect(row?.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      before + (RETRY_BACKOFF_MINUTES[0] ?? 0) * 60_000 - 1_000,
    );
    /** Not due again yet: the next run sends nothing. */
    const again = deps("sent");
    await runTlsRptCycle(again.deps);
    expect(again.posted).toBe(0);
  });

  test("today's report is never sent", async () => {
    await recordObservation({
      domain: "example.net",
      policy: NO_POLICY,
      observation: { result: "success" },
      at: new Date(),
    });
    await db.execute(
      sql`UPDATE tlsrpt_reports SET next_attempt_at = NOW() - interval '1 minute'`,
    );
    const run = deps("sent");
    const summary = await runTlsRptCycle(run.deps);
    expect(summary.reports).toBe(0);
    expect(await db.select().from(tlsRptReports)).toHaveLength(1);
  });
  test("the job stops at the cap and defers the rest to tomorrow, for every replica", async () => {
    const yesterday = new Date(Date.now() - DAY_MS);
    for (const domain of ["a.example", "b.example", "c.example"]) {
      await recordObservation({
        domain,
        policy: NO_POLICY,
        observation: { result: "success" },
        at: yesterday,
      });
    }
    await db.execute(
      sql`UPDATE tlsrpt_reports SET next_attempt_at = NOW() - interval '1 minute'`,
    );
    /** Two addresses per report, cap three: the second report is cut short. */
    const first = deps("sent", 3);
    const summary = await runTlsRptCycle(first.deps);
    expect(first.mailed + first.posted).toBe(3);
    expect(summary.capped).toBeGreaterThanOrEqual(2);
    const [row] = await db.select().from(tlsRptDailySends);
    expect(row?.sent).toBe(3);
    expect(row?.capWarned).toBe(true);
    /** The reports left are due tomorrow, not deleted. */
    const [left] = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM tlsrpt_reports WHERE next_attempt_at >= ((NOW() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC'`,
    );
    expect(left?.n).toBeGreaterThanOrEqual(2);

    /** A second replica with the same cap sends nothing more today. */
    const second = deps("sent", 3);
    const again = await runTlsRptCycle(second.deps);
    expect(second.mailed + second.posted).toBe(0);
    expect(again.reports).toBe(0);
  });

  test("a destination at its cap is held back; the report waits for tomorrow", async () => {
    const yesterday = new Date(Date.now() - DAY_MS);
    for (const domain of ["a.example", "b.example"]) {
      await recordObservation({
        domain,
        policy: NO_POLICY,
        observation: { result: "success" },
        at: yesterday,
      });
    }
    await db.execute(
      sql`UPDATE tlsrpt_reports SET next_attempt_at = NOW() - interval '1 minute'`,
    );
    /** Both reports go to the same two addresses; one report per destination a day. */
    const run = deps("sent", 1_000, 1);
    const summary = await runTlsRptCycle(run.deps);
    /** Reports run concurrently, so which report gets which slot varies; the totals do not. */
    expect(run.mailed).toBe(1);
    expect(run.posted).toBe(1);
    expect(summary.destinationCapped).toBe(2);
    const rows = await db.select().from(tlsRptReports);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    /** Held back by a cap: deferred with its attempt given back, never dropped. */
    expect(rows.every((r) => r.attempts === 0)).toBe(true);
  });

  test("a suppressed reporting address gets no mail", async () => {
    const key = await seed.apiKey();
    await db.insert(suppressions).values({
      id: generateId("sup"),
      apiKeyId: key.id,
      email: "tls-reports@example.net",
      reason: "manual",
    });
    await dueReport();
    const run = deps("sent");
    const summary = await runTlsRptCycle(run.deps);
    expect(run.mailed).toBe(0);
    expect(run.posted).toBe(1);
    expect(summary.suppressed).toBe(1);
    expect(await db.select().from(tlsRptReports)).toHaveLength(0);
  });
});

describe("the daily and per-destination caps, shared by every replica", () => {
  test("concurrent reservations (several replicas) never exceed the daily cap", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        reserveSend(`d${i}@example.org`, { perDay: 10, perDestination: 5 }),
      ),
    );
    expect(outcomes.filter((o) => o === "reserved")).toHaveLength(10);
    expect(outcomes.filter((o) => o === "daily-cap")).toHaveLength(15);
    const [row] = await db.select().from(tlsRptDailySends);
    expect(row?.sent).toBe(10);
    expect(await dailySendCapReached(10)).toBe(true);
    /** A refused daily slot gives its destination slot back. */
    const [refused] = await db.execute<{ n: number }>(
      sql`SELECT coalesce(sum(sent), 0)::int AS n FROM tlsrpt_destination_sends`,
    );
    expect(refused?.n).toBe(10);
  });

  test("one destination gets at most its cap, whoever asks; a release frees a slot", async () => {
    const caps = { perDay: 1_000, perDestination: 3 };
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => reserveSend("https://victim.example", caps)),
    );
    expect(outcomes.filter((o) => o === "reserved")).toHaveLength(3);
    expect(outcomes.filter((o) => o === "destination-cap")).toHaveLength(5);
    await releaseSend("https://victim.example");
    expect(await reserveSend("https://victim.example", caps)).toBe("reserved");
    /** Stored as a hash, never the destination itself. */
    const rows = await db.select().from(tlsRptDestinationSends);
    expect(JSON.stringify(rows)).not.toContain("victim");
  });

  test("the cap warning is claimed once per day, whoever asks", async () => {
    await reserveSend("a@example.org", { perDay: 1, perDestination: 1 });
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => claimDailyCapWarning()),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  test("deferred: past days' unsent reports are due tomorrow, still claimable then; today's untouched", async () => {
    const now = Date.now();
    await insertReport(
      utcDay(new Date(now - DAY_MS)),
      new Date(now - 60_000),
      "a.example",
    );
    await insertReport(
      utcDay(new Date(now - 2 * DAY_MS)),
      new Date(now + 60_000),
      "b.example",
    );
    const today = await insertReport(
      utcDay(new Date(now)),
      new Date(now + DAY_MS),
      "today.example",
    );
    expect(await deferUnsentReports()).toBe(2);
    expect(await deferUnsentReports()).toBe(0);
    expect(await claimDueReports(10)).toEqual([]);
    const [deferred] = await db.execute<{ n: number }>(
      /**
       * Today's report is left out: its own `next_attempt_at` (now + 24 h)
       * can fall inside tomorrow's 01:00 to 05:00 window by chance.
       */
      sql`SELECT count(*)::int AS n FROM tlsrpt_reports
          WHERE policy_domain <> 'today.example'
            AND next_attempt_at >= ((NOW() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC' + interval '1 hour'
            AND next_attempt_at <= ((NOW() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC' + interval '5 hours'`,
    );
    expect(deferred?.n).toBe(2);
    const [kept] = await db
      .select()
      .from(tlsRptReports)
      .where(eq(tlsRptReports.id, today));
    expect(kept?.nextAttemptAt.getTime()).toBe(now + DAY_MS);
  });

  test("a deferred or released claim keeps its delivered set and gives its attempt back", async () => {
    const now = Date.now();
    const a = await insertReport(
      utcDay(new Date(now - DAY_MS)),
      new Date(now - 60_000),
      "a.example",
    );
    const b = await insertReport(
      utcDay(new Date(now - DAY_MS)),
      new Date(now - 60_000),
      "b.example",
    );
    const claimed = await claimDueReports(10);
    expect(claimed.map((r) => r.attempts)).toEqual([1, 1]);
    await deferReport(a, ["h1"]);
    await releaseReport(b, ["h2"]);
    const rows = await db.select().from(tlsRptReports);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(a)).toMatchObject({ attempts: 0, deliveredRua: "h1" });
    expect(byId.get(b)).toMatchObject({ attempts: 0, deliveredRua: "h2" });
    /** The released one is due at once (another replica may take it); the deferred one is not. */
    expect((await claimDueReports(10)).map((r) => r.id)).toEqual([b]);
  });
});

describe("suppression check for BunMail's own mail", () => {
  test("an active suppression under any key counts; an expired one does not", async () => {
    const key = await seed.apiKey();
    await db.insert(suppressions).values([
      {
        id: generateId("sup"),
        apiKeyId: key.id,
        email: "gone@example.org",
        reason: "bounce",
      },
      {
        id: generateId("sup"),
        apiKeyId: key.id,
        email: "soft@example.org",
        reason: "bounce",
        expiresAt: new Date(Date.now() - 60_000),
      },
    ]);
    expect(await isSuppressedForAnyKey("Gone@Example.org")).toBe(true);
    expect(await isSuppressedForAnyKey("soft@example.org")).toBe(false);
    expect(await isSuppressedForAnyKey("other@example.org")).toBe(false);
  });
});

describe("the mailer records its sessions", () => {
  /** Routes `example.org` to one fixture server at 127.0.0.1. */
  function route(port: number): void {
    const dnsError = (code: string): Error => Object.assign(new Error(code), { code });
    setMxRouteDeps({
      resolveMx: async (domain) => {
        if (domain !== "example.org") throw dnsError("ENOTFOUND");
        return [{ exchange: "mx1.example.test", priority: 10 }];
      },
      resolve4: () => Promise.reject(dnsError("ENOTFOUND")),
      resolve6: () => Promise.reject(dnsError("ENOTFOUND")),
      lookup: async () => [{ address: "127.0.0.1" }],
      smtpPort: () => port,
    });
    setMtaStsDeps({
      resolveTxt: () => Promise.reject(dnsError("ENOTFOUND")),
      lookup: () => Promise.reject(dnsError("ENOTFOUND")),
      fetch: () => Promise.reject(new Error("no policy host")),
    });
  }

  test("a plaintext session to a domain publishing TLS-RPT: starttls-not-supported on its report", async () => {
    const server = await startFixtureServer("plaintext");
    running.push(server);
    route(server.port);
    setTlsRptRecordDeps({
      resolveTxt: async (name) => {
        if (name !== "_smtp._tls.example.org") {
          throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
        }
        return [["v=TLSRPTv1; rua=mailto:tls@example.org"]];
      },
    });

    const result = await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "tls-rpt",
      text: "hello",
      messageId: `<${crypto.randomUUID()}@bunmail.example.test>`,
    });
    expect(result.deliveryState["example.org"]?.status).toBe("sent");
    await settleTlsRptRecordings();

    const [report] = await db.select().from(tlsRptReports);
    expect(report?.policyDomain).toBe("example.org");
    const results = await loadReportResults(report?.id ?? "");
    expect(results).toEqual([
      expect.objectContaining({
        policyType: "no-policy-found",
        resultType: "starttls-not-supported",
        receivingMxHostname: "mx1.example.test",
        receivingIp: "127.0.0.1",
        sessionCount: 1,
      }),
    ]);
  });

  test("a domain without a TLS-RPT record: nothing is stored", async () => {
    const server = await startFixtureServer("starttls");
    running.push(server);
    route(server.port);
    setTlsRptRecordDeps({
      resolveTxt: async () => {
        throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      },
    });
    await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "tls-rpt",
      text: "hello",
      messageId: `<${crypto.randomUUID()}@bunmail.example.test>`,
    });
    await settleTlsRptRecordings();
    expect(await db.select().from(tlsRptReports)).toHaveLength(0);
  });
});
