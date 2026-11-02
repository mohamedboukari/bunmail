import { describe, expect, test } from "bun:test";
import { readRedisUrl } from "../../src/config.ts";

/**
 * `REDIS_URL` (#185) is read strictly: unset or blank keeps the shared
 * state in memory; anything else must be a redis:// or rediss:// URL with
 * a host, or the server refuses to boot. The error never repeats the URL,
 * which can carry a password.
 */
describe("readRedisUrl", () => {
  test("unset or blank: in memory", () => {
    expect(readRedisUrl(undefined)).toBeNull();
    expect(readRedisUrl("")).toBeNull();
    expect(readRedisUrl("   ")).toBeNull();
  });

  test.each([
    "redis://redis:6379",
    "redis://localhost",
    "redis://:secret@redis:6379/0",
    "redis://user:secret@10.0.0.5:6379/15",
    "rediss://default:secret@cache.example.com:6380",
    " redis://redis:6379 ",
  ])("accepts %p", (raw) => {
    expect(readRedisUrl(raw)).toBe(raw.trim());
  });

  test.each([
    "localhost:6379",
    "http://redis:6379",
    "valkey://redis:6379",
    "redis+unix:///tmp/redis.sock",
    "redis://",
    "redis://redis:6379/abc",
    "redis://redis:6379/0?ssl=true",
    "redis://redis:6379/#x",
    "not a url",
  ])("refuses %p", (raw) => {
    expect(() => readRedisUrl(raw)).toThrow(
      /REDIS_URL must be a redis:\/\/ or rediss:\/\//,
    );
  });

  test("the error never repeats the URL or its password", () => {
    let message = "";
    try {
      readRedisUrl("http://:hunter2-pass@redis:6379");
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("REDIS_URL");
    expect(message).not.toContain("hunter2-pass");
  });
});
