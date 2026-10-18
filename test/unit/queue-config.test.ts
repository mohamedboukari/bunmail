import { describe, test, expect } from "bun:test";
import { optionalBoundedInt } from "../../src/config.ts";

/**
 * Queue throughput env vars (#176): `QUEUE_BATCH_SIZE`,
 * `QUEUE_POLL_INTERVAL_MS` and `QUEUE_MAX_CONCURRENT_SENDS` default when
 * unset and refuse to boot on anything but a whole number in range.
 */
describe("optionalBoundedInt", () => {
  const read = (raw: string | undefined): number =>
    optionalBoundedInt("QUEUE_MAX_CONCURRENT_SENDS", 10, 1, 500, raw);

  test("unset or blank: the default", () => {
    expect(read(undefined)).toBe(10);
    expect(read("")).toBe(10);
    expect(read("   ")).toBe(10);
  });

  test.each([
    ["1", 1],
    ["25", 25],
    [" 40 ", 40],
    ["500", 500],
  ])("accepts %p", (raw, value) => {
    expect(read(raw)).toBe(value);
  });

  test.each(["0", "-1", "1.5", "10x", "abc", "1e1", "0x10", "+5", "501"])(
    "refuses %p, naming the variable and the range",
    (raw) => {
      expect(() => read(raw)).toThrow(
        /QUEUE_MAX_CONCURRENT_SENDS must be a whole number from 1 to 500/,
      );
    },
  );
});
