import { describe, test, expect } from "bun:test";
import { serializeTemplate } from "../../src/modules/templates/serializations/template.serialization.ts";

/**
 * Unit tests for template serialization.
 *
 * Verifies that internal fields (apiKeyId) are stripped
 * and field names are mapped to consumer-friendly format.
 */

describe("serializeTemplate", () => {
  const template = {
    id: "tpl_abc123",
    apiKeyId: "key_secret123",
    name: "Welcome Email",
    subject: "Welcome, {{name}}!",
    html: "<h1>Hello {{name}}</h1>",
    textContent: "Hello {{name}}",
    variables: ["name", "company"],
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-06-01"),
  };

  test("maps textContent to text", () => {
    const result = serializeTemplate(template);
    expect(result.text).toBe("Hello {{name}}");
  });

  test("strips apiKeyId from output", () => {
    const result = serializeTemplate(template);
    expect("apiKeyId" in result).toBe(false);
  });

  test("includes all expected public fields", () => {
    const result = serializeTemplate(template);
    expect(result.id).toBe("tpl_abc123");
    expect(result.name).toBe("Welcome Email");
    expect(result.subject).toBe("Welcome, {{name}}!");
    expect(result.html).toBe("<h1>Hello {{name}}</h1>");
    expect(result.createdAt).toEqual(new Date("2024-01-01"));
    expect(result.updatedAt).toEqual(new Date("2024-06-01"));
  });

  test("handles null html and textContent", () => {
    const result = serializeTemplate({ ...template, html: null, textContent: null });
    expect(result.html).toBeNull();
    expect(result.text).toBeNull();
  });

  test("preserves variables array", () => {
    const result = serializeTemplate(template);
    expect(result.variables).toEqual(["name", "company"]);
  });
});
