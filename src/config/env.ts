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
