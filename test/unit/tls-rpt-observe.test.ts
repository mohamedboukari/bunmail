import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../src/utils/logger.ts";
import {
  tlsRptPolicyOf,
  type SessionOutcome,
} from "../../src/modules/tls-rpt/services/tls-rpt-classify.ts";
import {
  MAX_CONCURRENT_RECORDINGS,
  observeMxSession,
  observeUnconnectedAttempt,
  setTlsRptObserveDeps,
  settleTlsRptRecordings,
  type TlsRptObserveDeps,
} from "../../src/modules/tls-rpt/services/tls-rpt-observe.service.ts";
import type { TlsRptDomain } from "../../src/modules/tls-rpt/types/tls-rpt.types.ts";

/**
 * The mailer's hand-off to TLS-RPT (#345): off means no lookup and no
 * write; on, each session is classified per domain from that domain's own
 * transactions and recorded in the background, only for domains that
 * publish a record, at most a few at once; a failure to record never
 * reaches the send. The lookup and the store are replaced.
 */

const DOMAIN: TlsRptDomain = {
  domain: "example.net",
  policy: tlsRptPolicyOf({ policy: null, failure: null }),
};
const OTHER: TlsRptDomain = { ...DOMAIN, domain: "example.org" };

type Recorded = Parameters<TlsRptObserveDeps["record"]>[0];

function install(options: {
  enabled?: boolean;
  publishes?: boolean | (() => Promise<boolean>);
  fail?: boolean;
}): { lookups: string[]; recorded: Recorded[] } {
  const lookups: string[] = [];
  const recorded: Recorded[] = [];
  setTlsRptObserveDeps({
    enabled: () => options.enabled ?? true,
    publishes: async (domain) => {
      lookups.push(domain);
      const publishes = options.publishes ?? true;
      return typeof publishes === "function" ? publishes() : publishes;
    },
    record: async (args) => {
      if (options.fail) throw new Error("INSERT INTO tlsrpt_results ... secret");
      recorded.push(args);
      return "recorded";
    },
    now: () => new Date("2026-11-06T12:00:00Z"),
  });
  return { lookups, recorded };
}

afterEach(() => setTlsRptObserveDeps(null));

const AT = { mxHost: "mx.example.net", address: "203.0.113.4" };
const STARTTLS: SessionOutcome[] = [{ tls: "starttls" }];

describe("observeMxSession", () => {
  test("off: no lookup, no write", async () => {
    const seen = install({ enabled: false });
    observeMxSession([{ target: DOMAIN, outcomes: STARTTLS }], AT);
    observeUnconnectedAttempt(DOMAIN);
    await settleTlsRptRecordings();
    expect(seen.lookups).toEqual([]);
    expect(seen.recorded).toEqual([]);
  });

  test("on: each domain of the session is recorded with what its transactions showed", async () => {
    const seen = install({});
    const plaintext: SessionOutcome[] = [{ tls: "plaintext" }];
    observeMxSession(
      [
        { target: DOMAIN, outcomes: plaintext },
        { target: OTHER, outcomes: plaintext },
      ],
      AT,
    );
    await settleTlsRptRecordings();
    expect(seen.lookups.toSorted()).toEqual(["example.net", "example.org"]);
    expect(seen.recorded.map((r) => r.domain).toSorted()).toEqual([
      "example.net",
      "example.org",
    ]);
    expect(seen.recorded[0]?.observation).toEqual({
      result: "starttls-not-supported",
      receivingMxHostname: "mx.example.net",
      receivingIp: "203.0.113.4",
      failureReasonCode: "",
    });
  });

  test("a shared session: a domain whose own transaction reached no TLS decision is not counted", async () => {
    const seen = install({});
    observeMxSession(
      [
        { target: DOMAIN, outcomes: STARTTLS },
        /** Its transaction never ran (the session deadline): no TLS decision. */
        {
          target: OTHER,
          outcomes: [
            { tls: null, error: new Error("SMTP session exceeded 120 s and was closed") },
          ],
        },
      ],
      AT,
    );
    await settleTlsRptRecordings();
    expect(seen.recorded.map((r) => r.domain)).toEqual(["example.net"]);
    expect(seen.lookups).toEqual(["example.net"]);
  });

  test("a domain with no transaction in the session is not counted", async () => {
    const seen = install({});
    observeMxSession([{ target: DOMAIN, outcomes: [] }], AT);
    await settleTlsRptRecordings();
    expect(seen.lookups).toEqual([]);
  });

  test("a domain without a TLS-RPT record is not recorded", async () => {
    const seen = install({ publishes: false });
    observeMxSession([{ target: DOMAIN, outcomes: STARTTLS }], AT);
    await settleTlsRptRecordings();
    expect(seen.lookups).toEqual(["example.net"]);
    expect(seen.recorded).toEqual([]);
  });

  test("a session that is not reported is not even looked up", async () => {
    const seen = install({});
    observeMxSession(
      [
        {
          target: DOMAIN,
          outcomes: [
            { tls: null, error: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) },
          ],
        },
      ],
      AT,
    );
    observeMxSession([], AT);
    await settleTlsRptRecordings();
    expect(seen.lookups).toEqual([]);
  });

  test("a store failure is logged by name only and never thrown", async () => {
    install({ fail: true });
    const warns: string[] = [];
    const spy = spyOn(logger, "warn").mockImplementation(
      (message: string, fields?: unknown) => {
        warns.push(`${message} ${JSON.stringify(fields ?? {})}`);
      },
    );
    try {
      expect(() =>
        observeMxSession([{ target: DOMAIN, outcomes: STARTTLS }], AT),
      ).not.toThrow();
      await settleTlsRptRecordings();
    } finally {
      spy.mockRestore();
    }
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("TLS-RPT session could not be recorded");
    expect(warns[0]).not.toContain("secret");
  });

  test("an unconnected enforce-mode attempt is a validation-failure without host", async () => {
    const seen = install({});
    observeUnconnectedAttempt(DOMAIN);
    await settleTlsRptRecordings();
    expect(seen.recorded[0]?.observation).toMatchObject({
      result: "validation-failure",
      failureReasonCode: "mx-not-in-policy",
    });
  });
});

describe("bounded recordings", () => {
  test("past MAX_CONCURRENT_RECORDINGS running, new ones are dropped, logged once a minute", async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const seen = install({
      publishes: async () => {
        await gate;
        return true;
      },
    });
    const debugs: string[] = [];
    const spy = spyOn(logger, "debug").mockImplementation(
      (message: string, fields?: unknown) => {
        debugs.push(`${message} ${JSON.stringify(fields ?? {})}`);
      },
    );
    try {
      for (let i = 0; i < MAX_CONCURRENT_RECORDINGS + 3; i++) {
        observeMxSession([{ target: DOMAIN, outcomes: STARTTLS }], AT);
      }
      /** Only the first ones started; the others were dropped at once. */
      expect(seen.lookups).toHaveLength(MAX_CONCURRENT_RECORDINGS);
      open();
      await settleTlsRptRecordings();
    } finally {
      spy.mockRestore();
    }
    expect(seen.recorded).toHaveLength(MAX_CONCURRENT_RECORDINGS);
    const dropped = debugs.filter((line) => line.includes("too many recordings running"));
    /** Three drops inside one minute: one debug line. */
    expect(dropped).toHaveLength(1);

    /** Once the running ones finish, recording works again. */
    const after = install({});
    observeMxSession([{ target: DOMAIN, outcomes: STARTTLS }], AT);
    await settleTlsRptRecordings();
    expect(after.recorded).toHaveLength(1);
  });
});
