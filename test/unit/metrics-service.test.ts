import { describe, test, expect, spyOn } from "bun:test";
import { readMetricsToken } from "../../src/config.ts";
import {
  httpArea,
  isAuthorizedScrape,
  recordSmtpConnection,
  recordSmtpMessageAccepted,
  recordSmtpRejection,
  recordTrackingRequest,
  recordWebhookAttempt,
  renderMetrics,
} from "../../src/modules/metrics/services/metrics.service.ts";
import { isBlacklistedIp } from "../../src/modules/inbound/services/dnsbl.service.ts";
import { logger } from "../../src/utils/logger.ts";

/** The `area` label must stay a small fixed set: never a raw path, which carries IDs. */
describe("httpArea", () => {
  test.each([
    ["/api/v1/emails", "api/v1/emails"],
    ["/api/v1/emails/msg_0123456789abcdef01234567", "api/v1/emails"],
    ["/api/v1/api-keys/key_1/rotate", "api/v1/api-keys"],
    ["/api/v1/nope", "api/v1/other"],
    ["/api/v1", "api/v1/other"],
    ["/api/docs/json", "api/docs"],
    ["/dashboard/emails/msg_1", "dashboard"],
    ["/u/:token", "unsubscribe"],
    ["/t/o/:token", "tracking"],
    ["/t/c/:token", "tracking"],
    ["/health", "health"],
    ["/metrics", "metrics"],
    ["/", "other"],
    ["/wp-login.php", "other"],
    ["/health/extra", "other"],
  ])("%s -> %s", (path, area) => {
    expect(httpArea(path)).toBe(area);
  });
});

describe("isAuthorizedScrape", () => {
  const TOKEN = "a".repeat(40);

  test("accepts the exact bearer token, any scheme case", () => {
    expect(isAuthorizedScrape(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorizedScrape(`bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  test.each([
    ["no header", null],
    ["empty", ""],
    ["another scheme", `Basic ${TOKEN}`],
    ["a bare token", TOKEN],
    ["a wrong token", `Bearer ${"b".repeat(40)}`],
    ["a prefix of the token", `Bearer ${TOKEN.slice(0, 39)}`],
    ["the token plus more", `Bearer ${TOKEN}x`],
    ["two tokens", `Bearer ${TOKEN} ${TOKEN}`],
  ])("refuses %s", (_label, header) => {
    expect(isAuthorizedScrape(header, TOKEN)).toBe(false);
  });
});

describe("readMetricsToken (METRICS_TOKEN)", () => {
  test("unset or blank turns /metrics off", () => {
    expect(readMetricsToken(undefined)).toBeNull();
    expect(readMetricsToken("")).toBeNull();
    expect(readMetricsToken("   ")).toBeNull();
  });

  /** 32 characters, 31 distinct: the shape of a random token. */
  const VARIED = "Zq-8_Yp7Xo6Wn5Vm4Ul3Tk2Sj1Ri0QhA";

  test("a 32 to 256 character URL-safe token is kept, trimmed", () => {
    const hex = "0123456789abcdef".repeat(4);
    expect(readMetricsToken(` ${hex} `)).toBe(hex);
    expect(readMetricsToken(VARIED)).toBe(VARIED);
    expect(readMetricsToken(VARIED.repeat(8))).toBe(VARIED.repeat(8));
  });

  test.each([
    ["too short", VARIED.slice(0, 31)],
    ["too long", `${VARIED.repeat(8)}x`],
    ["a space inside", `${VARIED.slice(0, 16)} ${VARIED.slice(16)}`],
    ["other characters", `${VARIED}=`],
    ["one repeated character", "a".repeat(64)],
    ["fewer than 8 distinct characters", "abcdefg".repeat(10)],
  ])("refuses to boot on %s", (_label, raw) => {
    expect(() => readMetricsToken(raw)).toThrow("METRICS_TOKEN must be 32 to 256");
  });
});

/**
 * The SMTP, webhook and DNSBL counters (#362, part 2) reach the scrape.
 * Counters only go up and are shared by the process, so each test reads
 * the value before and after.
 */
describe("part 2 counters in the scrape", () => {
  /** The value of one exact series line in a fresh scrape, 0 when absent. */
  async function sample(series: string): Promise<number> {
    const text = await renderMetrics();
    const line = text.split("\n").find((l) => l.startsWith(`${series} `));
    return line === undefined ? 0 : Number(line.slice(series.length + 1));
  }

  test("SMTP connections, rejections and accepted messages, per listener", async () => {
    const conn = 'bunmail_smtp_connections_total{listener="inbound"}';
    const rej =
      'bunmail_smtp_rejections_total{listener="submission",reason="auth_failed"}';
    const ok = 'bunmail_smtp_messages_accepted_total{listener="submission"}';
    const before = [await sample(conn), await sample(rej), await sample(ok)];
    recordSmtpConnection("inbound");
    recordSmtpRejection("submission", "auth_failed");
    recordSmtpRejection("submission", "auth_failed");
    recordSmtpMessageAccepted("submission");
    expect(await sample(conn)).toBe((before[0] ?? 0) + 1);
    expect(await sample(rej)).toBe((before[1] ?? 0) + 2);
    expect(await sample(ok)).toBe((before[2] ?? 0) + 1);
  });

  test("tracking requests by kind and result (#187)", async () => {
    const series = 'bunmail_tracking_requests_total{kind="click",result="deduped"}';
    const before = await sample(series);
    recordTrackingRequest("click", "deduped");
    expect(await sample(series)).toBe(before + 1);
  });

  test("webhook attempts by outcome", async () => {
    const retry = 'bunmail_webhook_attempts_total{outcome="retry"}';
    const before = await sample(retry);
    recordWebhookAttempt("retry");
    expect(await sample(retry)).toBe(before + 1);
  });

  test("every unchecked DNSBL connection counts, even while the warning is throttled", async () => {
    const series = 'bunmail_inbound_dnsbl_unchecked_total{kind="refused"}';
    const before = await sample(series);
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    /**
     * A refusal code no other test uses: the warning throttle is module
     * state keyed by reason, so sharing a key would mute another file's
     * expected warning (order-dependent, #293).
     */
    const deps = {
      lookup: (): Promise<string[]> => Promise.resolve(["127.255.255.252"]),
      now: () => 1_000,
    };
    for (let i = 0; i < 3; i += 1) await isBlacklistedIp("8.8.8.8", "zen.example", deps);
    warn.mockRestore();
    expect(await sample(series)).toBe(before + 3);
  });
});
