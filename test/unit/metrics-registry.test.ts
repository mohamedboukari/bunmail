import { describe, test, expect } from "bun:test";
import {
  counter,
  createRegistry,
  escapeLabelValue,
  formatValue,
  gauge,
  histogram,
} from "../../src/modules/metrics/services/registry.ts";

/**
 * The Prometheus text exposition format (#362), checked line by line:
 * a scrape Prometheus cannot parse loses every metric at once.
 */
describe("metrics registry: text format", () => {
  test("a counter renders HELP, TYPE and one line per label set", async () => {
    const registry = createRegistry();
    const sent = counter(registry, "x_total", "Things done.", ["kind"]);
    sent.inc({ kind: "a" });
    sent.inc({ kind: "a" }, 2);
    sent.inc({ kind: "b" });
    expect(await registry.render()).toBe(
      "# HELP x_total Things done.\n" +
        "# TYPE x_total counter\n" +
        'x_total{kind="a"} 3\n' +
        'x_total{kind="b"} 1\n',
    );
  });

  test("a counter with no series renders only its header", async () => {
    const registry = createRegistry();
    counter(registry, "y_total", "Nothing yet.", []);
    expect(await registry.render()).toBe(
      "# HELP y_total Nothing yet.\n# TYPE y_total counter\n",
    );
  });

  test("a counter refuses to go down", () => {
    const registry = createRegistry();
    const c = counter(registry, "z_total", "z", []);
    expect(() => c.inc({}, -1)).toThrow("only goes up");
  });

  test("label values and HELP text are escaped", async () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    const registry = createRegistry();
    counter(registry, "e_total", "line one\nback\\slash", ["v"]).inc({ v: 'say "hi"' });
    const text = await registry.render();
    expect(text).toContain("# HELP e_total line one\\nback\\\\slash\n");
    expect(text).toContain('e_total{v="say \\"hi\\""} 1\n');
  });

  test("a histogram renders cumulative buckets, +Inf, _sum and _count", async () => {
    const registry = createRegistry();
    const h = histogram(registry, "d_seconds", "Durations.", ["area"], [1, 0.5]);
    for (const value of [0.2, 0.7, 3]) h.observe({ area: "api" }, value);
    expect(await registry.render()).toBe(
      "# HELP d_seconds Durations.\n" +
        "# TYPE d_seconds histogram\n" +
        'd_seconds_bucket{area="api",le="0.5"} 1\n' +
        'd_seconds_bucket{area="api",le="1"} 2\n' +
        'd_seconds_bucket{area="api",le="+Inf"} 3\n' +
        'd_seconds_sum{area="api"} 3.9\n' +
        'd_seconds_count{area="api"} 3\n',
    );
  });

  test("a gauge collects its samples at render time, async included", async () => {
    const registry = createRegistry();
    let value = 1;
    gauge(registry, "g", "A gauge.", [], async () => [{ labels: {}, value }]);
    expect(await registry.render()).toContain("g 1\n");
    value = 5;
    expect(await registry.render()).toContain("g 5\n");
  });

  test("special values are spelled out", () => {
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe("+Inf");
    expect(formatValue(Number.NEGATIVE_INFINITY)).toBe("-Inf");
    expect(formatValue(Number.NaN)).toBe("NaN");
    expect(formatValue(0.25)).toBe("0.25");
  });

  test("invalid metric and label names fail at definition", () => {
    const registry = createRegistry();
    expect(() => counter(registry, "bad-name", "x", [])).toThrow("invalid metric name");
    expect(() => counter(registry, "ok_total", "x", ["le"])).toThrow(
      "invalid label name",
    );
    expect(() => counter(registry, "ok_total", "x", ["__x"])).toThrow(
      "invalid label name",
    );
  });
});
