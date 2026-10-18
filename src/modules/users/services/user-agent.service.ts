/**
 * Turns a stored `User-Agent` into the short device label of the Active
 * sessions page (#281): "Chrome on macOS", "Firefox on Windows", "curl".
 *
 * A small built-in parser, no dependency: it only needs to tell the
 * common browsers and systems apart, so a user recognizes their own
 * devices. A user agent is whatever the client sent, so the label is
 * built from fixed strings only; nothing from the header reaches the
 * page through it.
 *
 * Pure: no I/O, no config, so it unit-tests without mocks.
 */

/** The label when nothing is recognized (or there is no user agent). */
export const UNKNOWN_BROWSER = "Unknown browser";

/**
 * Browser tokens, checked in order: the first match wins. Order matters
 * because user agents carry each other's names for compatibility: Edge
 * and Opera say `Chrome/`, Chrome says `Safari/`, and so on.
 */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b|\bOPiOS\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChromium\//, "Chromium"],
  [/\bChrome\/|\bCriOS\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
  [/^curl\//i, "curl"],
  [/^Wget\//i, "Wget"],
];

/**
 * Operating systems, checked in order. iOS before macOS (an iPad says
 * "like Mac OS X"), Android and ChromeOS before Linux (both say Linux).
 */
const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b|\bX11\b/, "Linux"],
];

/** The label of the first pattern that matches, or `null`. */
function firstMatch(
  userAgent: string,
  table: ReadonlyArray<readonly [RegExp, string]>,
): string | null {
  for (const [pattern, label] of table) {
    if (pattern.test(userAgent)) return label;
  }
  return null;
}

/**
 * The device label for a session: "<browser> on <system>", the browser
 * alone when the system is unknown ("curl"), and "Unknown browser" (on
 * the system, when that is known) when the browser is not recognized or
 * there is no user agent.
 */
export function describeUserAgent(userAgent: string | null | undefined): string {
  const ua = userAgent?.trim() ?? "";
  if (ua === "") return UNKNOWN_BROWSER;
  const browser = firstMatch(ua, BROWSERS) ?? UNKNOWN_BROWSER;
  const system = firstMatch(ua, SYSTEMS);
  return system ? `${browser} on ${system}` : browser;
}
