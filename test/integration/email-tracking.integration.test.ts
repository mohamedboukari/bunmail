/**
 * Open and click tracking, foundation (#187), against a real Postgres:
 *
 * - `createEmail` stores the tracking decision on the row: every gate
 *   (`TRACKING_ENABLED`, the domain's opt-in, one recipient, an https
 *   `APP_BASE_URL`, not SMTP submission) must allow it, `false` always
 *   wins, `transactional` mail is off unless the send asks, and a `true`
 *   that cannot be honoured adds the `tracking_disabled` warning;
 * - a later domain change leaves queued mail as decided;
 * - `POST /api/v1/emails/send` and `/batch` take `tracking` and answer
 *   `tracking`, `firstOpenedAt` and `firstClickedAt`; a restricted key can
 *   opt out but cannot turn tracking on for a domain that has it off;
 * - the domain opt-in over REST (admin keys only) and the dashboard
 *   (admins only), audited as `domain.updated`;
 * - `email_events`: its CHECK constraints, the cascade with the email,
 *   and the retention sweep of the purge cycle.
 *
 * Nothing is injected into messages yet: that comes with the tracking
 * endpoints.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { and, eq } from "drizzle-orm";
import { createEmail } from "../../src/modules/emails/services/email.service.ts";
import { emailsPlugin } from "../../src/modules/emails/emails.plugin.ts";
import { domainsPlugin } from "../../src/modules/domains/domains.plugin.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { emailEvents } from "../../src/modules/emails/models/email-event.schema.ts";
import { auditEvents } from "../../src/modules/audit/models/audit-event.schema.ts";
import { runEmailEventsRetention } from "../../src/modules/trash/services/purge.service.ts";
import type { UserRole } from "../../src/modules/users/types/user.types.ts";
import type { SendEmailInput } from "../../src/modules/emails/types/email.types.ts";
import { generateId } from "../../src/utils/id.ts";
import { config } from "../../src/config.ts";
import { truncateAll, seed, db, domains, emails } from "./_helpers.ts";
import { readJson } from "../read-json.ts";

const HTTPS_BASE = "https://mail.example.com";

const originalEnabled = config.tracking.enabled;
const originalRetention = config.tracking.eventsRetentionDays;
const originalBaseUrl = config.appBaseUrl;

/** Sets the kill switch and `APP_BASE_URL` for a test (read-only only to TypeScript). */
function setGates(enabled: boolean, appBaseUrl: string = HTTPS_BASE): void {
  Object.assign(config.tracking, { enabled });
  expect(Reflect.set(config, "appBaseUrl", appBaseUrl)).toBe(true);
}

let apiKeyId = "";
let domainName = "";
let domainId = "";

beforeEach(async () => {
  await truncateAll();
  setGates(true);
  apiKeyId = (await seed.apiKey()).id;
  const domain = await seed.domain({
    name: "tracked.example.com",
    trackOpens: true,
    trackClicks: true,
  });
  domainName = domain.name;
  domainId = domain.id;
});

afterEach(() => {
  Object.assign(config.tracking, {
    enabled: originalEnabled,
    eventsRetentionDays: originalRetention,
  });
  Reflect.set(config, "appBaseUrl", originalBaseUrl);
});

/** A one-recipient send from the opted-in domain, plus `extra`. */
function send(extra: Partial<SendEmailInput> = {}): SendEmailInput {
  return {
    from: `hello@${domainName}`,
    to: "user@example.org",
    subject: "Hello",
    html: '<p>Hi <a href="https://example.com/pricing">pricing</a></p>',
    ...extra,
  };
}

/** The stored decision of an email. */
async function stored(id: string): Promise<{ opens: boolean; clicks: boolean }> {
  const [row] = await db
    .select({ opens: emails.trackOpens, clicks: emails.trackClicks })
    .from(emails)
    .where(eq(emails.id, id));
  if (!row) throw new Error(`email ${id} not found`);
  return row;
}

describe("createEmail: the tracking decision is stored on the row", () => {
  test("every gate open: tracked, no warning", async () => {
    const { email, warnings } = await createEmail(send(), apiKeyId);
    expect(await stored(email.id)).toEqual({ opens: true, clicks: true });
    expect(email.trackOpens).toBe(true);
    expect(warnings).not.toContain("tracking_disabled");
  });

  test("the kill switch off (the default): nothing tracked; an explicit true warns", async () => {
    setGates(false);
    const inherited = await createEmail(send(), apiKeyId);
    expect(await stored(inherited.email.id)).toEqual({ opens: false, clicks: false });
    expect(inherited.warnings).not.toContain("tracking_disabled");

    const asked = await createEmail(send({ tracking: { opens: true } }), apiKeyId);
    expect(await stored(asked.email.id)).toEqual({ opens: false, clicks: false });
    expect(asked.warnings).toContain("tracking_disabled");
    expect(asked.email.status).toBe("queued");
  });

  test("a domain that has not opted in: off; an explicit true warns", async () => {
    await db
      .update(domains)
      .set({ trackOpens: false, trackClicks: true })
      .where(eq(domains.id, domainId));
    const inherited = await createEmail(send(), apiKeyId);
    expect(await stored(inherited.email.id)).toEqual({ opens: false, clicks: true });
    expect(inherited.warnings).not.toContain("tracking_disabled");

    const asked = await createEmail(send({ tracking: { opens: true } }), apiKeyId);
    expect(await stored(asked.email.id)).toEqual({ opens: false, clicks: true });
    expect(asked.warnings).toContain("tracking_disabled");
  });

  test("false always wins, per kind", async () => {
    const { email, warnings } = await createEmail(
      send({ tracking: { opens: false } }),
      apiKeyId,
    );
    expect(await stored(email.id)).toEqual({ opens: false, clicks: true });
    expect(warnings).not.toContain("tracking_disabled");
  });

  test("transactional: off unless the send asks", async () => {
    const inherited = await createEmail(send({ category: "transactional" }), apiKeyId);
    expect(await stored(inherited.email.id)).toEqual({ opens: false, clicks: false });

    const asked = await createEmail(
      send({ category: "transactional", tracking: { clicks: true } }),
      apiKeyId,
    );
    expect(await stored(asked.email.id)).toEqual({ opens: false, clicks: true });
    expect(asked.warnings).not.toContain("tracking_disabled");
  });

  test("several recipients: never tracked; an explicit true warns", async () => {
    const withCc = await createEmail(send({ cc: "other@example.org" }), apiKeyId);
    expect(await stored(withCc.email.id)).toEqual({ opens: false, clicks: false });

    const twoTo = await createEmail(
      send({ to: ["a@example.org", "b@example.org"], tracking: { opens: true } }),
      apiKeyId,
    );
    expect(await stored(twoTo.email.id)).toEqual({ opens: false, clicks: false });
    expect(twoTo.warnings).toContain("tracking_disabled");
  });

  test("an http APP_BASE_URL: never tracked", async () => {
    setGates(true, "http://mail.example.com");
    const { email, warnings } = await createEmail(
      send({ tracking: { opens: true, clicks: true } }),
      apiKeyId,
    );
    expect(await stored(email.id)).toEqual({ opens: false, clicks: false });
    expect(warnings).toContain("tracking_disabled");
  });

  test("an unregistered sender domain (development): never tracked", async () => {
    const { email, warnings } = await createEmail(
      send({ from: "hello@unregistered.test" }),
      apiKeyId,
    );
    expect(await stored(email.id)).toEqual({ opens: false, clicks: false });
    expect(warnings).toEqual(["domain_unregistered"]);
  });

  test("SMTP submission: never tracked", async () => {
    const { email, warnings } = await createEmail(send(), apiKeyId, "smtp");
    expect(await stored(email.id)).toEqual({ opens: false, clicks: false });
    expect(warnings).not.toContain("tracking_disabled");
  });

  test("a later domain change leaves queued mail as decided", async () => {
    const { email } = await createEmail(send(), apiKeyId);
    await db
      .update(domains)
      .set({ trackOpens: false, trackClicks: false })
      .where(eq(domains.id, domainId));
    expect(await stored(email.id)).toEqual({ opens: true, clicks: true });
  });
});

/* ─── REST ─── */

const api = new Elysia().use(emailsPlugin).use(domainsPlugin);

function rest(
  method: string,
  path: string,
  key: string,
  body?: unknown,
): Promise<Response> {
  return api.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

interface SendBody {
  data: {
    id: string;
    tracking: { opens: boolean; clicks: boolean };
    firstOpenedAt: string | null;
    firstClickedAt: string | null;
  };
  warnings: string[];
}

interface BatchBody {
  data: Array<{ success: boolean; data?: SendBody["data"]; warnings?: string[] }>;
}

interface DomainBody {
  data?: { id: string; trackOpens: boolean; trackClicks: boolean };
}

describe("POST /api/v1/emails/send and /batch", () => {
  test("answers the decision, the first open and click, and the warning", async () => {
    const { rawKey } = await seed.apiKey();
    const tracked = await readJson<SendBody>(
      await rest("POST", "/api/v1/emails/send", rawKey, send()),
    );
    expect(tracked.data.tracking).toEqual({ opens: true, clicks: true });
    expect(tracked.data.firstOpenedAt).toBeNull();
    expect(tracked.data.firstClickedAt).toBeNull();
    expect(tracked.warnings).not.toContain("tracking_disabled");

    const refused = await readJson<SendBody>(
      await rest(
        "POST",
        "/api/v1/emails/send",
        rawKey,
        send({ cc: "other@example.org", tracking: { opens: true } }),
      ),
    );
    expect(refused.data.tracking).toEqual({ opens: false, clicks: false });
    expect(refused.warnings).toContain("tracking_disabled");
  });

  test("a non-boolean is a validation error and queues nothing", async () => {
    const { rawKey } = await seed.apiKey();
    const res = await rest("POST", "/api/v1/emails/send", rawKey, {
      ...send(),
      tracking: { opens: "yes" },
    });
    expect(res.status).toBe(422);
    expect(await db.select({ id: emails.id }).from(emails)).toHaveLength(0);
  });

  test("batch items decide per item", async () => {
    const { rawKey } = await seed.apiKey();
    const res = await rest("POST", "/api/v1/emails/batch", rawKey, {
      emails: [
        send({ tracking: { clicks: false } }),
        send({ category: "transactional" }),
      ],
    });
    const { data } = await readJson<BatchBody>(res);
    expect(data.map((item) => item.data?.tracking)).toEqual([
      { opens: true, clicks: false },
      { opens: false, clicks: false },
    ]);
  });

  test("a restricted key can opt out, but not turn on what the domain has off", async () => {
    const restricted = await seed.apiKey({ isAdmin: false });
    const optOut = await readJson<SendBody>(
      await rest(
        "POST",
        "/api/v1/emails/send",
        restricted.rawKey,
        send({ tracking: { opens: false, clicks: false } }),
      ),
    );
    expect(optOut.data.tracking).toEqual({ opens: false, clicks: false });

    await db
      .update(domains)
      .set({ trackOpens: false, trackClicks: false })
      .where(eq(domains.id, domainId));
    const asked = await readJson<SendBody>(
      await rest(
        "POST",
        "/api/v1/emails/send",
        restricted.rawKey,
        send({ tracking: { opens: true, clicks: true } }),
      ),
    );
    expect(asked.data.tracking).toEqual({ opens: false, clicks: false });
    expect(asked.warnings).toContain("tracking_disabled");
  });
});

describe("domain tracking opt-in over REST (admin keys only)", () => {
  test("create stores it, off when omitted", async () => {
    const { rawKey } = await seed.apiKey({ isAdmin: true });
    const on = await readJson<DomainBody>(
      await rest("POST", "/api/v1/domains", rawKey, {
        name: "on.example.com",
        trackOpens: true,
      }),
    );
    expect(on.data).toMatchObject({ trackOpens: true, trackClicks: false });

    const off = await readJson<DomainBody>(
      await rest("POST", "/api/v1/domains", rawKey, { name: "off.example.com" }),
    );
    expect(off.data).toMatchObject({ trackOpens: false, trackClicks: false });
  });

  test("PATCH toggles it, keeps omitted fields, and is audited as domain.updated", async () => {
    const { rawKey } = await seed.apiKey({ isAdmin: true });
    const res = await rest("PATCH", `/api/v1/domains/${domainId}`, rawKey, {
      trackClicks: false,
    });
    expect(res.status).toBe(200);
    const { data } = await readJson<DomainBody>(res);
    expect(data).toMatchObject({ trackOpens: true, trackClicks: false });

    const [audit] = await db
      .select({ metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "domain.updated"), eq(auditEvents.targetId, domainId)),
      );
    expect(audit?.metadata).toEqual({ fields: ["trackClicks"] });
  });

  test("PATCH refuses a non-boolean", async () => {
    const { rawKey } = await seed.apiKey({ isAdmin: true });
    const res = await rest("PATCH", `/api/v1/domains/${domainId}`, rawKey, {
      trackOpens: null,
    });
    expect(res.status).toBe(422);
  });

  test("a restricted key gets 403 and changes nothing", async () => {
    const { rawKey } = await seed.apiKey({ isAdmin: false });
    const res = await rest("PATCH", `/api/v1/domains/${domainId}`, rawKey, {
      trackOpens: false,
    });
    expect(res.status).toBe(403);
    const [row] = await db
      .select({ trackOpens: domains.trackOpens })
      .from(domains)
      .where(eq(domains.id, domainId));
    expect(row?.trackOpens).toBe(true);
  });
});

/* ─── Dashboard ─── */

const dashboard = new Elysia().use(pagesPlugin);

/** A session token for a fresh user of `role`. */
async function tokenFor(role: UserRole): Promise<string> {
  const { id } = await seed.user({ email: `${role}-${Date.now()}@example.com`, role });
  return (await seed.session({ userId: id })).token;
}

/** A same-origin dashboard form post. */
function postForm(
  path: string,
  token: string,
  body: Record<string, string>,
): Promise<Response> {
  return dashboard.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        cookie: `bm_session=${token}`,
        origin: "http://localhost",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
    }),
  );
}

/** The stored opt-in of the seeded domain. */
async function domainFlags(): Promise<{ opens: boolean; clicks: boolean }> {
  const [row] = await db
    .select({ opens: domains.trackOpens, clicks: domains.trackClicks })
    .from(domains)
    .where(eq(domains.id, domainId));
  if (!row) throw new Error("domain not found");
  return row;
}

describe("domain tracking opt-in in the dashboard (admins only)", () => {
  test("an admin saves the checkboxes; an unticked box turns it off; audited", async () => {
    const token = await tokenFor("admin");
    const res = await postForm(`/dashboard/domains/${domainId}/tracking`, token, {
      trackOpens: "true",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      `/dashboard/domains/${domainId}?flash=`,
    );
    expect(await domainFlags()).toEqual({ opens: true, clicks: false });

    await postForm(`/dashboard/domains/${domainId}/tracking`, token, {});
    expect(await domainFlags()).toEqual({ opens: false, clicks: false });

    const audits = await db
      .select({ metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "domain.updated"), eq(auditEvents.targetId, domainId)),
      );
    expect(audits).toHaveLength(2);
    expect(audits[0]?.metadata).toEqual({ fields: ["trackOpens", "trackClicks"] });
  });

  test("the flash says when TRACKING_ENABLED keeps everything off", async () => {
    setGates(false);
    const res = await postForm(
      `/dashboard/domains/${domainId}/tracking`,
      await tokenFor("owner"),
      { trackOpens: "true", trackClicks: "true" },
    );
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain(
      "Nothing is tracked while TRACKING_ENABLED is off",
    );
  });

  test("a member gets 403 and changes nothing", async () => {
    const res = await postForm(
      `/dashboard/domains/${domainId}/tracking`,
      await tokenFor("member"),
      {},
    );
    expect(res.status).toBe(403);
    expect(await domainFlags()).toEqual({ opens: true, clicks: true });
  });

  test("an unknown domain lands on the list with an error", async () => {
    const res = await postForm(
      "/dashboard/domains/dom_missing/tracking",
      await tokenFor("admin"),
      {
        trackOpens: "true",
      },
    );
    expect(res.headers.get("location")).toContain("/dashboard/domains?flash=");
  });

  test("the domain page shows the panel with the stored opt-in", async () => {
    const res = await dashboard.handle(
      new Request(`http://localhost/dashboard/domains/${domainId}`, {
        headers: { cookie: `bm_session=${await tokenFor("member")}` },
      }),
    );
    const page = await res.text();
    expect(page).toContain(`/dashboard/domains/${domainId}/tracking`);
    expect(page).toMatch(/<input[^>]*name="trackOpens"[^>]*checked/);
  });
});

/* ─── email_events ─── */

/** Inserts an event of `emailId`, `ageDays` old. */
async function insertEvent(
  emailId: string,
  ageDays: number,
  type: "open" | "click" = "open",
): Promise<string> {
  const id = generateId("evt");
  await db.insert(emailEvents).values({
    id,
    emailId,
    apiKeyId,
    type,
    linkPosition: type === "click" ? 0 : null,
    url: type === "click" ? "https://example.com/pricing" : null,
    clientKind: "unknown",
    machine: false,
    occurredAt: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000),
  });
  return id;
}

/** The ids of every stored event. */
async function eventIds(): Promise<string[]> {
  const rows = await db.select({ id: emailEvents.id }).from(emailEvents);
  return rows.map((row) => row.id).toSorted();
}

/** Whether inserting an event with `type` and `clientKind` is refused by the database. */
async function insertRefused(
  emailId: string,
  type: string,
  clientKind: string,
): Promise<boolean> {
  try {
    await db.insert(emailEvents).values({
      id: generateId("evt"),
      emailId,
      apiKeyId,
      type,
      clientKind,
      machine: false,
    });
    return false;
  } catch {
    return true;
  }
}

describe("email_events", () => {
  test("the CHECK constraints refuse an unknown type or client kind", async () => {
    const { id: emailId } = await seed.email({ apiKeyId });
    expect(await insertRefused(emailId, "bounce", "unknown")).toBe(true);
    expect(await insertRefused(emailId, "open", "browser")).toBe(true);
    expect(await insertRefused(emailId, "click", "image_proxy")).toBe(false);
    expect(await eventIds()).toHaveLength(1);
  });

  test("events are deleted with their email", async () => {
    const { id: kept } = await seed.email({ apiKeyId });
    const { id: gone } = await seed.email({ apiKeyId });
    const keptEvent = await insertEvent(kept, 0);
    await insertEvent(gone, 0, "click");
    await db.delete(emails).where(eq(emails.id, gone));
    expect(await eventIds()).toEqual([keptEvent]);
  });

  test("the retention sweep deletes events older than EMAIL_EVENTS_RETENTION_DAYS", async () => {
    Object.assign(config.tracking, { eventsRetentionDays: 30 });
    const { id: emailId } = await seed.email({ apiKeyId });
    const fresh = await insertEvent(emailId, 1);
    const edge = await insertEvent(emailId, 29);
    await insertEvent(emailId, 31);
    await insertEvent(emailId, 400, "click");

    expect(await runEmailEventsRetention()).toEqual({ deleted: 2 });
    expect(await eventIds()).toEqual([fresh, edge].toSorted());
    /** The email itself is untouched. */
    expect(await db.select({ id: emails.id }).from(emails)).toHaveLength(1);

    expect(await runEmailEventsRetention()).toEqual({ deleted: 0 });
  });
});
