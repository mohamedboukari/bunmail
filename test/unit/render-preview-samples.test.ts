import { describe, test, expect } from "bun:test";
import { renderPreviewSamples } from "../../src/pages/components/html-preview.tsx";

/**
 * Unit tests for renderPreviewSamples() — the sample-value substitution that
 * powers the dashboard template HTML preview. It must match the `{{\w+}}`
 * matcher of renderTemplate() (same placeholder grammar) but always fill
 * matched placeholders with a sample value.
 */
describe("renderPreviewSamples", () => {
  test("substitutes a known variable with its curated sample", () => {
    expect(renderPreviewSamples("<p>Hello {{name}}</p>")).toBe("<p>Hello Alex Doe</p>");
  });

  test("falls back to the variable name for unknown variables", () => {
    expect(renderPreviewSamples("<p>{{somethingCustom}}</p>")).toBe(
      "<p>somethingCustom</p>",
    );
  });

  test("substitutes multiple distinct placeholders in one pass", () => {
    expect(renderPreviewSamples("Hi {{firstName}} at {{company}} — {{link}}")).toBe(
      "Hi Alex at Acme Inc — https://example.com",
    );
  });

  test("leaves spaced/invalid placeholders untouched (matches renderTemplate grammar)", () => {
    expect(renderPreviewSamples("{{ name }} and {{na-me}}")).toBe(
      "{{ name }} and {{na-me}}",
    );
  });

  test("returns the input unchanged when there are no placeholders", () => {
    expect(renderPreviewSamples("<p>no vars here</p>")).toBe("<p>no vars here</p>");
  });

  test("handles an empty string", () => {
    expect(renderPreviewSamples("")).toBe("");
  });
});
