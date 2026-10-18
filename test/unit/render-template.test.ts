import { describe, test, expect } from "bun:test";
import {
  MAX_RENDERED_BODY_LENGTH,
  renderTemplate,
} from "../../src/modules/templates/services/template.service.ts";
import { TemplateTooLargeError } from "../../src/modules/templates/errors.ts";

/**
 * Unit tests for renderTemplate.
 *
 * Tests Mustache-style variable substitution: a pure function
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

describe("renderTemplate: bounded output", () => {
  test("stops an amplifying template before building the huge string", () => {
    /** 1M placeholders x 1 KB values would be about 1 GB of output. */
    const template = "{{a}}".repeat(1_000_000);
    const start = performance.now();
    expect(() => renderTemplate(template, { a: "x".repeat(1024) })).toThrow(
      TemplateTooLargeError,
    );
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  test("allows output exactly at the limit", () => {
    const value = "x".repeat(MAX_RENDERED_BODY_LENGTH);
    expect(renderTemplate("{{a}}", { a: value })).toHaveLength(MAX_RENDERED_BODY_LENGTH);
    expect(() => renderTemplate("{{a}}!", { a: value })).toThrow(TemplateTooLargeError);
  });

  test("applies a custom limit (used for subjects)", () => {
    expect(() => renderTemplate("Hi {{name}}", { name: "x".repeat(500) }, 500)).toThrow(
      TemplateTooLargeError,
    );
    expect(renderTemplate("Hi {{name}}", { name: "Ann" }, 500)).toBe("Hi Ann");
  });

  test("ignores inherited property names", () => {
    expect(renderTemplate("{{constructor}} {{toString}}", {})).toBe(
      "{{constructor}} {{toString}}",
    );
  });
});

describe("renderTemplate: HTML escaping (#250)", () => {
  const vars = {
    name: `<b>Bob</b> & "co" 'x'`,
    link: '<a href="https://example.com">x</a>',
  };

  test("{{var}} is HTML-escaped in an HTML body", () => {
    expect(renderTemplate("<p>Hi {{name}}</p>", vars, undefined, { html: true })).toBe(
      "<p>Hi &lt;b&gt;Bob&lt;/b&gt; &amp; &quot;co&quot; &#39;x&#39;</p>",
    );
  });

  test("{{{var}}} inserts the value as is in an HTML body", () => {
    expect(renderTemplate("<p>{{{link}}}</p>", vars, undefined, { html: true })).toBe(
      '<p><a href="https://example.com">x</a></p>',
    );
  });

  test("subjects and text bodies are not HTML: both forms insert as is", () => {
    expect(renderTemplate("Hi {{name}}", vars)).toBe(`Hi <b>Bob</b> & "co" 'x'`);
    expect(renderTemplate("Hi {{{name}}}", vars)).toBe(`Hi <b>Bob</b> & "co" 'x'`);
  });

  test("unknown placeholders stay as written in both forms", () => {
    expect(
      renderTemplate("{{missing}} {{{missing}}}", vars, undefined, { html: true }),
    ).toBe("{{missing}} {{{missing}}}");
  });

  test("the size cap counts the escaped length", () => {
    expect(() =>
      renderTemplate("{{v}}", { v: "<".repeat(10) }, 30, { html: true }),
    ).toThrow();
    expect(renderTemplate("{{v}}", { v: "<".repeat(5) }, 30, { html: true })).toBe(
      "&lt;".repeat(5),
    );
  });
});
