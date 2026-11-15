import { describe, test, expect, spyOn, afterEach } from "bun:test";
import type { DaneConfig } from "../../src/config/dane.ts";
import { parseServer, type DnsServer } from "../../src/utils/dns-transport.ts";
import { logger } from "../../src/utils/logger.ts";
import {
  BOGUS_PROBE_NAME,
  SIGNED_PROBE_NAME,
  isRunning,
  runDaneResolverCheck,
  start,
  stop,
} from "../../src/modules/emails/services/dane-resolver-check.service.ts";
import { aRecord, secureZoneHandler, useFakeDns } from "../fake-dns.ts";

/**
 * The DANE_RESOLVER self-check (#426,
 * `src/modules/emails/services/dane-resolver-check.service.ts`), against
 * the fake resolver on 127.0.0.1: a validating resolver passes, one that
 * does not answer logs `error`, one that answers without AD or passes a
 * deliberately broken name on logs `warn`, and nothing is asked while DANE
 * is off. No real DNS.
 */

const fake = useFakeDns();

/** The fake resolver as a `DnsServer`. */
function resolver(): DnsServer {
  const server = parseServer(fake.dns.server);
  if (server === null) throw new Error("bad fake server address");
  return server;
}

/** DANE on, aimed at the fake resolver. */
function daneOn(): DaneConfig {
  return { enabled: true, resolver: resolver() };
}

/** Short timeouts, so the no-answer case ends quickly. */
const TIMEOUTS = { attemptTimeoutMs: 200, timeoutMs: 800 };

/** The zone key of a probe name's A query. */
const SIGNED_KEY = `${SIGNED_PROBE_NAME} A`;
const BOGUS_KEY = `${BOGUS_PROBE_NAME} A`;

/** Every logger spy of the current test, restored after it. */
let spies: { mockRestore(): void }[] = [];

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  stop();
});

/** Silences and records the three levels the check logs at. */
function spyLogs(): {
  info: ReturnType<typeof spyOn<typeof logger, "info">>;
  warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  error: ReturnType<typeof spyOn<typeof logger, "error">>;
} {
  const info = spyOn(logger, "info").mockImplementation(() => undefined);
  const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
  const error = spyOn(logger, "error").mockImplementation(() => undefined);
  spies = [info, warn, error];
  return { info, warn, error };
}

describe("runDaneResolverCheck: outcomes", () => {
  test("a validating resolver passes: signed name with AD, broken name refused", async () => {
    const logs = spyLogs();
    fake.serve(
      secureZoneHandler({
        [SIGNED_KEY]: { answers: [] },
        [BOGUS_KEY]: { rcode: 2, ad: false },
      }),
    );
    expect(await runDaneResolverCheck(daneOn(), TIMEOUTS)).toEqual({ status: "passed" });
    expect(fake.dns.queries.map((q) => q.name)).toEqual([
      SIGNED_PROBE_NAME,
      BOGUS_PROBE_NAME,
    ]);
    expect(logs.info).toHaveBeenCalledTimes(1);
    expect(logs.info.mock.calls[0]?.[0]).toContain("passed");
    expect(logs.info.mock.calls[0]?.[1]).toMatchObject({
      resolver: "127.0.0.1",
      port: resolver().port,
      signedName: SIGNED_PROBE_NAME,
      bogusName: BOGUS_PROBE_NAME,
    });
    expect(logs.warn).not.toHaveBeenCalled();
    expect(logs.error).not.toHaveBeenCalled();
  });

  test("no answer at all logs error and does not ask the broken name", async () => {
    const logs = spyLogs();
    fake.serve(() => []);
    expect(await runDaneResolverCheck(daneOn(), TIMEOUTS)).toEqual({
      status: "failing",
      code: "ETIMEOUT",
    });
    expect(fake.dns.queries.every((q) => q.name === SIGNED_PROBE_NAME)).toBe(true);
    expect(logs.error).toHaveBeenCalledTimes(1);
    expect(logs.error.mock.calls[0]?.[0]).toContain("does not answer");
    expect(logs.error.mock.calls[0]?.[1]).toMatchObject({
      resolver: "127.0.0.1",
      code: "ETIMEOUT",
    });
    expect(logs.info).not.toHaveBeenCalled();
  });

  test("SERVFAIL on the signed name logs error: it cannot resolve", async () => {
    const logs = spyLogs();
    fake.serve(secureZoneHandler({ [SIGNED_KEY]: { rcode: 2, ad: false } }));
    expect(await runDaneResolverCheck(daneOn(), TIMEOUTS)).toEqual({
      status: "failing",
      code: "ESERVFAIL",
    });
    expect(logs.error).toHaveBeenCalledTimes(1);
    expect(logs.error.mock.calls[0]?.[0]).toContain("cannot resolve");
  });

  test("the signed name without AD logs warn: not validating", async () => {
    const logs = spyLogs();
    fake.serve(secureZoneHandler({ [SIGNED_KEY]: { answers: [], ad: false } }));
    expect(await runDaneResolverCheck(daneOn(), TIMEOUTS)).toEqual({
      status: "not-validating",
      reason: "signed-name-without-ad",
    });
    expect(fake.dns.queries.map((q) => q.name)).toEqual([SIGNED_PROBE_NAME]);
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.warn.mock.calls[0]?.[0]).toContain("does not validate");
    expect(logs.warn.mock.calls[0]?.[1]).toMatchObject({
      name: SIGNED_PROBE_NAME,
      reason: "signed-name-without-ad",
    });
    expect(logs.error).not.toHaveBeenCalled();
  });

  test("the broken name resolving logs warn: bogus answers are passed on", async () => {
    const logs = spyLogs();
    fake.serve(
      secureZoneHandler({
        [SIGNED_KEY]: { answers: [] },
        [BOGUS_KEY]: { answers: [aRecord("192.0.2.1")], ad: false },
      }),
    );
    expect(await runDaneResolverCheck(daneOn(), TIMEOUTS)).toEqual({
      status: "not-validating",
      reason: "bogus-name-resolved",
    });
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.warn.mock.calls[0]?.[1]).toMatchObject({
      name: BOGUS_PROBE_NAME,
      reason: "bogus-name-resolved",
    });
    expect(logs.info).not.toHaveBeenCalled();
  });

  test("a broken name that is gone or validates now is unconfirmed, logged at info", async () => {
    const logs = spyLogs();
    /** Gone: a signed NXDOMAIN (the handler's fallback). */
    fake.serve(secureZoneHandler({ [SIGNED_KEY]: { answers: [] } }));
    expect(await runDaneResolverCheck(daneOn(), TIMEOUTS)).toEqual({
      status: "unconfirmed",
    });
    /** Fixed: an answer with AD. */
    fake.serve(
      secureZoneHandler({
        [SIGNED_KEY]: { answers: [] },
        [BOGUS_KEY]: { answers: [aRecord("192.0.2.1")] },
      }),
    );
    expect(await runDaneResolverCheck(daneOn(), TIMEOUTS)).toEqual({
      status: "unconfirmed",
    });
    expect(logs.info).toHaveBeenCalledTimes(2);
    expect(logs.info.mock.calls[0]?.[0]).toContain("not confirmed");
    expect(logs.warn).not.toHaveBeenCalled();
    expect(logs.error).not.toHaveBeenCalled();
  });
});

describe("DANE off: no check", () => {
  test("a run asks nothing and logs nothing", async () => {
    const logs = spyLogs();
    fake.serve(secureZoneHandler({ [SIGNED_KEY]: { answers: [] } }));
    expect(
      await runDaneResolverCheck({ enabled: false, resolver: null }, TIMEOUTS),
    ).toBeNull();
    expect(fake.dns.queries).toHaveLength(0);
    expect(logs.info).not.toHaveBeenCalled();
    expect(logs.warn).not.toHaveBeenCalled();
    expect(logs.error).not.toHaveBeenCalled();
  });

  test("start does not schedule anything", () => {
    spyLogs();
    start({ enabled: false, resolver: null });
    expect(isRunning()).toBe(false);
  });
});

describe("start and stop", () => {
  test("with DANE on, start schedules the check and stop ends it", () => {
    const logs = spyLogs();
    fake.serve(() => []);
    start(daneOn());
    expect(isRunning()).toBe(true);
    expect(logs.info.mock.calls[0]?.[0]).toBe("Starting DANE resolver check");
    /** Idempotent. */
    start(daneOn());
    expect(logs.info).toHaveBeenCalledTimes(1);
    stop();
    expect(isRunning()).toBe(false);
    expect(fake.dns.queries).toHaveLength(0);
  });
});
