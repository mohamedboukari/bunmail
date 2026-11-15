/**
 * Reads a required environment variable. Throws at startup if missing
 * so misconfigurations are caught immediately rather than at runtime.
 */
export function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `[config] Missing required environment variable: ${key}\n` +
        `  → Copy .env.example to .env and fill in the values.`,
    );
  }
  return value;
}

/**
 * Reads an optional environment variable, falling back to the provided default.
 */
export function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/**
 * Reads an optional positive-integer environment variable. Fails at boot
 * on anything else: a bare `parseInt` turns a typo into `NaN`, and a
 * `count > NaN` check is always false, which would silently disable a
 * limit instead of reporting the mistake.
 */
export function optionalPositiveInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`[config] ${key} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * Reads an optional whole number that must lie in `[min, max]` (#176).
 * Unset or blank gives `fallback`; anything else (signs, decimals,
 * exponents, hex, out of range) refuses to boot. Exported for tests.
 */
export function optionalBoundedInt(
  key: string,
  fallback: number,
  min: number,
  max: number,
  raw: string | undefined = process.env[key],
): number {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return fallback;
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || value < min || value > max) {
    throw new Error(
      `[config] ${key} must be a whole number from ${min} to ${max}, got "${raw}"`,
    );
  }
  return value;
}

/**
 * Reads an optional boolean flag strictly: `true` or `false`, unset or
 * blank gives `fallback`. Anything else (`1`, `yes`, `TRUE`) refuses to
 * boot, so a typo cannot silently leave a guard off. Exported for tests.
 */
export function optionalStrictBoolean(
  key: string,
  fallback: boolean,
  raw: string | undefined = process.env[key],
): boolean {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return fallback;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  throw new Error(`[config] ${key} must be "true" or "false", got "${raw}"`);
}

/**
 * The first Bun release verified to upgrade an accepted socket to TLS on
 * the server side (STARTTLS) and to bind an outgoing socket to a chosen
 * local address (`localAddress`) (#414). Bun 1.3.14 does neither: the
 * server-side `new tls.TLSSocket(socket, { isServer: true })` never
 * handshakes and `localAddress` is ignored. Both were fixed upstream by
 * oven-sh/bun#31155, first released in 1.4.0; 1.4.4 is the release
 * BunMail verified them on.
 */
export const SOCKET_FEATURES_MIN_BUN = "1.4.4";

/** The running Bun version, or `null` under another runtime (Node). */
export function runningBunVersion(): string | null {
  return typeof Bun === "undefined" ? null : Bun.version;
}

/**
 * Whether the runtime can run server-side STARTTLS and bind a source
 * address (#414): any Node, or Bun from {@link SOCKET_FEATURES_MIN_BUN}.
 * Compares the numeric `major.minor.patch` only, so a canary or a
 * pre-release of a later version counts as that version. Exported for
 * tests, which pass a version.
 */
export function runtimeHasSocketFeatures(
  bunVersion: string | null = runningBunVersion(),
): boolean {
  if (bunVersion === null) return true;
  const version = /^(\d+)\.(\d+)\.(\d+)/.exec(bunVersion);
  const minimum = /^(\d+)\.(\d+)\.(\d+)/.exec(SOCKET_FEATURES_MIN_BUN);
  if (version === null || minimum === null) return false;
  for (let part = 1; part <= 3; part++) {
    const have = Number(version[part]);
    const need = Number(minimum[part]);
    if (have !== need) return have > need;
  }
  return true;
}

/**
 * The boot error for a setting that needs {@link runtimeHasSocketFeatures}
 * on an older Bun (#414): names the setting, what Bun cannot do, the
 * version running and the one needed.
 */
export function socketFeatureError(
  setting: string,
  why: string,
  bunVersion: string,
): Error {
  return new Error(
    `[config] ${setting} needs Bun ${SOCKET_FEATURES_MIN_BUN} or later, running ${bunVersion}:\n` +
      `  ${why}\n` +
      `  → Upgrade Bun (the Docker image pins it), or unset ${setting}.`,
  );
}
