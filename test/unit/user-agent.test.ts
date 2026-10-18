import { describe, test, expect } from "bun:test";
import {
  UNKNOWN_BROWSER,
  describeUserAgent,
} from "../../src/modules/users/services/user-agent.service.ts";

/**
 * The device label of the Active sessions page (#281): browser and
 * system from the stored user agent, fixed strings only.
 */

const CASES: ReadonlyArray<readonly [string, string]> = [
  /* Chrome */
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "Chrome on Windows",
  ],
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "Chrome on macOS",
  ],
  [
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "Chrome on Linux",
  ],
  [
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
    "Chrome on Android",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1",
    "Chrome on iOS",
  ],
  [
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "Chrome on ChromeOS",
  ],
  /* Edge */
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
    "Edge on Windows",
  ],
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
    "Edge on macOS",
  ],
  [
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0",
    "Edge on Android",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/141.0.0.0 Mobile/15E148 Safari/605.1.15",
    "Edge on iOS",
  ],
  /* Firefox */
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
    "Firefox on Windows",
  ],
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0",
    "Firefox on macOS",
  ],
  [
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
    "Firefox on Linux",
  ],
  [
    "Mozilla/5.0 (Android 14; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0",
    "Firefox on Android",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15",
    "Firefox on iOS",
  ],
  /* Safari */
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    "Safari on macOS",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    "Safari on iOS",
  ],
  [
    "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    "Safari on iOS",
  ],
  /* Opera */
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/125.0.0.0",
    "Opera on Windows",
  ],
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/125.0.0.0",
    "Opera on macOS",
  ],
  [
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/125.0.0.0",
    "Opera on Linux",
  ],
  [
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 OPR/90.0.0.0",
    "Opera on Android",
  ],
  /* Samsung Internet */
  [
    "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
    "Samsung Internet on Android",
  ],
  /* Command-line clients */
  ["curl/8.7.1", "curl"],
  ["Wget/1.24.5", "Wget"],
  /* Unknown */
  ["SomeBot/1.0", UNKNOWN_BROWSER],
  ["Mozilla/5.0 (X11; Linux x86_64) SomeEngine/1.0", "Unknown browser on Linux"],
];

describe("describeUserAgent", () => {
  test.each(CASES)("%p -> %p", (userAgent, label) => {
    expect(describeUserAgent(userAgent)).toBe(label);
  });

  test("no user agent: Unknown browser", () => {
    expect(describeUserAgent(null)).toBe(UNKNOWN_BROWSER);
    expect(describeUserAgent(undefined)).toBe(UNKNOWN_BROWSER);
    expect(describeUserAgent("")).toBe(UNKNOWN_BROWSER);
    expect(describeUserAgent("   ")).toBe(UNKNOWN_BROWSER);
  });

  test("the label never carries text from the header", () => {
    const label = describeUserAgent('<script>alert(1)</script> Firefox/1 "Windows"');
    expect(label).toBe("Firefox on Windows");
  });
});
