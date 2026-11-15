import { describe, expect, test } from "bun:test";
import { svgTinyPsProblems } from "../../src/modules/domains/services/bimi-svg.ts";

/**
 * The SVG Tiny PS checks of a BIMI logo (#415). The logo comes from a URL
 * the domain's DNS chooses, so it is hostile input: parsed without a DTD
 * or entity expansion, and every broken rule reported.
 */

/** A logo that passes, with `root` extra root attributes and `body` inside. */
function svg({
  root = 'version="1.2" baseProfile="tiny-ps" viewBox="0 0 100 100"',
  body = '<title>Acme</title><circle cx="50" cy="50" r="40" fill="#c00"/>',
}: { root?: string; body?: string } = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${root}>${body}</svg>`;
}

describe("svgTinyPsProblems", () => {
  test("a valid SVG Tiny PS logo passes", () => {
    expect(svgTinyPsProblems(svg())).toEqual([]);
    /** Internal references are fine. */
    expect(
      svgTinyPsProblems(
        svg({
          body: '<title>Acme</title><defs><linearGradient id="g"/></defs><rect width="10" height="10" fill="url(#g)"/><use xlink:href="#g"/>',
        }),
      ),
    ).toEqual([]);
  });

  test("a <script> element fails", () => {
    expect(
      svgTinyPsProblems(
        svg({ body: "<title>Acme</title><g><script>alert(1)</script></g>" }),
      ),
    ).toEqual(["The logo contains a <script> element"]);
  });

  test("event handler attributes fail", () => {
    expect(
      svgTinyPsProblems(svg({ body: '<title>Acme</title><rect onclick="alert(1)"/>' })),
    ).toEqual(["The logo has an event handler attribute (onclick=)"]);
  });

  test("external references fail: xlink:href, href, CSS url() and @import", () => {
    const problems = svgTinyPsProblems(
      svg({
        body: '<title>Acme</title><use xlink:href="https://evil.example/x.svg#a"/><use href="http://evil.example/y"/><rect style="fill:url(https://evil.example/p)"/><style>@import "https://evil.example/s.css";</style>',
      }),
    );
    expect(problems).toContain(
      'The logo references an external resource (xlink:href="https://evil.example/x.svg#a")',
    );
    expect(problems).toContain(
      'The logo references an external resource (href="http://evil.example/y")',
    );
    expect(problems).toContain(
      "The style= attribute loads something from outside the document",
    );
    expect(problems).toContain(
      "A <style> element loads something from outside the document",
    );
  });

  test("forbidden elements: image, foreignObject, a link, animation", () => {
    const problems = svgTinyPsProblems(
      svg({
        body: '<title>Acme</title><image href="#x"/><foreignObject/><a href="#y"><rect/></a><animate/>',
      }),
    );
    expect(problems).toContain("The logo contains an embedded image (<image>)");
    expect(problems).toContain("The logo contains a <foreignObject> element");
    expect(problems).toContain("The logo contains a link (<a>)");
    expect(problems).toContain("The logo contains animation (<animate>)");
  });

  test("the wrong version or profile fails, each reported", () => {
    expect(
      svgTinyPsProblems(
        svg({ root: 'version="1.1" baseProfile="tiny" viewBox="0 0 1 1"' }),
      ),
    ).toEqual([
      'version="1.1": it must be version="1.2"',
      'baseProfile="tiny": it must be baseProfile="tiny-ps"',
    ]);
    expect(svgTinyPsProblems(svg({ root: 'viewBox="0 0 1 1"' }))).toEqual([
      'The root <svg> has no version: it must be version="1.2"',
      'The root <svg> has no baseProfile: it must be baseProfile="tiny-ps"',
    ]);
  });

  test("x= or y= on the root fails", () => {
    expect(
      svgTinyPsProblems(
        svg({
          root: 'version="1.2" baseProfile="tiny-ps" viewBox="0 0 1 1" x="0" y="0"',
        }),
      ),
    ).toEqual(["The root <svg> has an x= or y= attribute: remove it"]);
  });

  test("the viewBox must exist, be four numbers, and be square", () => {
    expect(
      svgTinyPsProblems(svg({ root: 'version="1.2" baseProfile="tiny-ps"' })),
    ).toEqual(["The root <svg> has no viewBox: add a square one"]);
    expect(
      svgTinyPsProblems(
        svg({ root: 'version="1.2" baseProfile="tiny-ps" viewBox="0 0 200 100"' }),
      ),
    ).toEqual([
      'viewBox="0 0 200 100" is not square (the logo must have a 1:1 aspect ratio)',
    ]);
    expect(
      svgTinyPsProblems(
        svg({ root: 'version="1.2" baseProfile="tiny-ps" viewBox="0 0 wide 0"' }),
      ),
    ).toEqual([
      'viewBox="0 0 wide 0" is not four numbers with a positive width and height',
    ]);
    /** Within 1% counts as square. */
    expect(
      svgTinyPsProblems(
        svg({ root: 'version="1.2" baseProfile="tiny-ps" viewBox="0,0,100.5,100"' }),
      ),
    ).toEqual([]);
  });

  test("a missing or empty <title> fails", () => {
    expect(svgTinyPsProblems(svg({ body: "<rect/>" }))).toEqual([
      "No <title> in the root <svg>: add one with the brand name",
    ]);
    expect(svgTinyPsProblems(svg({ body: "<title> </title><rect/>" }))).toEqual([
      "The <title> is empty: put the brand name in it",
    ]);
  });

  test("a DOCTYPE is refused before parsing (no entity expansion)", () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><svg version="1.2" baseProfile="tiny-ps" viewBox="0 0 1 1"><title>&b;</title></svg>`;
    expect(svgTinyPsProblems(laughs)).toEqual([
      "The logo has a <!DOCTYPE>: SVG Tiny PS allows none (the file was not parsed)",
    ]);
    expect(svgTinyPsProblems(laughs.replace("DOCTYPE", "doctype"))).toHaveLength(1);
  });

  test("not XML, or not an <svg> root, is one problem", () => {
    expect(svgTinyPsProblems("not xml at all")).toEqual([
      "The logo is not well-formed XML",
    ]);
    expect(svgTinyPsProblems("<svg><g></svg>")).toEqual([
      "The logo is not well-formed XML",
    ]);
    expect(svgTinyPsProblems("<html><title>x</title></html>")).toEqual([
      "The root element is not <svg>",
    ]);
    expect(svgTinyPsProblems("")).toEqual(["The logo is not well-formed XML"]);
  });

  test("nesting is walked without recursion, and refused past 100 levels", () => {
    const nested = (depth: number): string =>
      svg({
        body: `<title>Acme</title>${"<g>".repeat(depth)}<script/>${"</g>".repeat(depth)}`,
      });
    expect(svgTinyPsProblems(nested(90))).toEqual([
      "The logo contains a <script> element",
    ]);
    expect(svgTinyPsProblems(nested(3_000))).toEqual([
      "The logo could not be parsed: it is malformed or nested too deeply",
    ]);
  });
});
