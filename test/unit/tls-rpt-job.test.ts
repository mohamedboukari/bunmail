import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "crypto";
import { config } from "../../src/config.ts";
import { logger } from "../../src/utils/logger.ts";
import { redactEmail } from "../../src/utils/redact.ts";
import {
  MAX_SEND_ATTEMPTS,
  RETRY_BACKOFF_MINUTES,
  ruaHash,
} from "../../src/modules/tls-rpt/services/tls-rpt-deliver.service.ts";
import {
  REPORT_MAIL_LIMITS,
  RETENTION_DAYS,
  RUN_BUDGET_MS,
  SEND_CONCURRENCY,
  runTlsRptCycle,
} from "../../src/modules/tls-rpt/services/tls-rpt-job.service.ts";
import type { MailedReport } from "../../src/modules/tls-rpt/services/tls-rpt-mailto.service.ts";
import type { ReportSendOutcome } from "../../src/modules/tls-rpt/services/tls-rpt-https.service.ts";
import {
  parseRua,
  type TlsRptLookup,
} from "../../src/modules/tls-rpt/services/tls-rpt-record.ts";
import type {
  ReserveOutcome,
  TlsRptReportRow,
} from "../../src/modules/tls-rpt/services/tls-rpt-store.service.ts";
import type { TlsRptJobDeps } from "../../src/modules/tls-rpt/types/tls-rpt-job.types.ts";
import type {
  TlsRptResultRow,
  TlsRptRua,
} from "../../src/modules/tls-rpt/types/tls-rpt.types.ts";

/**
 * The daily TLS report job (#345): one report per domain and day to every
 * reporting address, retried with backoff, dropped after the last attempt,
 * deleted once delivered; claimed one at a time by a few workers, within a
 * time budget, under a daily cap and a per-destination cap kept for every
 * replica, never to a suppressed address; never a URL path or a full
 * address in a log line. Every step is replaced: no database, no DNS, no
 * network.
 */

const NOW = new Date("2026-11-07T03:00:00Z");
const MAILTO = "mailto:tls-reports@example.net";
const HTTPS = "https://reports.example.net/v1/tlsrpt?token=secret-token";

/** A reporting address as the record parser makes it. */
function rua(uri: string): TlsRptRua {
  const parsed = parseRua(uri);
  if (parsed === null) throw new Error(`not a usable rua: ${uri}`);
  return parsed;
}

const RECORD: TlsRptLookup = { kind: "record", rua: [rua(MAILTO), rua(HTTPS)] };
const MAILTO_KEY = rua(MAILTO).key;

const RESULTS: TlsRptResultRow[] = [
  {
    policyType: "no-policy-found",
    policyHash: "a".repeat(32),
    policyString: "",
    mxHost: "",
    resultType: "success",
    receivingMxHostname: "",
    receivingIp: "",
    failureReasonCode: "",
    sessionCount: 10,
  },
  {
    policyType: "no-policy-found",
    policyHash: "a".repeat(32),
    policyString: "",
    mxHost: "",
    resultType: "starttls-not-supported",
    receivingMxHostname: "mx.example.net",
    receivingIp: "203.0.113.7",
    failureReasonCode: "",
    sessionCount: 2,
  },
];

function row(overrides: Partial<TlsRptReportRow> = {}): TlsRptReportRow {
  return {
    id: "trp_1",
    day: "2026-11-06",
    policyDomain: "example.net",
    rfcReportId: "3c9f1a52-0d6b-4e6a-8f1e-2b7c9d0e1f2a",
    nextAttemptAt: NOW,
    attempts: 1,
    deliveredRua: "",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * The counters the database keeps for every replica: fakes sharing one
 * see the same counts and the same warning flag.
 */
interface Counters {
  cap: number;
  perDestination: number;
  sent: number;
  byDestination: Map<string, number>;
  warned: boolean;
  /** Reports still to send that a daily-cap deferral would move to tomorrow. */
  unsent: number;
}

function counters(cap = 1_000, perDestination = 1_000, unsent = 0): Counters {
  return {
    cap,
    perDestination,
    sent: 0,
    byDestination: new Map(),
    warned: false,
    unsent,
  };
}

interface Fake {
  deps: TlsRptJobDeps;
  clock: { ms: number };
  mailed: MailedReport[];
  posted: Array<{ url: string; body: Uint8Array }>;
  rescheduled: Array<{ id: string; next: Date; delivered: readonly string[] }>;
  deferred: Array<{ id: string; delivered: readonly string[] }>;
  released: Array<{ id: string; delivered: readonly string[] }>;
  removed: string[];
  expiredWith: number[];
  claims: { count: number };
  counters: Counters;
}

/** Fake steps recording every call; `rows` are claimed one at a time. */
function fake(
  rows: TlsRptReportRow[],
  options: {
    lookup?: TlsRptLookup;
    results?: TlsRptResultRow[];
    mail?: (report: MailedReport, clock: { ms: number }) => Promise<ReportSendOutcome>;
    post?: (url: string, clock: { ms: number }) => Promise<ReportSendOutcome>;
    counters?: Counters;
    suppressed?: string[];
  } = {},
): Fake {
  const shared = options.counters ?? counters();
  const queue = [...rows];
  const clock = { ms: NOW.getTime() };
  const mailed: MailedReport[] = [];
  const posted: Array<{ url: string; body: Uint8Array }> = [];
  const rescheduled: Array<{ id: string; next: Date; delivered: readonly string[] }> = [];
  const deferred: Array<{ id: string; delivered: readonly string[] }> = [];
  const released: Array<{ id: string; delivered: readonly string[] }> = [];
  const removed: string[] = [];
  const expiredWith: number[] = [];
  const claims = { count: 0 };
  const deps: TlsRptJobDeps = {
    now: () => new Date(clock.ms),
    claimOne: async () => {
      claims.count++;
      return queue.shift() ?? null;
    },
    loadResults: async () => options.results ?? RESULTS,
    lookup: async () => options.lookup ?? RECORD,
    mail: async (report) => {
      mailed.push(report);
      return options.mail ? options.mail(report, clock) : { kind: "sent" };
    },
    post: async (url, body) => {
      posted.push({ url, body });
      return options.post ? options.post(url, clock) : { kind: "sent" };
    },
    reschedule: async (id, next, delivered) => {
      rescheduled.push({ id, next, delivered });
    },
    remove: async (id) => {
      removed.push(id);
    },
    deleteExpired: async (days) => {
      expiredWith.push(days);
      return 0;
    },
    reserve: async (destination): Promise<ReserveOutcome> => {
      const used = shared.byDestination.get(destination) ?? 0;
      if (used >= shared.perDestination) return "destination-cap";
      if (shared.sent >= shared.cap) return "daily-cap";
      shared.byDestination.set(destination, used + 1);
      shared.sent++;
      return "reserved";
    },
    release: async (destination) => {
      shared.sent = Math.max(0, shared.sent - 1);
      shared.byDestination.set(
        destination,
        Math.max(0, (shared.byDestination.get(destination) ?? 0) - 1),
      );
    },
    capReached: async () => shared.sent >= shared.cap,
    deferAll: async () => {
      const count = shared.unsent;
      shared.unsent = 0;
      return count;
    },
    defer: async (id, delivered) => {
      deferred.push({ id, delivered });
    },
    releaseClaim: async (id, delivered) => {
      released.push({ id, delivered });
    },
    claimCapWarning: async () => {
      if (shared.warned) return false;
      shared.warned = true;
      return true;
    },
    isSuppressed: async (address) => (options.suppressed ?? []).includes(address),
  };
  return {
    deps,
    clock,
    mailed,
    posted,
    rescheduled,
    deferred,
    released,
    removed,
    expiredWith,
    claims,
    counters: shared,
  };
}

const original = { ...config.tlsRpt };
const originalRedact = config.logRedactPii;
let logged: string[] = [];
let spies: Array<{ mockRestore: () => void }> = [];

beforeAll(() => {
  /** As in production: mail addresses in log lines are redacted. */
  Reflect.set(config, "logRedactPii", true);
  Object.assign(config.tlsRpt, {
    enabled: true,
    organizationName: "Example Org",
    contactEmail: "tls@example.com",
    submitter: "example.com",
    maxReportsPerDay: 2,
  });
});

afterAll(() => {
  Object.assign(config.tlsRpt, original);
  Reflect.set(config, "logRedactPii", originalRedact);
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  logged = [];
});

/** Captures every log line (message and fields) as one string each. */
function captureLogs(): void {
  spies = (["debug", "info", "warn", "error"] as const).map((level) =>
    spyOn(logger, level).mockImplementation((message: string, fields?: unknown) => {
      logged.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
    }),
  );
}

describe("runTlsRptCycle", () => {
  test("off: nothing is claimed", async () => {
    Object.assign(config.tlsRpt, { enabled: false });
    try {
      const f = fake([row()]);
      const summary = await runTlsRptCycle(f.deps);
      expect(summary.reports).toBe(0);
      expect(f.claims.count).toBe(0);
      expect(f.expiredWith).toEqual([]);
    } finally {
      Object.assign(config.tlsRpt, { enabled: true });
    }
  });

  test("a due report goes to every address, then is deleted", async () => {
    captureLogs();
    const f = fake([row()]);
    const summary = await runTlsRptCycle(f.deps);
    expect(summary).toMatchObject({
      reports: 1,
      sent: 2,
      failed: 0,
      finished: 1,
      errors: 0,
    });
    expect(f.expiredWith).toEqual([RETENTION_DAYS]);
    expect(f.removed).toEqual(["trp_1"]);
    expect(f.rescheduled).toEqual([]);

    expect(f.mailed).toHaveLength(1);
    const mailed = f.mailed[0];
    expect(mailed).toMatchObject({
      to: "tls-reports@example.net",
      policyDomain: "example.net",
      submitter: "example.com",
      organizationName: "Example Org",
      contactEmail: "tls@example.com",
      rfcReportId: "3c9f1a52-0d6b-4e6a-8f1e-2b7c9d0e1f2a",
      day: "2026-11-06",
      filename: "example.com!example.net!1793923200!1794009599.json.gz",
    });
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0]?.url).toBe(HTTPS);
    /** The same report bytes on both channels. */
    expect(f.posted[0]?.body).toEqual(mailed?.body ?? new Uint8Array());
    const json: unknown = JSON.parse(
      new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(f.posted[0]?.body ?? []))),
    );
    expect(json).toMatchObject({
      "organization-name": "Example Org",
      "contact-info": "tls@example.com",
      "report-id": "3c9f1a52-0d6b-4e6a-8f1e-2b7c9d0e1f2a",
      "date-range": {
        "start-datetime": "2026-11-06T00:00:00Z",
        "end-datetime": "2026-11-06T23:59:59Z",
      },
    });

    /** Boundary lines: domain, scheme and counts; never the URL path or query. */
    const sentLines = logged.filter((line) => line.includes("TLS report sent"));
    expect(sentLines).toHaveLength(2);
    expect(sentLines.join("\n")).toContain('"scheme":"https"');
    expect(sentLines.join("\n")).toContain('"successful":10');
    expect(sentLines.join("\n")).toContain('"failed":2');
    const all = logged.join("\n");
    expect(all).not.toContain("secret-token");
    expect(all).not.toContain("/v1/tlsrpt");
    /**
     * The mail address goes through `redactEmail` (`t***@example.net` with
     * LOG_REDACT_PII). Compared to the module's own output: another unit
     * file may replace `redact.ts`, and `mock.module` leaks across files.
     */
    expect(sentLines.join("\n")).toContain(
      `"rua":${JSON.stringify(redactEmail("tls-reports@example.net"))}`,
    );
    expect(sentLines.join("\n")).toContain('"rua":"https://reports.example.net"');
  });

  test("a failed address is retried on the backoff; the delivered one is not sent again", async () => {
    captureLogs();
    const first = fake([row()], {
      post: async () => ({ kind: "failed", reason: "HTTP 500" }),
    });
    const summary = await runTlsRptCycle(first.deps);
    expect(summary).toMatchObject({ sent: 1, failed: 1, finished: 0 });
    expect(first.removed).toEqual([]);
    expect(first.rescheduled).toEqual([
      {
        id: "trp_1",
        next: new Date(NOW.getTime() + (RETRY_BACKOFF_MINUTES[0] ?? 0) * 60_000),
        delivered: [ruaHash(MAILTO_KEY)],
      },
    ]);
    expect(logged.join("\n")).toContain("TLS report not delivered");

    /** The next attempt: only the https address, then the report is deleted. */
    const second = fake([row({ attempts: 2, deliveredRua: ruaHash(MAILTO_KEY) })]);
    await runTlsRptCycle(second.deps);
    expect(second.mailed).toHaveLength(0);
    expect(second.posted).toHaveLength(1);
    expect(second.removed).toEqual(["trp_1"]);
  });

  test("an address that differs only by case counts as delivered", async () => {
    const f = fake([row({ deliveredRua: ruaHash(MAILTO_KEY) })], {
      lookup: { kind: "record", rua: [rua("mailto:TLS-Reports@Example.NET")] },
    });
    await runTlsRptCycle(f.deps);
    expect(f.mailed).toHaveLength(0);
    expect(f.removed).toEqual(["trp_1"]);
  });

  test("the last attempt failing drops the report", async () => {
    captureLogs();
    const f = fake(
      [row({ attempts: MAX_SEND_ATTEMPTS, deliveredRua: ruaHash(MAILTO_KEY) })],
      { post: async () => ({ kind: "failed", reason: "timed out" }) },
    );
    const summary = await runTlsRptCycle(f.deps);
    expect(summary.finished).toBe(1);
    expect(f.removed).toEqual(["trp_1"]);
    expect(f.rescheduled).toEqual([]);
    expect(logged.join("\n")).toContain("TLS report dropped after its last attempt");
  });

  test("a domain that no longer publishes a record gets nothing; the report is deleted", async () => {
    captureLogs();
    const f = fake([row()], { lookup: { kind: "none" } });
    await runTlsRptCycle(f.deps);
    expect(f.mailed).toHaveLength(0);
    expect(f.posted).toHaveLength(0);
    expect(f.removed).toEqual(["trp_1"]);
  });

  test("a failed record lookup is retried like a failed send", async () => {
    captureLogs();
    const f = fake([row()], { lookup: { kind: "error", code: "ESERVFAIL" } });
    await runTlsRptCycle(f.deps);
    expect(f.mailed).toHaveLength(0);
    expect(f.removed).toEqual([]);
    expect(f.rescheduled).toHaveLength(1);
  });

  test("no usable mail sender: the mailto address is skipped, its slots given back", async () => {
    captureLogs();
    const f = fake([row()], {
      mail: async () => ({ kind: "skipped", reason: "SYSTEM_MAIL_FROM is not set" }),
    });
    const summary = await runTlsRptCycle(f.deps);
    expect(summary).toMatchObject({ sent: 1, skipped: 1, failed: 0 });
    expect(f.removed).toEqual(["trp_1"]);
    expect(f.counters.sent).toBe(1);
    expect(f.counters.byDestination.get("tls-reports@example.net")).toBe(0);
    expect(logged.join("\n")).toContain("TLS report skipped");
  });

  test("a suppressed mail address gets nothing; other addresses still do", async () => {
    captureLogs();
    const f = fake([row()], { suppressed: ["tls-reports@example.net"] });
    const summary = await runTlsRptCycle(f.deps);
    expect(f.mailed).toHaveLength(0);
    expect(f.posted).toHaveLength(1);
    expect(summary).toMatchObject({ suppressed: 1, sent: 1 });
    expect(f.removed).toEqual(["trp_1"]);
    /** No slot taken for it. */
    expect(f.counters.byDestination.has("tls-reports@example.net")).toBe(false);
    expect(logged.find((line) => line.includes("the address is suppressed"))).toStartWith(
      "debug",
    );
  });

  test("a report over the size cap is dropped without sending", async () => {
    captureLogs();
    const big: TlsRptResultRow = {
      ...RESULTS[0]!,
      policyType: "sts",
      policyString: randomBytes(1_200_000).toString("base64"),
    };
    const f = fake([row()], { results: [big] });
    await runTlsRptCycle(f.deps);
    expect(f.mailed).toHaveLength(0);
    expect(f.posted).toHaveLength(0);
    expect(f.removed).toEqual(["trp_1"]);
    expect(logged.join("\n")).toContain("larger than the size cap");
  });

  test("a report with no counters is deleted without sending", async () => {
    const f = fake([row()], { results: [] });
    await runTlsRptCycle(f.deps);
    expect(f.posted).toHaveLength(0);
    expect(f.removed).toEqual(["trp_1"]);
  });

  test("a step that throws is counted, and the run goes on", async () => {
    captureLogs();
    const f = fake([
      row({ id: "trp_a" }),
      row({ id: "trp_b", policyDomain: "example.org" }),
    ]);
    let calls = 0;
    const deps: TlsRptJobDeps = {
      ...f.deps,
      loadResults: async () => {
        calls++;
        if (calls === 1) throw new Error("db down: SELECT ... WHERE secret");
        return RESULTS;
      },
    };
    const summary = await runTlsRptCycle(deps);
    expect(summary.errors).toBe(1);
    expect(f.removed).toHaveLength(1);
    expect(logged.join("\n")).not.toContain("SELECT");
  });
});

describe("claiming, concurrency and the time budget", () => {
  test("reports are claimed one at a time, at most SEND_CONCURRENCY in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const rows = Array.from({ length: 8 }, (_, i) =>
      row({ id: `trp_${i}`, policyDomain: `d${i}.example` }),
    );
    const f = fake(rows, {
      lookup: { kind: "record", rua: [rua(HTTPS)] },
      post: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Bun.sleep(5);
        inFlight--;
        return { kind: "sent" };
      },
      counters: counters(1_000, 1_000),
    });
    const summary = await runTlsRptCycle(f.deps);
    expect(summary.reports).toBe(8);
    expect(f.removed.toSorted()).toEqual(rows.map((r) => r.id).toSorted());
    expect(peak).toBe(SEND_CONCURRENCY);
    /** Every claim takes one row: 8 rows, then one empty claim per worker at most. */
    expect(f.claims.count).toBeLessThanOrEqual(8 + SEND_CONCURRENCY);
  });

  test("past the time budget a report in progress is handed back, nothing more is claimed", async () => {
    captureLogs();
    const rows = Array.from({ length: 6 }, (_, i) =>
      row({ id: `trp_${i}`, policyDomain: `d${i}.example` }),
    );
    const f = fake(rows, {
      /** A slow MX: the first delivery uses up the run's budget. */
      mail: async (_report, clock) => {
        clock.ms += RUN_BUDGET_MS + 1;
        return { kind: "sent" };
      },
    });
    const summary = await runTlsRptCycle(f.deps);
    /** Only the reports the workers had already claimed were started. */
    expect(f.claims.count).toBeLessThanOrEqual(SEND_CONCURRENCY);
    expect(summary.released).toBeGreaterThanOrEqual(1);
    /** Handed back with the mail address remembered, the https one still owed. */
    expect(f.released[0]?.delivered).toEqual([ruaHash(MAILTO_KEY)]);
    expect(f.posted).toHaveLength(0);
  });

  test("mail reports go out with the short deadline and few MX hosts", () => {
    expect(REPORT_MAIL_LIMITS).toEqual({ deadlineMs: 120_000, maxMxHosts: 2 });
  });
});

describe("daily cap (TLSRPT_MAX_REPORTS_PER_DAY)", () => {
  /** Reports to one https address each (distinct origins), so one delivery per report. */
  const rows = ["a", "b", "c"].map((id) =>
    row({ id: `trp_${id}`, policyDomain: `${id}.example` }),
  );
  const lookupFor = (n: number): TlsRptLookup => ({
    kind: "record",
    rua: [rua(`https://r${n}.example/tls`)],
  });

  test("stops at the cap, defers the cut-short report and the rest to tomorrow, warns once", async () => {
    captureLogs();
    const shared = counters(2, 1_000, 3);
    let n = 0;
    const f = fake(rows, { counters: shared });
    const deps: TlsRptJobDeps = { ...f.deps, lookup: async () => lookupFor(n++) };
    const summary = await runTlsRptCycle(deps);
    expect(f.posted).toHaveLength(2);
    /** The cut-short report and the three others deferAll moved. */
    expect(summary).toMatchObject({ sent: 2, capped: 4 });
    expect(f.removed).toHaveLength(2);
    /** Deferred (to tomorrow), never deleted or retried today. */
    expect(f.deferred).toHaveLength(1);
    expect(f.rescheduled).toEqual([]);
    const warns = logged.filter((line) => line.includes("TLS report daily cap reached"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('"cap":2');
    expect(warns[0]).toContain('"reportsLeft":4');

    /** Another replica (same counters): claims nothing, sends nothing, no second warning. */
    const other = fake([row({ id: "trp_d" })], { counters: shared });
    const again = await runTlsRptCycle(other.deps);
    expect(other.claims.count).toBe(0);
    expect(other.posted).toHaveLength(0);
    expect(again.reports).toBe(0);
    expect(
      logged.filter((line) => line.includes("TLS report daily cap reached")),
    ).toHaveLength(1);
  });

  test("under the cap: every report goes out, no warning", async () => {
    captureLogs();
    let n = 0;
    const f = fake(rows, { counters: counters(3) });
    const deps: TlsRptJobDeps = { ...f.deps, lookup: async () => lookupFor(n++) };
    const summary = await runTlsRptCycle(deps);
    expect(summary).toMatchObject({ sent: 3, capped: 0 });
    expect(logged.join("\n")).not.toContain("daily cap reached");
  });
});

describe("per-destination cap (TLSRPT_MAX_REPORTS_PER_DESTINATION_PER_DAY)", () => {
  test("one origin gets at most its cap; the rest wait for tomorrow", async () => {
    captureLogs();
    /** Many domains, all aiming at one third party's origin (different paths). */
    const rows = Array.from({ length: 4 }, (_, i) =>
      row({ id: `trp_${i}`, policyDomain: `d${i}.example` }),
    );
    let n = 0;
    const f = fake(rows, { counters: counters(1_000, 2) });
    const deps: TlsRptJobDeps = {
      ...f.deps,
      lookup: async () => ({
        kind: "record",
        rua: [rua(`https://victim.example/path${n++}`)],
      }),
    };
    const summary = await runTlsRptCycle(deps);
    expect(f.posted).toHaveLength(2);
    expect(summary.destinationCapped).toBe(2);
    expect(f.removed).toHaveLength(2);
    expect(f.deferred).toHaveLength(2);
    expect(f.counters.byDestination.get("https://victim.example")).toBe(2);
    /** Not the daily cap: no warning. */
    expect(logged.join("\n")).not.toContain("daily cap reached");
  });

  test("addresses that differ only by case share one destination", () => {
    expect(rua("mailto:Victim@Example.org").destination).toBe(
      rua("mailto:victim@example.org").destination,
    );
  });
});
