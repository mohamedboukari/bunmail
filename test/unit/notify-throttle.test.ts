import { describe, test, expect } from "bun:test";
import {
  NOTIFY_DOMAIN_THROTTLE_MAX,
  NOTIFY_THROTTLE_MAX,
  NOTIFY_THROTTLE_WINDOW_MS,
  NotifyThrottle,
} from "../../src/modules/inbound/services/notify-throttle.ts";

/** The per-recipient inbound notification budget (#250). */
describe("NotifyThrottle", () => {
  const T0 = Date.parse("2026-10-19T12:00:00Z");

  test("5 per address per 10 minutes, then the next window reports the rest", () => {
    const throttle = new NotifyThrottle();
    const decisions = Array.from({ length: 7 }, (_, i) =>
      throttle.check("a@example.com", T0 + i * 1000),
    );
    expect(decisions.filter((d) => d.notify)).toHaveLength(NOTIFY_THROTTLE_MAX);
    expect(decisions.slice(0, 5).every((d) => d.notify && d.skipped === null)).toBe(true);
    /** Only the first skipped message of the window is flagged for the log. */
    expect(decisions[5]).toEqual({
      notify: false,
      limitedBy: "address",
      firstInWindow: true,
    });
    expect(decisions[6]).toEqual({
      notify: false,
      limitedBy: "address",
      firstInWindow: false,
    });

    const next = throttle.check("a@example.com", T0 + NOTIFY_THROTTLE_WINDOW_MS + 1);
    expect(next).toEqual({ notify: true, skipped: { count: 2, since: T0 + 5000 } });
    /** Reported once only. */
    expect(throttle.check("a@example.com", T0 + NOTIFY_THROTTLE_WINDOW_MS + 2)).toEqual({
      notify: true,
      skipped: null,
    });
  });

  test("addresses have their own budget, compared case-insensitively", () => {
    const throttle = new NotifyThrottle();
    for (let i = 0; i < NOTIFY_THROTTLE_MAX; i++) throttle.check("a@example.com", T0);
    expect(throttle.check("A@Example.com", T0).notify).toBe(false);
    expect(throttle.check("b@example.com", T0).notify).toBe(true);
  });

  test("30 per domain per 10 minutes, across addresses", () => {
    const throttle = new NotifyThrottle();
    const decisions = Array.from({ length: NOTIFY_DOMAIN_THROTTLE_MAX + 2 }, (_, i) =>
      throttle.check(`user${i}@catchall.example`, T0 + i),
    );
    expect(decisions.filter((d) => d.notify)).toHaveLength(NOTIFY_DOMAIN_THROTTLE_MAX);
    expect(decisions[NOTIFY_DOMAIN_THROTTLE_MAX]).toEqual({
      notify: false,
      limitedBy: "domain",
      firstInWindow: true,
    });
    expect(decisions[NOTIFY_DOMAIN_THROTTLE_MAX + 1]).toEqual({
      notify: false,
      limitedBy: "domain",
      firstInWindow: false,
    });
    /** Another domain has its own budget; case does not matter. */
    expect(throttle.check("user0@other.example", T0).notify).toBe(true);
    expect(throttle.check("x@CATCHALL.example", T0).notify).toBe(false);

    /** The skipped address hears about it on its next notification. */
    const later = T0 + NOTIFY_THROTTLE_WINDOW_MS + 1;
    expect(
      throttle.check(`user${NOTIFY_DOMAIN_THROTTLE_MAX}@catchall.example`, later),
    ).toEqual({
      notify: true,
      skipped: { count: 1, since: T0 + NOTIFY_DOMAIN_THROTTLE_MAX },
    });
  });

  test("a message skipped by one budget does not use up the other", () => {
    const throttle = new NotifyThrottle();
    /** 20 messages to one address: 5 notified, 15 skipped by the address budget. */
    for (let i = 0; i < 20; i++) throttle.check("busy@d.example", T0);
    /** The domain spent only 5 of its 30: 25 other addresses still notify. */
    const others = Array.from({ length: 25 }, (_, i) =>
      throttle.check(`u${i}@d.example`, T0),
    );
    expect(others.every((d) => d.notify)).toBe(true);
    /** Domain spent: a fresh address is skipped without using its own budget. */
    expect(throttle.check("fresh@d.example", T0)).toMatchObject({ limitedBy: "domain" });
    const later = T0 + NOTIFY_THROTTLE_WINDOW_MS;
    const after = Array.from({ length: NOTIFY_THROTTLE_MAX }, () =>
      throttle.check("fresh@d.example", later),
    );
    expect(after.every((d) => d.notify)).toBe(true);
  });

  test("prune keeps an unreported count for a day, then drops it", () => {
    const throttle = new NotifyThrottle();
    for (let i = 0; i <= NOTIFY_THROTTLE_MAX; i++) throttle.check("a@example.com", T0);
    throttle.prune(T0 + NOTIFY_THROTTLE_WINDOW_MS);
    expect(throttle.check("a@example.com", T0 + NOTIFY_THROTTLE_WINDOW_MS)).toEqual({
      notify: true,
      skipped: { count: 1, since: T0 },
    });

    for (let i = 0; i <= NOTIFY_THROTTLE_MAX; i++) throttle.check("b@example.com", T0);
    throttle.prune(T0 + 24 * 60 * 60 * 1000);
    expect(throttle.check("b@example.com", T0 + 24 * 60 * 60 * 1000)).toEqual({
      notify: true,
      skipped: null,
    });
  });
});
