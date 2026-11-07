import { afterEach, describe, test, expect } from "bun:test";
import { daneHostResolver } from "../../src/modules/emails/services/mailer-dane.service.ts";
import {
  deliverWithFailover,
  type MxRouteDeps,
  type SessionRunner,
} from "../../src/modules/emails/services/mx-route.ts";
import type { MtaStsPolicy } from "../../src/modules/emails/services/mta-sts-policy.ts";
import type { SecureMx } from "../../src/modules/emails/types/dane.types.ts";
import {
  setTlsRptObserveDeps,
  settleTlsRptRecordings,
  type TlsRptObserveDeps,
} from "../../src/modules/tls-rpt/services/tls-rpt-observe.service.ts";
import { parseServer, type DnsServer } from "../../src/utils/dns-transport.ts";
import { classifySendFailure } from "../../src/utils/smtp-error.ts";
import { tlsRptPolicyOf } from "../../src/modules/tls-rpt/services/tls-rpt-classify.ts";
import {
  aRecord,
  secureZoneHandler,
  tlsaRecord,
  useFakeDns,
  type SecureZoneAnswer,
} from "../fake-dns.ts";

/**
 * A DANE domain's delivery (#345, `mailer-dane.service.ts` through
 * `deliverWithFailover`), against a fake validating resolver and a stub
 * SMTP session: hosts in MX order, each decided by DANE when reached; a
 * failed DNSSEC lookup skips the host (and is recorded for TLS-RPT); a
 * DANE failure fails over, and with no host left the entry is retried,
 * never bounced; DANE wins over an MTA-STS enforce policy for a host with
 * TLSA records, while a host without them still follows the policy.
 */

const fake = useFakeDns();

afterEach(() => setTlsRptObserveDeps(null));

/** The fake resolver as the trusted one. */
function resolver(): DnsServer {
  const server = parseServer(fake.dns.server);
  if (server === null) throw new Error("bad fake server address");
  return server;
}

const SECURE_MX: SecureMx = {
  nextHop: "example.org",
  expandedNextHop: "example.org",
  implicit: false,
};

const DIGEST = new Uint8Array(32).fill(9);

/** A signed host with an address, and TLSA records unless `tlsa` is null. */
function signedHost(
  name: string,
  address: string,
  tlsa: SecureZoneAnswer | null,
): Record<string, SecureZoneAnswer> {
  return {
    [`${name} A`]: { answers: [aRecord(address)] },
    [`${name} AAAA`]: { answers: [] },
    ...(tlsa === null ? {} : { [`_25._tcp.${name} TLSA`]: tlsa }),
  };
}

/** Route deps for the failover: port 25, nothing else used. */
const ROUTE_DEPS: MxRouteDeps = {
  resolveMx: async () => [],
  resolve4: async () => [],
  resolve6: async () => [],
  lookup: async () => [],
  random: () => 0.5,
  smtpPort: () => 25,
  timeoutMs: 1_000,
};

/** A session stub recording each host, whether it had DANE, and failing hosts in `failing`. */
function sessions(failing: ReadonlySet<string> = new Set()): {
  calls: Array<{ mxHost: string; address: string; dane: string | null }>;
  run: SessionRunner;
} {
  const calls: Array<{ mxHost: string; address: string; dane: string | null }> = [];
  const run: SessionRunner = async ({ mxHost, address, transactions, dane }) => {
    calls.push({ mxHost, address, dane: dane?.baseDomain ?? null });
    return transactions.map((t) =>
      failing.has(mxHost)
        ? {
            key: t.key,
            error: new Error(
              `DANE: no authenticated TLS with ${mxHost} (Error initiating TLS - DANE: no TLSA record matches the certificate chain)`,
            ),
            tls: null,
          }
        : { key: t.key, tls: "starttls" },
    );
  };
  return { calls, run };
}

/** Delivers one transaction to `hosts` through the DANE resolver. */
function deliver(
  hosts: string[],
  run: SessionRunner,
  options: { verifiedTls?: boolean; sts?: MtaStsPolicy; report?: boolean } = {},
) {
  return deliverWithFailover({
    domain: "example.org",
    hosts,
    transactions: [
      { key: "example.org", mail: { from: "a@example.com", to: "b@example.org" } },
    ],
    allowPrivate: true,
    runSession: run,
    lock: (_bucket, fn) => fn(),
    routeDeps: ROUTE_DEPS,
    resolveHost: daneHostResolver({
      dane: {
        secureMx: SECURE_MX,
        stsPolicy: options.sts === undefined ? null : { id: "p1", policy: options.sts },
      },
      verifiedTls: options.verifiedTls ?? false,
      reportTargets:
        options.report === true
          ? [
              {
                domain: "example.org",
                policy:
                  options.sts === undefined
                    ? tlsRptPolicyOf({ policy: null, failure: null })
                    : tlsRptPolicyOf({
                        policy: { id: "p1", policy: options.sts },
                        failure: null,
                      }),
              },
            ]
          : [],
      resolver: resolver(),
      allowPrivate: true,
      ipFamily: 4,
      timeouts: { attemptTimeoutMs: 300, timeoutMs: 1_000 },
    }),
  });
}

describe("a DANE domain's hosts, decided one by one", () => {
  test("a host with TLSA records gets a DANE session, one without a plain one", async () => {
    fake.serve(
      secureZoneHandler({
        ...signedHost("mx1.example.org", "192.0.2.1", {
          answers: [tlsaRecord(3, 1, 1, DIGEST)],
        }),
        ...signedHost("mx2.example.org", "192.0.2.2", { answers: [] }),
      }),
    );
    const { calls, run } = sessions(new Set(["mx1.example.org"]));
    const outcomes = await deliver(["mx1.example.org", "mx2.example.org"], run);
    expect(calls).toEqual([
      { mxHost: "mx1.example.org", address: "192.0.2.1", dane: "mx1.example.org" },
      { mxHost: "mx2.example.org", address: "192.0.2.2", dane: null },
    ]);
    /** The DANE failure on mx1 failed over to mx2. */
    expect(outcomes).toEqual([
      { key: "example.org", tls: "starttls", mxHost: "mx2.example.org" },
    ]);
  });

  test("a failed TLSA lookup skips the host (never 'no DANE'), and is recorded as dnssec-invalid", async () => {
    const recorded: Parameters<TlsRptObserveDeps["record"]>[0][] = [];
    setTlsRptObserveDeps({
      enabled: () => true,
      publishes: async () => true,
      record: async (args) => {
        recorded.push(args);
        return "recorded";
      },
    });
    fake.serve(
      secureZoneHandler({
        ...signedHost("mx1.example.org", "192.0.2.1", { rcode: 2, ad: false }),
        ...signedHost("mx2.example.org", "192.0.2.2", {
          answers: [tlsaRecord(3, 1, 1, DIGEST)],
        }),
      }),
    );
    const { calls, run } = sessions();
    await deliver(["mx1.example.org", "mx2.example.org"], run, {
      report: true,
    });
    expect(calls.map((c) => c.mxHost)).toEqual(["mx2.example.org"]);
    await settleTlsRptRecordings();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.policy).toMatchObject({
      type: "tlsa",
      mxHost: ["mx1.example.org"],
    });
    expect(recorded[0]?.observation).toEqual({
      result: "dnssec-invalid",
      receivingMxHostname: "mx1.example.org",
      receivingIp: "",
      failureReasonCode: "",
    });
  });

  test("every host failing DANE: no SMTP reply, so the entry is retried, never bounced", async () => {
    fake.serve(
      secureZoneHandler({
        ...signedHost("mx1.example.org", "192.0.2.1", {
          answers: [tlsaRecord(3, 1, 1, DIGEST)],
        }),
        ...signedHost("mx2.example.org", "192.0.2.2", { rcode: 2, ad: false }),
      }),
    );
    const { calls, run } = sessions(new Set(["mx1.example.org"]));
    const [outcome] = await deliver(["mx1.example.org", "mx2.example.org"], run);
    expect(calls.map((c) => c.mxHost)).toEqual(["mx1.example.org"]);
    expect(outcome?.error).toBeInstanceOf(Error);
    expect(classifySendFailure(outcome?.error)).toBeNull();
  });

  test("DANE wins over MTA-STS: a TLSA host outside an enforce policy is still tried, with DANE", async () => {
    fake.serve(
      secureZoneHandler({
        ...signedHost("mx1.example.org", "192.0.2.1", {
          answers: [tlsaRecord(3, 1, 1, DIGEST)],
        }),
        ...signedHost("mx2.example.org", "192.0.2.2", { answers: [] }),
        ...signedHost("mx3.example.org", "192.0.2.3", { answers: [] }),
      }),
    );
    const sts: MtaStsPolicy = {
      mode: "enforce",
      mx: ["mx3.example.org"],
      maxAge: 86_400,
    };
    const { calls, run } = sessions(new Set(["mx1.example.org"]));
    await deliver(["mx1.example.org", "mx2.example.org", "mx3.example.org"], run, {
      verifiedTls: true,
      sts,
    });
    /** mx1: DANE despite the policy; mx2: no DANE and not in the policy, skipped; mx3: the policy. */
    expect(calls).toEqual([
      { mxHost: "mx1.example.org", address: "192.0.2.1", dane: "mx1.example.org" },
      { mxHost: "mx3.example.org", address: "192.0.2.3", dane: null },
    ]);
  });

  test("a non-DANE host outside an enforce policy is skipped and recorded as mx-not-in-policy", async () => {
    const recorded: Parameters<TlsRptObserveDeps["record"]>[0][] = [];
    setTlsRptObserveDeps({
      enabled: () => true,
      publishes: async () => true,
      record: async (args) => {
        recorded.push(args);
        return "recorded";
      },
    });
    fake.serve(
      secureZoneHandler({
        ...signedHost("mx1.example.org", "192.0.2.1", { answers: [] }),
        ...signedHost("mx2.example.org", "192.0.2.2", { answers: [] }),
      }),
    );
    const sts: MtaStsPolicy = {
      mode: "enforce",
      mx: ["mx2.example.org"],
      maxAge: 86_400,
    };
    const { calls, run } = sessions();
    await deliver(["mx1.example.org", "mx2.example.org"], run, {
      verifiedTls: true,
      sts,
      report: true,
    });
    expect(calls.map((c) => c.mxHost)).toEqual(["mx2.example.org"]);
    await settleTlsRptRecordings();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.policy.type).toBe("sts");
    expect(recorded[0]?.observation).toEqual({
      result: "validation-failure",
      receivingMxHostname: "",
      receivingIp: "",
      failureReasonCode: "mx-not-in-policy",
    });
  });
});
