import { describe, test, expect } from "bun:test";
import { generateId } from "../../src/utils/id.ts";

/**
 * Unit tests for the ID generator.
 *
 * Verifies prefixed IDs have the correct format: <prefix>_<24 hex chars>.
 */

describe("generateId", () => {
  test("generates msg-prefixed IDs", () => {
    const id = generateId("msg");
    expect(id.startsWith("msg_")).toBe(true);
  });

  test("generates key-prefixed IDs", () => {
    const id = generateId("key");
    expect(id.startsWith("key_")).toBe(true);
  });

  test("generates dom-prefixed IDs", () => {
    const id = generateId("dom");
    expect(id.startsWith("dom_")).toBe(true);
  });

  test("ID has correct length (prefix + underscore + 24 hex chars)", () => {
    const id = generateId("msg");
    /** "msg_" = 4 chars + 24 hex chars = 28 total */
    expect(id).toHaveLength(28);
  });

  test("hex portion contains only valid hex characters", () => {
    const id = generateId("dom");
    const hex = id.split("_")[1]!;
    expect(hex).toMatch(/^[a-f0-9]{24}$/);
  });

  test("generates unique IDs on each call", () => {
    const id1 = generateId("msg");
    const id2 = generateId("msg");
    expect(id1).not.toBe(id2);
  });
});
