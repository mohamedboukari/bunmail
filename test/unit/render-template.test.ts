import { describe, test, expect } from "bun:test";
import { renderTemplate } from "../../src/modules/templates/services/template.service.ts";

/**
 * Unit tests for renderTemplate.
 *
 * Tests Mustache-style variable substitution — a pure function
 * with no dependencies, so no mocking needed.
 */

describe("renderTemplate", () => {
  test("replaces a single variable {{name}} with value", () => {
    const result = renderTemplate("Hello {{name}}", { name: "Alice" });
    expect(result).toBe("Hello Alice");
  });

  test("replaces multiple different variables in one string", () => {
    const result = renderTemplate("Hi {{name}}, your code is {{code}}", {
      name: "Bob",
      code: "42",
    });
    expect(result).toBe("Hi Bob, your code is 42");
  });

  test("leaves unknown {{variable}} placeholders unchanged", () => {
    const result = renderTemplate("Hello {{name}}, your {{role}}", { name: "Alice" });
    expect(result).toBe("Hello Alice, your {{role}}");
  });

  test("returns the string unchanged when no variables match", () => {
    const result = renderTemplate("No placeholders here", { name: "Alice" });
    expect(result).toBe("No placeholders here");
  });

  test("handles empty template string", () => {
    const result = renderTemplate("", { name: "Alice" });
    expect(result).toBe("");
  });

  test("handles empty variables object", () => {
    const result = renderTemplate("Hello {{name}}", {});
    expect(result).toBe("Hello {{name}}");
  });

  test("does not replace partial patterns like {name} or {{name}", () => {
    const result = renderTemplate("{name} and {​{name} are not valid", { name: "Alice" });
    expect(result).not.toContain("Alice");
  });

  test("handles variables with special regex characters in values", () => {
    const result = renderTemplate("Price: {{price}}", { price: "$100.00 (USD)" });
    expect(result).toBe("Price: $100.00 (USD)");
  });
});
