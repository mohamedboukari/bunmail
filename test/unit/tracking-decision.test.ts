import { describe, test, expect } from "bun:test";
import {
  decideTracking,
  type TrackingContext,
} from "../../src/modules/emails/services/tracking-decision.ts";

/**
 * The open and click tracking decision (#187), every gate combination
 * that matters: the kill switch, the sender domain's opt-in, the send's
 * own request, `transactional` mail, recipients, `APP_BASE_URL` and SMTP
 * submission. Pure: the integration test covers the same rules through
 * `createEmail` and the database.
 */

/** Every gate open: the domain opted in to both, one recipient, https base URL. */
const open: TrackingContext = {
  enabled: true,
  source: "api",
  category: null,
  domain: { opens: true, clicks: true },
  oneClickBlocker: null,
};

describe("all gates open", () => {
  test("unset inherits the domain: both tracked, no warning", () => {
    expect(decideTracking(undefined, open)).toEqual({
      opens: true,
      clicks: true,
      refusedBy: null,
    });
    expect(decideTracking({}, open)).toEqual({
      opens: true,
      clicks: true,
      refusedBy: null,
    });
  });

  test("explicit true: tracked, no warning", () => {
    expect(decideTracking({ opens: true, clicks: true }, open)).toEqual({
      opens: true,
      clicks: true,
      refusedBy: null,
    });
  });

  test("false always wins, per kind", () => {
    expect(decideTracking({ opens: false }, open)).toEqual({
      opens: false,
      clicks: true,
      refusedBy: null,
    });
    expect(decideTracking({ clicks: false }, open)).toEqual({
      opens: true,
      clicks: false,
      refusedBy: null,
    });
    expect(decideTracking({ opens: false, clicks: false }, open)).toEqual({
      opens: false,
      clicks: false,
      refusedBy: null,
    });
  });

  test("marketing inherits like an unset category", () => {
    expect(decideTracking(undefined, { ...open, category: "marketing" })).toEqual({
      opens: true,
      clicks: true,
      refusedBy: null,
    });
  });
});

describe("transactional mail", () => {
  const transactional: TrackingContext = { ...open, category: "transactional" };

  test("unset: never tracked, no warning", () => {
    expect(decideTracking(undefined, transactional)).toEqual({
      opens: false,
      clicks: false,
      refusedBy: null,
    });
  });

  test("explicit true: tracked when the domain allows it", () => {
    expect(decideTracking({ opens: true }, transactional)).toEqual({
      opens: true,
      clicks: false,
      refusedBy: null,
    });
  });

  test("explicit true on a domain that has not opted in: off, with the reason", () => {
    expect(
      decideTracking(
        { opens: true, clicks: true },
        { ...transactional, domain: { opens: false, clicks: false } },
      ),
    ).toEqual({ opens: false, clicks: false, refusedBy: "domain_not_opted_in" });
  });
});

describe("the domain opt-in", () => {
  test("opted in to opens only: clicks stay off, no warning when unset", () => {
    expect(
      decideTracking(undefined, { ...open, domain: { opens: true, clicks: false } }),
    ).toEqual({ opens: true, clicks: false, refusedBy: null });
  });

  test("a send cannot turn on what the domain has off", () => {
    expect(
      decideTracking(
        { clicks: true },
        { ...open, domain: { opens: true, clicks: false } },
      ),
    ).toEqual({ opens: true, clicks: false, refusedBy: "domain_not_opted_in" });
  });

  test("an unregistered domain (development) is never tracked", () => {
    const unregistered: TrackingContext = { ...open, domain: null };
    expect(decideTracking(undefined, unregistered)).toEqual({
      opens: false,
      clicks: false,
      refusedBy: null,
    });
    expect(decideTracking({ opens: true }, unregistered)).toEqual({
      opens: false,
      clicks: false,
      refusedBy: "domain_not_opted_in",
    });
  });
});

describe("the kill switch", () => {
  const off: TrackingContext = { ...open, enabled: false };

  test("off: nothing tracked, unset sends get no warning", () => {
    expect(decideTracking(undefined, off)).toEqual({
      opens: false,
      clicks: false,
      refusedBy: null,
    });
  });

  test("off: an explicit true is refused by the switch first", () => {
    expect(decideTracking({ opens: true, clicks: true }, off)).toEqual({
      opens: false,
      clicks: false,
      refusedBy: "tracking_disabled",
    });
  });

  test("off: false still answers false without a warning", () => {
    expect(decideTracking({ opens: false, clicks: false }, off)).toEqual({
      opens: false,
      clicks: false,
      refusedBy: null,
    });
  });
});

describe("recipients and APP_BASE_URL (the one-click conditions)", () => {
  test.each(["recipients", "app_base_url"] as const)(
    "%s blocks inherited tracking silently and explicit tracking with a warning",
    (blocker) => {
      const blocked: TrackingContext = { ...open, oneClickBlocker: blocker };
      expect(decideTracking(undefined, blocked)).toEqual({
        opens: false,
        clicks: false,
        refusedBy: null,
      });
      expect(decideTracking({ clicks: true }, blocked)).toEqual({
        opens: false,
        clicks: false,
        refusedBy: blocker,
      });
    },
  );
});

describe("SMTP submission", () => {
  test("never tracked, even with every gate open", () => {
    expect(decideTracking(undefined, { ...open, source: "smtp" })).toEqual({
      opens: false,
      clicks: false,
      refusedBy: null,
    });
  });
});

describe("gate order", () => {
  test("the first closed gate is the one reported", () => {
    const everythingClosed: TrackingContext = {
      enabled: false,
      source: "api",
      category: null,
      domain: null,
      oneClickBlocker: "recipients",
    };
    expect(decideTracking({ opens: true }, everythingClosed).refusedBy).toBe(
      "tracking_disabled",
    );
    expect(
      decideTracking({ opens: true }, { ...everythingClosed, enabled: true }).refusedBy,
    ).toBe("domain_not_opted_in");
    expect(
      decideTracking(
        { opens: true },
        { ...everythingClosed, enabled: true, domain: { opens: true, clicks: true } },
      ).refusedBy,
    ).toBe("recipients");
  });

  test("an opens refusal is reported even when clicks are honoured", () => {
    expect(
      decideTracking(
        { opens: true, clicks: true },
        { ...open, domain: { opens: false, clicks: true } },
      ),
    ).toEqual({ opens: false, clicks: true, refusedBy: "domain_not_opted_in" });
  });
});
