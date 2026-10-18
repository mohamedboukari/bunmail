import { describe, test, expect } from "bun:test";
import {
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  DEVICE_RETENTION_DAYS,
  KNOWN_DEVICE_DAYS,
  classifySignInDevice,
  type DeviceUpsertFacts,
  type SignInDeviceKind,
} from "../../src/modules/users/services/device-policy.service.ts";

/**
 * The rules of the new-device sign-in alert (#282): which sign-ins alert,
 * and the windows. Pure, no mocks.
 */

/** Facts with everything false, overridden per case. */
function facts(overrides: Partial<DeviceUpsertFacts>): DeviceUpsertFacts {
  return { inserted: false, hadDevices: false, known: false, stale: false, ...overrides };
}

describe("classifySignInDevice", () => {
  test.each<[string, Partial<DeviceUpsertFacts>, SignInDeviceKind]>([
    ["the account's very first device: recorded, no alert", { inserted: true }, "first"],
    [
      "a browser new to an account that has devices: alert",
      { inserted: true, hadDevices: true },
      "new",
    ],
    ["seen within the window: known", { hadDevices: true, known: true }, "known"],
    [
      "seen, but longer ago than the window: alert again",
      { hadDevices: true, stale: true },
      "new",
    ],
    [
      "updated a row the snapshot did not have (a racing sign-in inserted it): no second alert",
      { hadDevices: false },
      "known",
    ],
  ])("%s", (_name, overrides, expected) => {
    expect(classifySignInDevice(facts(overrides))).toBe(expected);
  });
});

describe("windows", () => {
  test("30 days to stay known, 400 days of retention, the cookie lives as long", () => {
    expect(KNOWN_DEVICE_DAYS).toBe(30);
    expect(DEVICE_RETENTION_DAYS).toBe(400);
    expect(DEVICE_COOKIE_MAX_AGE_SECONDS).toBe(400 * 24 * 60 * 60);
    expect(DEVICE_RETENTION_DAYS).toBeGreaterThan(KNOWN_DEVICE_DAYS);
  });
});
