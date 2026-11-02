/** A metrics scrape token: long enough that it cannot be guessed, header-safe. */
const METRICS_TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;

/** Fewest distinct characters a scrape token may have (`openssl rand -hex 32` has 16). */
const METRICS_TOKEN_MIN_DISTINCT = 8;

/**
 * Reads `METRICS_TOKEN` (#362): the bearer token a scraper sends to
 * `GET /metrics`. Unset or blank turns the endpoint off (404). Anything
 * else must be 32 to 256 letters, digits, `-` or `_` (for example
 * `openssl rand -hex 32`) with at least 8 distinct characters, or the
 * server refuses to boot: a short or repetitive token would protect
 * nothing, and the endpoint has no rate limit. Never logged. Exported
 * for tests.
 */
export function readMetricsToken(
  raw: string | undefined = process.env["METRICS_TOKEN"],
): string | null {
  const token = raw?.trim() ?? "";
  if (token === "") return null;
  if (!METRICS_TOKEN_RE.test(token) || new Set(token).size < METRICS_TOKEN_MIN_DISTINCT) {
    throw new Error(
      "[config] METRICS_TOKEN must be 32 to 256 letters, digits, '-' or '_', with at least 8 distinct characters.\n" +
        "  → Generate one with `openssl rand -hex 32`, or leave it empty to turn /metrics off.",
    );
  }
  return token;
}

/** Samplers BunMail understands in `OTEL_TRACES_SAMPLER` (#363), as the OpenTelemetry spec names them. */
const TRACES_SAMPLERS = [
  "always_on",
  "always_off",
  "traceidratio",
  "parentbased_always_on",
  "parentbased_always_off",
  "parentbased_traceidratio",
] as const;
export type TracesSampler = (typeof TRACES_SAMPLERS)[number];

/** Narrows a configured sampler name to the supported ones. */
function isTracesSampler(value: string): value is TracesSampler {
  return (TRACES_SAMPLERS as readonly string[]).includes(value);
}

/** The service name when `OTEL_SERVICE_NAME` is unset. */
const DEFAULT_TRACING_SERVICE_NAME = "bunmail";

/** Where spans go when tracing is on and no endpoint is set: a local OTLP/HTTP collector. */
const DEFAULT_TRACES_ENDPOINT = "http://localhost:4318/v1/traces";

/**
 * OpenTelemetry tracing (#363): off, or on with where to export and how
 * to sample. Exporter transport details (`OTEL_EXPORTER_OTLP_HEADERS`,
 * timeout, compression, certificates) are read by the exporter itself and
 * never pass through here, so a backend token in the headers is never held
 * in `config` or logged.
 */
export type TracingSettings =
  | { enabled: false }
  | {
      enabled: true;
      /** Full OTLP/HTTP traces URL, `/v1/traces` included. */
      endpoint: string;
      serviceName: string;
      sampler: TracesSampler;
      /** Ratio for the `traceidratio` samplers, from 0 to 1. */
      samplerRatio: number;
    };

/** The raw tracing environment variables, injectable for tests. */
interface TracingEnv {
  sdkDisabled: string | undefined;
  exporter: string | undefined;
  endpoint: string | undefined;
  tracesEndpoint: string | undefined;
  protocol: string | undefined;
  tracesProtocol: string | undefined;
  serviceName: string | undefined;
  sampler: string | undefined;
  samplerArg: string | undefined;
}

/**
 * True when `raw` is an `http:` or `https:` URL. The value is never echoed
 * in an error: an endpoint can carry credentials in its user info or query.
 */
function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Reads the tracing settings (#363) from the standard `OTEL_*` variables.
 * Off by default: on only when `OTEL_EXPORTER_OTLP_ENDPOINT` or
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set, or `OTEL_TRACES_EXPORTER=otlp`
 * (which exports to a local collector by default). `OTEL_SDK_DISABLED=true`
 * or `OTEL_TRACES_EXPORTER=none` force it off. Unset and blank mean unset.
 *
 * Strict, so a typo cannot silently export nowhere or somewhere else: an
 * endpoint that is not an http(s) URL, a protocol other than
 * `http/protobuf`, an exporter other than `otlp` or `none`, an unknown
 * sampler, a ratio outside 0 to 1, or a service name with control
 * characters or over 255 characters refuses to boot, whether tracing is
 * on or not. Exported for tests.
 */
export function readTracingSettings(
  env: TracingEnv = {
    sdkDisabled: process.env["OTEL_SDK_DISABLED"],
    exporter: process.env["OTEL_TRACES_EXPORTER"],
    endpoint: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
    tracesEndpoint: process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"],
    protocol: process.env["OTEL_EXPORTER_OTLP_PROTOCOL"],
    tracesProtocol: process.env["OTEL_EXPORTER_OTLP_TRACES_PROTOCOL"],
    serviceName: process.env["OTEL_SERVICE_NAME"],
    sampler: process.env["OTEL_TRACES_SAMPLER"],
    samplerArg: process.env["OTEL_TRACES_SAMPLER_ARG"],
  },
): TracingSettings {
  const disabledRaw = env.sdkDisabled?.trim().toLowerCase() ?? "";
  if (disabledRaw !== "" && disabledRaw !== "true" && disabledRaw !== "false") {
    throw new Error(
      `[config] OTEL_SDK_DISABLED must be "true" or "false", got "${env.sdkDisabled}"`,
    );
  }

  const exporter = env.exporter?.trim().toLowerCase() ?? "";
  if (exporter !== "" && exporter !== "otlp" && exporter !== "none") {
    throw new Error(
      `[config] OTEL_TRACES_EXPORTER must be "otlp" or "none", got "${env.exporter}"\n` +
        "  → BunMail exports traces over OTLP/HTTP only; point it at an OpenTelemetry Collector to reach other backends.",
    );
  }

  const endpoint = env.endpoint?.trim() ?? "";
  const tracesEndpoint = env.tracesEndpoint?.trim() ?? "";
  for (const [name, value] of [
    ["OTEL_EXPORTER_OTLP_ENDPOINT", endpoint],
    ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", tracesEndpoint],
  ] as const) {
    if (value !== "" && !isHttpUrl(value)) {
      throw new Error(
        `[config] ${name} must be an http:// or https:// URL, for example http://otel-collector:4318`,
      );
    }
  }

  for (const [name, raw] of [
    ["OTEL_EXPORTER_OTLP_PROTOCOL", env.protocol],
    ["OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", env.tracesProtocol],
  ] as const) {
    const protocol = raw?.trim() ?? "";
    if (protocol !== "" && protocol !== "http/protobuf") {
      throw new Error(
        `[config] ${name} must be "http/protobuf", got "${raw}"\n` +
          "  → BunMail exports traces over OTLP/HTTP with protobuf; gRPC and JSON are not supported.",
      );
    }
  }

  const serviceName = env.serviceName?.trim() ?? "";
  let hasControlChar = false;
  for (let i = 0; i < serviceName.length; i++) {
    const code = serviceName.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) hasControlChar = true;
  }
  if (serviceName.length > 255 || hasControlChar) {
    throw new Error(
      "[config] OTEL_SERVICE_NAME must be at most 255 characters, without control characters",
    );
  }

  const samplerRaw = env.sampler?.trim().toLowerCase() ?? "";
  const sampler = samplerRaw === "" ? "parentbased_always_on" : samplerRaw;
  if (!isTracesSampler(sampler)) {
    throw new Error(
      `[config] Invalid OTEL_TRACES_SAMPLER "${env.sampler}", must be one of: ${TRACES_SAMPLERS.join(", ")}`,
    );
  }

  /** Plain decimals only (`0.1`, `1`): no sign, exponent or bare `.5`. */
  const ratioText = env.samplerArg?.trim() || "1";
  const samplerRatio = Number(ratioText);
  if (!/^\d+(\.\d+)?$/.test(ratioText) || samplerRatio > 1) {
    throw new Error(
      `[config] OTEL_TRACES_SAMPLER_ARG must be a number from 0 to 1, got "${env.samplerArg}"`,
    );
  }

  const wanted = exporter === "otlp" || endpoint !== "" || tracesEndpoint !== "";
  if (disabledRaw === "true" || exporter === "none" || !wanted) return { enabled: false };

  /** The spec's rules: the traces URL as given, else the base URL plus `v1/traces`. */
  const resolvedEndpoint =
    tracesEndpoint !== ""
      ? tracesEndpoint
      : endpoint !== ""
        ? `${endpoint.endsWith("/") ? endpoint : `${endpoint}/`}v1/traces`
        : DEFAULT_TRACES_ENDPOINT;

  return {
    enabled: true,
    endpoint: resolvedEndpoint,
    serviceName: serviceName === "" ? DEFAULT_TRACING_SERVICE_NAME : serviceName,
    sampler,
    samplerRatio,
  };
}
