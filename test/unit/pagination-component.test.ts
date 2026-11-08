import { describe, test, expect } from "bun:test";
import { Pagination, pageWindow } from "../../src/pages/components/pagination.tsx";

/**
 * The shared dashboard pagination (#429): the "Showing X to Y of Z"
 * summary, the numbered page window, the rows-per-page form and the
 * query params every link and the form carry.
 */

/** Renders the component to its HTML string. */
async function render(props: Parameters<typeof Pagination>[0]): Promise<string> {
  return await Pagination(props);
}

/** The text of the summary paragraph, tags stripped. */
function summaryOf(html: string): string {
  const match = /<p[^>]*>(.*?)<\/p>/.exec(html);
  return (match?.[1] ?? "").replace(/<[^>]+>/g, "");
}

/** Every `href` in the markup, entities decoded the way a browser would. */
function hrefsOf(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) =>
    (m[1] ?? "").replace(/&amp;/g, "&"),
  );
}

/** The visible page-number links, in order, with ellipses as "...". */
function slotsOf(html: string): string[] {
  return [...html.matchAll(/aria-label="Page (\d+)"|aria-hidden="true">…</g)].map(
    (m) => m[1] ?? "...",
  );
}

describe("pageWindow (#429)", () => {
  test("small totals list every page, no ellipsis", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 2)).toEqual([1, 2]);
    expect(pageWindow(2, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  test("at the start: the first pages, then a gap to the last", () => {
    expect(pageWindow(1, 14)).toEqual([1, 2, "ellipsis", 14]);
    expect(pageWindow(2, 14)).toEqual([1, 2, 3, "ellipsis", 14]);
  });

  test("in the middle: first, current +/- 1, last, with a gap on each side", () => {
    expect(pageWindow(5, 14)).toEqual([1, "ellipsis", 4, 5, 6, "ellipsis", 14]);
  });

  test("at the end: the first, a gap, then the last pages", () => {
    expect(pageWindow(14, 14)).toEqual([1, "ellipsis", 13, 14]);
    expect(pageWindow(13, 14)).toEqual([1, "ellipsis", 12, 13, 14]);
  });

  test("a gap of one page shows the page instead of an ellipsis", () => {
    /** 1 _ 3 4 5: the 2 is shown, not "1 ... 3". */
    expect(pageWindow(4, 14)).toEqual([1, 2, 3, 4, 5, "ellipsis", 14]);
    expect(pageWindow(11, 14)).toEqual([1, "ellipsis", 10, 11, 12, 13, 14]);
  });
});

describe("Pagination component (#429)", () => {
  test("summarises the visible range", async () => {
    const html = await render({ page: 2, limit: 25, total: 340, baseUrl: "/x" });
    expect(summaryOf(html)).toBe("Showing 26 to 50 of 340");
  });

  test("the last page ends the range at the total", async () => {
    const html = await render({ page: 14, limit: 25, total: 340, baseUrl: "/x" });
    expect(summaryOf(html)).toBe("Showing 326 to 340 of 340");
  });

  test("0 results says so and disables both arrows", async () => {
    const html = await render({ page: 1, limit: 25, total: 0, baseUrl: "/x" });
    expect(summaryOf(html)).toBe("No results");
    expect(html).not.toContain("Showing");
    expect(html).toContain('aria-label="Previous page" aria-disabled="true"');
    expect(html).toContain('aria-label="Next page" aria-disabled="true"');
    expect(slotsOf(html)).toEqual(["1"]);
  });

  test("a page past the end shows no range and links back to the last page", async () => {
    const html = await render({ page: 99, limit: 25, total: 340, baseUrl: "/x" });
    expect(summaryOf(html)).toBe("No rows on this page (340 in total)");
    expect(html).not.toContain('aria-current="page"');
    expect(html).toContain('href="/x?page=14&limit=25" class="');
    expect(html).toContain('aria-label="Next page" aria-disabled="true"');
  });

  test("renders the numbered window with ellipses and marks the current page", async () => {
    const html = await render({ page: 5, limit: 25, total: 340, baseUrl: "/x" });
    expect(slotsOf(html)).toEqual(["1", "...", "4", "5", "6", "...", "14"]);
    /** Exactly one current page, and it is page 5. */
    expect(html.match(/aria-current="page"/g)?.length).toBe(1);
    expect(html).toMatch(/aria-current="page" aria-label="Page 5"/);
  });

  test("first page: previous is disabled, next links to page 2", async () => {
    const html = await render({ page: 1, limit: 25, total: 340, baseUrl: "/x" });
    expect(html).toContain('aria-label="Previous page" aria-disabled="true"');
    expect(html).not.toMatch(/<a [^>]*aria-label="Previous page"/);
    expect(html).toMatch(/<a href="\/x\?page=2&limit=25"[^>]*aria-label="Next page"/);
  });

  test("last page: next is disabled, previous links back one page", async () => {
    const html = await render({ page: 14, limit: 25, total: 340, baseUrl: "/x" });
    expect(html).toContain('aria-label="Next page" aria-disabled="true"');
    expect(html).not.toMatch(/<a [^>]*aria-label="Next page"/);
    expect(html).toMatch(
      /<a href="\/x\?page=13&limit=25"[^>]*aria-label="Previous page"/,
    );
  });

  test("selects the current size among 25, 50 and 100", async () => {
    const html = await render({ page: 1, limit: 50, total: 340, baseUrl: "/x" });
    expect(html).toContain('<option value="25">25</option>');
    expect(html).toContain('<option value="50" selected>50</option>');
    expect(html).toContain('<option value="100">100</option>');
    expect(html.match(/ selected/g)?.length).toBe(1);
  });

  test("the size select auto-submits a GET form back to the list, with a noscript Apply", async () => {
    const html = await render({
      page: 3,
      limit: 25,
      total: 340,
      baseUrl: "/dashboard/emails",
    });
    expect(html).toContain('<form method="get" action="/dashboard/emails"');
    expect(html).toMatch(/<select name="limit" data-autosubmit/);
    expect(html).toMatch(
      /<noscript><button type="submit"[^>]*>Apply<\/button><\/noscript>/,
    );
    /** No `page` input, so a new size starts again on page 1; no inline handler. */
    expect(html).not.toContain('name="page"');
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  test("keeps the page's filters on every link and as hidden inputs", async () => {
    const html = await render({
      page: 2,
      limit: 50,
      total: 340,
      baseUrl: "/dashboard/emails",
      extraParams: "status=sent&tag=env%3Aprod&page=9&limit=10",
    });
    const links = hrefsOf(html);
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) {
      const url = new URL(href, "http://localhost");
      expect(url.pathname).toBe("/dashboard/emails");
      expect(url.searchParams.get("status")).toBe("sent");
      expect(url.searchParams.get("tag")).toBe("env:prod");
      /** The component's own page and size win over any in extraParams. */
      expect(url.searchParams.getAll("limit")).toEqual(["50"]);
      expect(url.searchParams.getAll("page")).toHaveLength(1);
    }
    expect(html).toContain('<input type="hidden" name="status" value="sent"/>');
    expect(html).toContain('<input type="hidden" name="tag" value="env:prod"/>');
    expect(html).not.toContain('type="hidden" name="page"');
    expect(html).not.toContain('type="hidden" name="limit"');
  });

  test("escapes a hostile param value in links and hidden inputs", async () => {
    const hostile = '"><script>alert(1)</script>';
    const html = await render({
      page: 1,
      limit: 25,
      total: 100,
      baseUrl: "/dashboard/emails",
      extraParams: new URLSearchParams({ tag: hostile }).toString(),
    });
    /** The value never closes its attribute: no raw quote follows `value=`. */
    expect(html).not.toContain(`value="${hostile}"`);
    expect(html).not.toContain('"><script>');
    expect(html).toContain('value="&#34;><script>alert(1)</script>"');
    /** Links carry it percent-encoded. */
    expect(html).toContain("tag=%22%3E%3Cscript%3Ealert%281%29%3C%2Fscript%3E");
  });
});
