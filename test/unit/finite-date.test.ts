/**
 * `finiteDate` (#457): a timestamp column value as a real instant, or
 * `null` for a Postgres `infinity` / `-infinity` (the number `Infinity`
 * under Bun 1.4, an invalid `Date` under 1.3.14). The integration test
 * `infinity-timestamps.integration.test.ts` proves the decoding with
 * real rows; this pins the helper and the dashboard's `TimeDisplay`.
 */
import { describe, test, expect } from "bun:test";
import { finiteDate } from "../../src/utils/finite-date.ts";
import { TimeDisplay } from "../../src/pages/components/time-display.tsx";

describe("finiteDate", () => {
  test("returns a valid Date as it is", () => {
    const at = new Date("2026-11-15T12:00:00Z");
    expect(finiteDate(at)).toBe(at);
  });

  test("the epoch is a real instant, not a missing one", () => {
    const epoch = new Date(0);
    expect(finiteDate(epoch)).toBe(epoch);
  });

  test("Infinity and -Infinity (Bun 1.4 decoding) are no date", () => {
    expect(finiteDate(Infinity)).toBeNull();
    expect(finiteDate(-Infinity)).toBeNull();
  });

  test("an invalid Date (Bun 1.3.14 decoding) is no date", () => {
    expect(finiteDate(new Date(Number.NaN))).toBeNull();
    expect(finiteDate(new Date("infinity"))).toBeNull();
  });

  test("a bare number is never taken for an instant", () => {
    expect(finiteDate(0)).toBeNull();
    expect(finiteDate(1_763_208_000_000)).toBeNull();
    expect(finiteDate(Number.NaN)).toBeNull();
  });

  test("null and undefined stay no date", () => {
    expect(finiteDate(null)).toBeNull();
    expect(finiteDate(undefined)).toBeNull();
  });
});

describe("TimeDisplay", () => {
  test("renders a valid instant as a <time> element", async () => {
    const html = await TimeDisplay({ value: new Date("2026-11-15T12:34:56Z") });
    expect(html).toContain('datetime="2026-11-15T12:34:56.000Z"');
    expect(html).toContain("2026-11-15 12:34 UTC");
  });

  test("an invalid Date shows the fallback instead of throwing", async () => {
    expect(await TimeDisplay({ value: new Date(Number.NaN) })).toBe("n/a");
    expect(
      await TimeDisplay({ value: new Date(Number.NaN), fallback: "Permanent" }),
    ).toBe("Permanent");
  });
});
