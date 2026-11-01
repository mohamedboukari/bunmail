import { describe, test, expect, spyOn, afterEach } from "bun:test";
import {
  classifyDnsblAnswers,
  dnsblQueryName,
  isBlacklistedIp,
  selfTestDnsbl,
} from "../../src/modules/inbound/services/dnsbl.service.ts";
import { logger } from "../../src/utils/logger.ts";

const ZONE = "zen.spamhaus.org";

describe("dnsblQueryName (#166)", () => {
  test("public IPv4 is looked up with reversed octets", () => {
    expect(dnsblQueryName("1.2.3.4", ZONE)).toBe("4.3.2.1.zen.spamhaus.org");
  });

  /** The bug: startsWith("172.") skipped all of 172.0.0.0/8. Only 172.16.0.0/12 is private. */
  test.each([
    ["172.15.1.1", "1.1.15.172.zen.spamhaus.org"],
    ["172.15.255.255", "255.255.15.172.zen.spamhaus.org"],
    ["172.32.0.0", "0.0.32.172.zen.spamhaus.org"],
    ["172.32.1.1", "1.1.32.172.zen.spamhaus.org"],
    ["172.217.0.1", "1.0.217.172.zen.spamhaus.org"],
  ])("public 172.x address %s is checked", (ip, query) => {
    expect(dnsblQueryName(ip, ZONE)).toBe(query);
  });

  test.each([
    "172.16.0.0",
    "172.16.1.1",
    "172.31.255.255",
    "10.0.0.1",
    "192.168.1.1",
    /** all of loopback, not just the 127.0.0.1 literal */
    "127.0.0.1",
    "127.0.0.2",
    "127.255.255.255",
    /** link-local, incl. cloud metadata */
    "169.254.1.1",
    "169.254.169.254",
    /** CGNAT */
    "100.64.0.0",
    "100.127.255.255",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
  ])("non-public address %s is skipped", (ip) => {
    expect(dnsblQueryName(ip, ZONE)).toBeNull();
  });

  test("CGNAT boundaries: just outside 100.64.0.0/10 is checked", () => {
    expect(dnsblQueryName("100.63.255.255", ZONE)).toBe(
      "255.255.63.100.zen.spamhaus.org",
    );
    expect(dnsblQueryName("100.128.0.0", ZONE)).toBe("0.0.128.100.zen.spamhaus.org");
  });

  test("IPv6 is skipped (public and private)", () => {
    expect(dnsblQueryName("2606:4700:4700::1111", ZONE)).toBeNull();
    expect(dnsblQueryName("::1", ZONE)).toBeNull();
    expect(dnsblQueryName("fe80::1", ZONE)).toBeNull();
  });

  test("IPv4-mapped IPv6 is unwrapped before deciding", () => {
    expect(dnsblQueryName("::ffff:1.2.3.4", ZONE)).toBe("4.3.2.1.zen.spamhaus.org");
    expect(dnsblQueryName("::ffff:10.0.0.1", ZONE)).toBeNull();
  });

  test("malformed input is skipped, never queried", () => {
    expect(dnsblQueryName("not-an-ip", ZONE)).toBeNull();
    expect(dnsblQueryName("999.1.1.1", ZONE)).toBeNull();
    expect(dnsblQueryName("", ZONE)).toBeNull();
  });
});

/**
 * Answers are read like the outbound self-check reads them: only a
 * listing code means listed. Spamhaus answers `127.255.255.254` to every
 * query sent through a public resolver (1.1.1.1), so treating any answer
 * as a listing would refuse every sender.
 */
describe("classifyDnsblAnswers", () => {
  test.each([["127.0.0.2"], ["127.0.0.4"], ["127.0.0.10"], ["127.0.0.255"]])(
    "%s is a listing",
    (answer) => {
      expect(classifyDnsblAnswers([answer])).toEqual({ kind: "listed" });
    },
  );

  test("a refused query wins over listing codes", () => {
    expect(classifyDnsblAnswers(["127.0.0.2", "127.255.255.254"])).toEqual({
      kind: "refused",
      answer: "127.255.255.254",
    });
  });

  test.each([["127.0.0.1"], ["93.184.216.34"], ["127.1.0.2"]])(
    "%s is not a listing code",
    (answer) => {
      expect(classifyDnsblAnswers([answer])).toEqual({ kind: "unexpected", answer });
    },
  );

  test("no answer is not listed", () => {
    expect(classifyDnsblAnswers([])).toEqual({ kind: "not-listed" });
  });
});

/**
 * A check that did not run says so (postmortem logging), at most once per
 * reason every ten minutes. The lookup and clock are injected and the
 * logger spied, not `mock.module`, so nothing leaks into other files
 * (#293). Each test runs at its own hour, past the previous throttle.
 */
describe("isBlacklistedIp", () => {
  const PUBLIC_IP = "8.8.8.8";
  const HOUR = 60 * 60 * 1000;
  let hour = 1_000;

  /** A clock an hour past the previous test's, so throttle state never carries over. */
  function freshClock(): { now: () => number; advance: (ms: number) => void } {
    hour += 1;
    let at = hour * HOUR;
    return { now: () => at, advance: (ms) => (at += ms) };
  }

  /** A DNS error shaped like Bun's (`code` on an Error). */
  function dnsError(code: string): Error {
    return Object.assign(new Error(`queryA ${code}`), { code });
  }

  const answering =
    (...answers: string[]) =>
    (): Promise<string[]> =>
      Promise.resolve(answers);
  const failing = (code: string) => (): Promise<string[]> =>
    Promise.reject(dnsError(code));

  afterEach(() => {
    spyOn(logger, "warn").mockRestore();
  });

  test("a listing code means listed, with no warning", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    const deps = { lookup: answering("127.0.0.4"), ...freshClock() };
    expect(await isBlacklistedIp(PUBLIC_IP, ZONE, deps)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  test.each(["ENOTFOUND", "ENODATA"])(
    "%s means not listed, with no warning",
    async (code) => {
      const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
      const deps = { lookup: failing(code), ...freshClock() };
      expect(await isBlacklistedIp(PUBLIC_IP, ZONE, deps)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  test("a refused query (public resolver) is allowed, never treated as listed", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    const deps = { lookup: answering("127.255.255.254"), ...freshClock() };
    expect(await isBlacklistedIp(PUBLIC_IP, ZONE, deps)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "DNSBL check did not run: connection allowed unchecked",
      {
        reason: "refused:127.255.255.254",
        ip: PUBLIC_IP,
        zone: ZONE,
        answer: "127.255.255.254",
        suppressedSinceLast: 0,
      },
    );
  });

  test("an unexpected answer (NXDOMAIN rewritten) is allowed with a warning", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    const deps = { lookup: answering("93.184.216.34"), ...freshClock() };
    expect(await isBlacklistedIp(PUBLIC_IP, ZONE, deps)).toBe(false);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ reason: "unexpected:93.184.216.34" });
  });

  test.each(["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED"])(
    "%s fails open and warns with the code",
    async (code) => {
      const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
      const deps = { lookup: failing(code), ...freshClock() };
      expect(await isBlacklistedIp(PUBLIC_IP, ZONE, deps)).toBe(false);
      expect(warn.mock.calls[0]?.[1]).toMatchObject({
        reason: `lookup-failed:${code}`,
        code,
        suppressedSinceLast: 0,
      });
    },
  );

  test("an error without a code still warns", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    const deps = {
      lookup: (): Promise<string[]> => Promise.reject(new Error("odd")),
      ...freshClock(),
    };
    expect(await isBlacklistedIp(PUBLIC_IP, ZONE, deps)).toBe(false);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ code: "unknown" });
  });

  test("repeats are throttled for ten minutes, then counted on the next line", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    const clock = freshClock();
    const deps = { lookup: failing("ETIMEOUT"), now: clock.now };
    for (let i = 0; i < 5; i += 1) await isBlacklistedIp(PUBLIC_IP, ZONE, deps);
    expect(warn).toHaveBeenCalledTimes(1);
    clock.advance(10 * 60 * 1000);
    await isBlacklistedIp(PUBLIC_IP, ZONE, deps);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[1]).toMatchObject({ suppressedSinceLast: 4 });
  });

  test("each reason has its own throttle", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    const { now } = freshClock();
    await isBlacklistedIp(PUBLIC_IP, ZONE, { lookup: failing("ESERVFAIL"), now });
    await isBlacklistedIp(PUBLIC_IP, ZONE, { lookup: answering("127.255.255.255"), now });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

/**
 * The boot self-test (RFC 5782 §5: every DNSBL lists 127.0.0.2). Through a
 * resolver the zone blocks, the test entry comes back unlisted or refused,
 * and the per-connection check silently protects nothing.
 */
describe("selfTestDnsbl", () => {
  afterEach(() => {
    spyOn(logger, "warn").mockRestore();
    spyOn(logger, "info").mockRestore();
  });

  test("queries the test entry and passes when it is listed", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => undefined);
    const queried: string[] = [];
    const lookup = (name: string): Promise<string[]> => {
      queried.push(name);
      return Promise.resolve(["127.0.0.2", "127.0.0.10"]);
    };
    expect(await selfTestDnsbl(ZONE, { lookup })).toBe("ok");
    expect(queried).toEqual(["2.0.0.127.zen.spamhaus.org"]);
    expect(info).toHaveBeenCalledWith("Inbound DNSBL self-test passed", { zone: ZONE });
  });

  test("NXDOMAIN for the test entry (Google Public DNS) is not answering", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    const lookup = (): Promise<string[]> =>
      Promise.reject(Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" }));
    expect(await selfTestDnsbl(ZONE, { lookup })).toBe("not-answering");
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ zone: ZONE, code: "ENOTFOUND" });
  });

  test("a refused answer (Cloudflare) is reported as refused", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    const lookup = (): Promise<string[]> => Promise.resolve(["127.255.255.254"]);
    expect(await selfTestDnsbl(ZONE, { lookup })).toBe("refused");
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ answer: "127.255.255.254" });
  });
});

/** A clock stepping back (an NTP correction) must not mute the warning until it catches up. */
describe("isBlacklistedIp: the warning throttle and a clock that went back", () => {
  test("after a backwards step the next failure warns again", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    const lookup = (): Promise<string[]> =>
      Promise.reject(Object.assign(new Error("queryA EBADRESP"), { code: "EBADRESP" }));
    await isBlacklistedIp("8.8.8.8", ZONE, { lookup, now: () => 50_000_000 });
    await isBlacklistedIp("8.8.8.8", ZONE, { lookup, now: () => 10_000_000 });
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
