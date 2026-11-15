import { describe, test, expect } from "bun:test";
import { KeptLimitInput } from "../../src/pages/components/pagination.tsx";
import { keptLimit, withKeptLimit } from "../../src/pages/pagination.ts";
import { AuditLogPage, AUDIT_LOG_PAGE_SIZE } from "../../src/pages/routes/audit-log.tsx";
import { DmarcReportsPage } from "../../src/pages/routes/dmarc-reports.tsx";
import { EmailTombstonesPage } from "../../src/pages/routes/email-tombstones.tsx";
import { EmailsPage } from "../../src/pages/routes/emails.tsx";
import { SuppressionsPage } from "../../src/pages/routes/suppressions.tsx";
import { WebhookDeliveriesPage } from "../../src/pages/routes/webhook-deliveries.tsx";

/**
 * Filter controls keep the rows-per-page size (#435).
 *
 * Since #429 a list offers 25, 50 or 100 rows. The pages' own filter
 * controls (status tabs, dropdowns, search forms, Clear links) used to drop
 * `limit`, so a filter change went back to the default size. Each list page
 * is rendered here with a non-default size and with its default, and every
 * filter link and form is checked: `limit` is carried only when it is not
 * the default, `page` is never carried (a filter change starts on page 1),
 * and the filter values around it stay escaped.
 */

/** A value that breaks out of an attribute or opens a tag if left unescaped. */
const XSS = `"><img src=x onerror="alert(1)">`;

/**
 * The page's own markup, inside `<main>`: the sidebar links to every list
 * page and carries no filters, so it is left out.
 */
function mainOf(html: string): string {
  return /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? "";
}

/** Every `href` in the page's main markup, entities decoded the way a browser would. */
function hrefsOf(html: string): string[] {
  return [...mainOf(html).matchAll(/href="([^"]*)"/g)].map((m) =>
    (m[1] ?? "").replace(/&amp;/g, "&"),
  );
}

/** Every `<option value>` in the markup, entities decoded. */
function optionValuesOf(html: string): string[] {
  return [...html.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) =>
    (m[1] ?? "").replace(/&amp;/g, "&"),
  );
}

/** The links among `hrefs` that point at `path` (with or without a query). */
function linksTo(hrefs: string[], path: string): string[] {
  return hrefs.filter((href) => href === path || href.startsWith(`${path}?`));
}

/** The `limit` and `page` a link carries, read the way the server reads them. */
function paramsOf(href: string): { limit: string | null; page: string | null } {
  const params = new URL(href, "http://localhost").searchParams;
  return { limit: params.get("limit"), page: params.get("page") };
}

/**
 * The markup of the form that holds a field named `field`, so a filter form
 * is told apart from the pagination size form on the same page.
 */
function formWith(html: string, field: string): string {
  const form = [...html.matchAll(/<form[\s\S]*?<\/form>/g)]
    .map((m) => m[0])
    .find((markup) => markup.includes(`name="${field}"`));
  if (form === undefined) throw new Error(`no form with a "${field}" field`);
  return form;
}

/** The hidden `limit` input as the filter forms render it. */
function hiddenLimit(value: string): string {
  return `<input type="hidden" name="limit" value="${value}"`;
}

/** Asserts every link carries `limit` (or none) and never a `page`. */
function expectLinks(links: string[], limit: string | null): void {
  expect(links.length).toBeGreaterThan(0);
  for (const href of links) {
    expect(paramsOf(href)).toEqual({ limit, page: null });
  }
}

describe("keptLimit and withKeptLimit (#435)", () => {
  test("carries a size that is not the page's default", () => {
    expect(keptLimit(50)).toBe("50");
    expect(keptLimit(100)).toBe("100");
    expect(keptLimit(25, AUDIT_LOG_PAGE_SIZE)).toBe("25");
  });

  test("carries nothing at the default", () => {
    expect(keptLimit(25)).toBeUndefined();
    expect(keptLimit(50, AUDIT_LOG_PAGE_SIZE)).toBeUndefined();
  });

  test("never carries a size outside 25, 50 and 100", () => {
    expect(keptLimit(20)).toBeUndefined();
    expect(keptLimit(1000)).toBeUndefined();
    expect(keptLimit(Number.NaN)).toBeUndefined();
  });

  test("appends with ? or & and leaves the default link unchanged", () => {
    expect(withKeptLimit("/dashboard/x", 50)).toBe("/dashboard/x?limit=50");
    expect(withKeptLimit("/dashboard/x?a=1", 100)).toBe("/dashboard/x?a=1&limit=100");
    expect(withKeptLimit("/dashboard/x?a=1", 25)).toBe("/dashboard/x?a=1");
  });

  test("KeptLimitInput renders a hidden input, or nothing at the default", async () => {
    expect(await KeptLimitInput({ limit: 50 })).toBe(
      '<input type="hidden" name="limit" value="50"/>',
    );
    expect(await KeptLimitInput({ limit: 25 })).toBe("");
    expect(await KeptLimitInput({ limit: 50, defaultLimit: AUDIT_LOG_PAGE_SIZE })).toBe(
      "",
    );
  });
});

describe("Emails page filters keep the size (#435)", () => {
  /** Renders the emails page with every filter set and the given size. */
  async function render(limit: number): Promise<string> {
    return await EmailsPage({
      emails: [],
      total: 0,
      page: 3,
      limit,
      status: "sent",
      source: "api",
      apiKeyId: "key_1",
      tag: XSS,
      apiKeys: [{ id: "key_1", name: "Main", keyPrefix: "bm_live_ab" }],
    });
  }

  test("status tabs, Source and API-key options carry limit=50", async () => {
    const html = await render(50);
    const tabs = linksTo(hrefsOf(html), "/dashboard/emails");
    const options = linksTo(optionValuesOf(html), "/dashboard/emails");
    expect(tabs.length).toBe(6);
    expect(options.length).toBe(5);
    expectLinks([...tabs, ...options], "50");
  });

  test("the tag form carries a hidden limit and no page", async () => {
    const form = formWith(await render(100), "tag");
    expect(form).toContain(hiddenLimit("100"));
    expect(form).not.toContain('name="page"');
  });

  test("at the default size nothing carries limit", async () => {
    const html = await render(25);
    expectLinks(
      [
        ...linksTo(hrefsOf(html), "/dashboard/emails"),
        ...linksTo(optionValuesOf(html), "/dashboard/emails"),
      ],
      null,
    );
    expect(formWith(html, "tag")).not.toContain('name="limit"');
  });

  test("the tag value stays escaped next to the limit", async () => {
    const html = await render(50);
    expect(html).not.toContain(XSS);
    const tab = linksTo(hrefsOf(html), "/dashboard/emails")[0] ?? "";
    expect(new URL(tab, "http://localhost").searchParams.get("tag")).toBe(XSS);
  });
});

describe("Suppressions page filters keep the size (#435)", () => {
  /** Renders the suppressions page with an email filter and the given size. */
  async function render(limit: number): Promise<string> {
    return await SuppressionsPage({
      suppressions: [],
      total: 0,
      page: 2,
      limit,
      filters: { email: XSS },
      apiKeys: [],
      apiKeyLabels: {},
    });
  }

  test("the filter form and Clear carry limit=50", async () => {
    const html = await render(50);
    const form = formWith(html, "email");
    expect(form).toContain(hiddenLimit("50"));
    expect(form).not.toContain('name="page"');
    expectLinks(linksTo(hrefsOf(html), "/dashboard/suppressions"), "50");
  });

  test("at the default size nothing carries limit", async () => {
    const html = await render(25);
    expect(formWith(html, "email")).not.toContain('name="limit"');
    expectLinks(linksTo(hrefsOf(html), "/dashboard/suppressions"), null);
  });

  test("the email filter stays escaped", async () => {
    expect(await render(50)).not.toContain(XSS);
  });
});

describe("Audit log filters keep the size (#435)", () => {
  /** Renders the audit log with an action filter and the given size. */
  async function render(limit: number): Promise<string> {
    return await AuditLogPage({
      events: [],
      total: 0,
      page: 2,
      limit,
      filters: { action: "auth.login", actor: XSS },
      actors: [],
    });
  }

  test("the filter form and Clear carry limit=25, which is not the default here", async () => {
    const html = await render(25);
    const form = formWith(html, "action");
    expect(form).toContain(hiddenLimit("25"));
    expect(form).not.toContain('name="page"');
    expectLinks(linksTo(hrefsOf(html), "/dashboard/audit-log"), "25");
  });

  test("the filter form and Clear carry limit=100", async () => {
    const html = await render(100);
    expect(formWith(html, "action")).toContain(hiddenLimit("100"));
    expectLinks(linksTo(hrefsOf(html), "/dashboard/audit-log"), "100");
  });

  test("at the default of 50 nothing carries limit", async () => {
    const html = await render(AUDIT_LOG_PAGE_SIZE);
    expect(formWith(html, "action")).not.toContain('name="limit"');
    expectLinks(linksTo(hrefsOf(html), "/dashboard/audit-log"), null);
  });

  test("the actor filter stays escaped", async () => {
    expect(await render(25)).not.toContain(XSS);
  });
});

describe("DMARC reports domain links keep the size (#435)", () => {
  /** Renders the DMARC list with two domains (one hostile) and the given size. */
  async function render(limit: number): Promise<string> {
    return await DmarcReportsPage({
      reports: [],
      total: 0,
      page: 4,
      limit,
      domainFilter: "example.com",
      domains: ["example.com", XSS],
    });
  }

  /** The All link and the per-domain links, without the pagination links. */
  function domainLinks(html: string): string[] {
    return linksTo(hrefsOf(html), "/dashboard/dmarc-reports").filter(
      (href) => paramsOf(href).page === null,
    );
  }

  test("All and every domain link carry limit=50", async () => {
    const links = domainLinks(await render(50));
    expect(links.length).toBe(3);
    expectLinks(links, "50");
  });

  test("at the default size nothing carries limit", async () => {
    const links = domainLinks(await render(25));
    expect(links.length).toBe(3);
    expectLinks(links, null);
  });

  test("a domain stays escaped and keeps its own value", async () => {
    const html = await render(50);
    expect(html).not.toContain(XSS);
    const domains = domainLinks(html).map((href) =>
      new URL(href, "http://localhost").searchParams.get("domain"),
    );
    expect(domains).toEqual([null, "example.com", XSS]);
  });
});

describe("Tombstones search keeps the size (#435)", () => {
  /** Renders the tombstones page with a Message-ID search and the given size. */
  async function render(limit: number): Promise<string> {
    return await EmailTombstonesPage({
      tombstones: [],
      total: 0,
      page: 2,
      limit,
      messageIdFilter: XSS,
    });
  }

  /** The Clear link (the only tombstones link without a `page`). */
  function clearLinks(html: string): string[] {
    return linksTo(hrefsOf(html), "/dashboard/emails/tombstones").filter(
      (href) => paramsOf(href).page === null,
    );
  }

  test("the search form and Clear carry limit=50", async () => {
    const html = await render(50);
    const form = formWith(html, "messageId");
    expect(form).toContain(hiddenLimit("50"));
    expect(form).not.toContain('name="page"');
    expectLinks(clearLinks(html), "50");
  });

  test("at the default size nothing carries limit", async () => {
    const html = await render(25);
    expect(formWith(html, "messageId")).not.toContain('name="limit"');
    expectLinks(clearLinks(html), null);
  });

  test("the Message-ID stays escaped", async () => {
    expect(await render(50)).not.toContain(XSS);
  });
});

describe("Webhook deliveries status pills keep the size (#435)", () => {
  /** A webhook row, only its id and URL matter here. */
  const webhook = {
    id: "whk_1",
    apiKeyId: "key_1",
    url: "https://hook.example.com",
    events: ["email.sent"],
    secret: "secret",
    isActive: true,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    createdByUserId: null,
  };
  const base = "/dashboard/webhooks/whk_1/deliveries";

  /** Renders the deliveries page with a status filter and the given size. */
  async function render(limit: number): Promise<string> {
    return await WebhookDeliveriesPage({
      webhook,
      deliveries: [],
      total: 0,
      page: 2,
      limit,
      statusFilter: "failed",
    });
  }

  /** The status pills, without the pagination links. */
  function pills(html: string): string[] {
    return linksTo(hrefsOf(html), base).filter((href) => paramsOf(href).page === null);
  }

  test("every pill carries limit=100 and keeps its status", async () => {
    const links = pills(await render(100));
    expect(links.length).toBe(4);
    expectLinks(links, "100");
    expect(
      links.map((href) => new URL(href, "http://localhost").searchParams.get("status")),
    ).toEqual([null, "pending", "delivered", "failed"]);
  });

  test("at the default size no pill carries limit", async () => {
    const links = pills(await render(25));
    expect(links.length).toBe(4);
    expectLinks(links, null);
  });
});
