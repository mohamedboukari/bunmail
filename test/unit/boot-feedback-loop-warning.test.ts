import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { warnIgnoredSettings } from "../../src/boot.ts";
import { config } from "../../src/config.ts";
import { logger } from "../../src/utils/logger.ts";

/**
 * The boot warnings about the feedback-loop lists behind verified
 * complaints: `FEEDBACK_LOOP_DOMAINS` without `FEEDBACK_LOOP_SENDERS`
 * verifies nothing, and a consumer mailbox domain in
 * `FEEDBACK_LOOP_DOMAINS` signs its users' mail. `config` is changed in
 * place (read-only only to TypeScript) and restored; the logger is spied
 * on, never mocked as a module (a module mock leaks across files).
 */

const NO_SENDERS = "FEEDBACK_LOOP_DOMAINS is set but FEEDBACK_LOOP_SENDERS is empty";
const CONSUMER = "FEEDBACK_LOOP_DOMAINS lists a mailbox provider domain";

const saved = {
  domains: [...config.suppressions.feedbackLoopDomains],
  senders: [...config.suppressions.feedbackLoopSenders],
};

afterEach(() => {
  expect(Reflect.set(config.suppressions, "feedbackLoopDomains", saved.domains)).toBe(
    true,
  );
  expect(Reflect.set(config.suppressions, "feedbackLoopSenders", saved.senders)).toBe(
    true,
  );
});

/**
 * Runs the boot warnings with the given lists.
 *
 * @returns The fields of each feedback-loop warning logged, by message start.
 */
function bootWith(
  domains: string[],
  senders: string[],
): { noSenders: unknown[]; consumer: unknown[] } {
  expect(Reflect.set(config.suppressions, "feedbackLoopDomains", domains)).toBe(true);
  expect(Reflect.set(config.suppressions, "feedbackLoopSenders", senders)).toBe(true);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    warnIgnoredSettings();
    const fieldsOf = (prefix: string): unknown[] =>
      warn.mock.calls.filter((call) => call[0].startsWith(prefix)).map((call) => call[1]);
    return { noSenders: fieldsOf(NO_SENDERS), consumer: fieldsOf(CONSUMER) };
  } finally {
    warn.mockRestore();
  }
}

describe("feedback-loop boot warnings", () => {
  test("domains set, senders empty: warned once (nothing is verified)", () => {
    const { noSenders } = bootWith(["fbl.example.net"], []);
    expect(noSenders).toHaveLength(1);
    expect(JSON.stringify(noSenders[0])).toContain("FEEDBACK_LOOP_SENDERS");
  });

  test("both set: no such warning", () => {
    expect(bootWith(["fbl.example.net"], ["feedback@fbl.example.net"]).noSenders).toEqual(
      [],
    );
  });

  test("neither set (feature off): no warning at all", () => {
    expect(bootWith([], [])).toEqual({ noSenders: [], consumer: [] });
  });

  test("a consumer mailbox domain in FEEDBACK_LOOP_DOMAINS: warned once, naming only those domains", () => {
    const { consumer } = bootWith(
      ["fbl.example.net", "hotmail.com", "gmx.de"],
      ["staff@hotmail.com"],
    );
    expect(consumer).toEqual([
      expect.objectContaining({ domains: ["hotmail.com", "gmx.de"] }),
    ]);
  });

  test("a subdomain of a consumer mailbox domain is warned about too", () => {
    expect(
      bootWith(["arf.mail.yahoo.com"], ["feedback@arf.mail.yahoo.com"]).consumer,
    ).toEqual([expect.objectContaining({ domains: ["arf.mail.yahoo.com"] })]);
  });

  test("an unrelated domain is not", () => {
    expect(bootWith(["fbl.example.net"], ["feedback@fbl.example.net"]).consumer).toEqual(
      [],
    );
  });
});
