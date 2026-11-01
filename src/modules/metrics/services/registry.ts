/**
 * A minimal Prometheus registry (#362): counters, histograms, and gauges
 * computed when scraped, rendered in the text exposition format 0.0.4.
 *
 * Hand-rolled on purpose: the format is small, and a dependency would be
 * one more package in the image for a few hundred lines of logic. Every
 * name and label is checked when the metric is defined, so a typo fails
 * at boot rather than producing a scrape Prometheus rejects.
 */

/** The label values of one series, by label name. */
export type LabelValues<L extends string> = Readonly<Record<L, string>>;

/** One sample of a gauge, as its collector returns it. */
export interface GaugeSample<L extends string> {
  labels: LabelValues<L>;
  value: number;
}

/** A counter: only goes up, reset on restart. */
export interface Counter<L extends string> {
  inc(labels: LabelValues<L>, by?: number): void;
}

/** A histogram: counts observations into cumulative buckets. */
export interface Histogram<L extends string> {
  observe(labels: LabelValues<L>, value: number): void;
}

/** What a registry holds: something that renders its own lines. */
interface Renderable {
  render(): string | Promise<string>;
}

/** A set of metrics rendered together on scrape. */
export interface Registry {
  add(metric: Renderable): void;
  render(): Promise<string>;
}

const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Escapes a HELP text: backslash and line feed. */
function escapeHelp(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

/** Escapes a label value: backslash, double quote and line feed. */
export function escapeLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

/** A sample value as the format writes it (`+Inf`, `-Inf`, `NaN` spelled out). */
export function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

/** `{a="1",b="2"}` in the declared label order, plus an optional extra label; "" when empty. */
function labelString(
  names: readonly string[],
  values: Readonly<Record<string, string>>,
  extra?: readonly [string, string],
): string {
  const pairs = names.map((name) => `${name}="${escapeLabelValue(values[name] ?? "")}"`);
  if (extra !== undefined) pairs.push(`${extra[0]}="${escapeLabelValue(extra[1])}"`);
  return pairs.length === 0 ? "" : `{${pairs.join(",")}}`;
}

/** The HELP and TYPE lines of a metric. */
function header(
  name: string,
  help: string,
  type: "counter" | "gauge" | "histogram",
): string {
  return `# HELP ${name} ${escapeHelp(help)}\n# TYPE ${name} ${type}\n`;
}

/** Checks a metric's name and label names; throws on anything the format refuses. */
function checkNames(name: string, labelNames: readonly string[]): void {
  if (!METRIC_NAME_RE.test(name)) throw new Error(`invalid metric name "${name}"`);
  for (const label of labelNames) {
    if (!LABEL_NAME_RE.test(label) || label.startsWith("__") || label === "le") {
      throw new Error(`invalid label name "${label}" on ${name}`);
    }
  }
}

/** A stable key for one series: its values in the declared label order. */
function seriesKey(
  names: readonly string[],
  values: Readonly<Record<string, string>>,
): string {
  return JSON.stringify(names.map((name) => values[name] ?? ""));
}

/** Creates an empty registry. */
export function createRegistry(): Registry {
  const metrics: Renderable[] = [];
  return {
    add(metric) {
      metrics.push(metric);
    },
    async render() {
      const parts = await Promise.all(metrics.map(async (metric) => metric.render()));
      return parts.join("");
    },
  };
}

/** Defines a counter on `registry`. */
export function counter<L extends string>(
  registry: Registry,
  name: string,
  help: string,
  labelNames: readonly L[],
): Counter<L> {
  checkNames(name, labelNames);
  const series = new Map<string, { labels: LabelValues<L>; value: number }>();
  registry.add({
    render() {
      let out = header(name, help, "counter");
      for (const { labels, value } of series.values()) {
        out += `${name}${labelString(labelNames, labels)} ${formatValue(value)}\n`;
      }
      return out;
    },
  });
  return {
    inc(labels, by = 1) {
      if (!(by >= 0)) throw new Error(`${name}: a counter only goes up`);
      const key = seriesKey(labelNames, labels);
      const current = series.get(key);
      if (current === undefined) series.set(key, { labels, value: by });
      else current.value += by;
    },
  };
}

/** Defines a histogram on `registry`; `buckets` are upper bounds, `+Inf` is implied. */
export function histogram<L extends string>(
  registry: Registry,
  name: string,
  help: string,
  labelNames: readonly L[],
  buckets: readonly number[],
): Histogram<L> {
  checkNames(name, labelNames);
  const bounds = buckets.toSorted((a, b) => a - b);
  const series = new Map<
    string,
    { labels: LabelValues<L>; counts: number[]; sum: number; count: number }
  >();
  registry.add({
    render() {
      let out = header(name, help, "histogram");
      for (const { labels, counts, sum, count } of series.values()) {
        let cumulative = 0;
        bounds.forEach((bound, i) => {
          cumulative += counts[i] ?? 0;
          out += `${name}_bucket${labelString(labelNames, labels, ["le", formatValue(bound)])} ${cumulative}\n`;
        });
        out += `${name}_bucket${labelString(labelNames, labels, ["le", "+Inf"])} ${count}\n`;
        out += `${name}_sum${labelString(labelNames, labels)} ${formatValue(sum)}\n`;
        out += `${name}_count${labelString(labelNames, labels)} ${count}\n`;
      }
      return out;
    },
  });
  return {
    observe(labels, value) {
      const key = seriesKey(labelNames, labels);
      let entry = series.get(key);
      if (entry === undefined) {
        entry = { labels, counts: bounds.map(() => 0), sum: 0, count: 0 };
        series.set(key, entry);
      }
      const index = bounds.findIndex((bound) => value <= bound);
      if (index >= 0) entry.counts[index] = (entry.counts[index] ?? 0) + 1;
      entry.sum += value;
      entry.count += 1;
    },
  };
}

/** A metric whose samples `collect` returns at each scrape, rendered as `type`. */
function collected<L extends string>(
  registry: Registry,
  type: "gauge" | "counter",
  name: string,
  help: string,
  labelNames: readonly L[],
  collect: () => readonly GaugeSample<L>[] | Promise<readonly GaugeSample<L>[]>,
): void {
  checkNames(name, labelNames);
  registry.add({
    async render() {
      let out = header(name, help, type);
      for (const { labels, value } of await collect()) {
        out += `${name}${labelString(labelNames, labels)} ${formatValue(value)}\n`;
      }
      return out;
    },
  });
}

/** Defines a gauge on `registry` whose samples `collect` returns at each scrape. */
export function gauge<L extends string>(
  registry: Registry,
  name: string,
  help: string,
  labelNames: readonly L[],
  collect: () => readonly GaugeSample<L>[] | Promise<readonly GaugeSample<L>[]>,
): void {
  collected(registry, "gauge", name, help, labelNames, collect);
}

/**
 * Defines a counter read from elsewhere at each scrape (a total kept by
 * the runtime, like CPU seconds): typed `counter`, so `rate()` applies.
 */
export function collectedCounter<L extends string>(
  registry: Registry,
  name: string,
  help: string,
  labelNames: readonly L[],
  collect: () => readonly GaugeSample<L>[] | Promise<readonly GaugeSample<L>[]>,
): void {
  collected(registry, "counter", name, help, labelNames, collect);
}
