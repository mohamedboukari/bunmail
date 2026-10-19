/**
 * The audit log (#221) against real Postgres:
 *
 * - `recordAuditEvent`: labels resolved from the live rows (and kept
 *   after the row is deleted: no foreign keys), the IP kept only when it
 *   is an IP literal, the user agent cut to 256 characters, a
 *   secret-looking metadata key dropped; inside a transaction the record
 *   rolls back with the change, and a failing record inside an account
 *   action rolls the action back (the change and its record commit
 *   together); outside one, a failure is logged and swallowed.
 * - Append-only: the migration's trigger refuses any `UPDATE`, from the
 *   ORM or raw SQL; `DELETE` (the retention purge) still works.
 * - Retention: only rows older than the cutoff go, in batches, and the
 *   purge records itself.
 * - A login flood from one address records a bounded number of rows.
 * - The Audit log page: admins and the owner see it, members get 403;
 *   the filters; hostile labels and user agents are escaped.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Elysia } from "elysia";
import { html } from "@elysiajs/html";
import { desc, eq, sql } from "drizzle-orm";
import { db, seed, truncateAll } from "./_helpers.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { withRequestContext } from "../../src/middleware/request-context.ts";
import { loginAttemptMap } from "../../src/middleware/login-rate-limit.ts";
import { auditEvents } from "../../src/modules/audit/models/audit-event.schema.ts";
import {
  listAuditEvents,
  purgeOldAuditEvents,
  recordAuditEvent,
} from "../../src/modules/audit/services/audit.service.ts";
import { runAuditRetention } from "../../src/modules/trash/services/purge.service.ts";
import { users } from "../../src/modules/users/models/user.schema.ts";
import { deactivateAccount } from "../../src/modules/users/services/user-admin.service.ts";
import { createSession } from "../../src/modules/users/services/session.service.ts";
import { logger } from "../../src/utils/logger.ts";
import { generateId } from "../../src/utils/id.ts";
import { config } from "../../src/config.ts";

/** Wrapped in the request context, as in `src/index.ts`: the sidebar reads the viewer's role from it. */
const app = new Elysia().wrap(withRequestContext).use(html()).use(pagesPlugin);

const PASSWORD = "the account password, long enough";
const originalProxyHops = config.dashboard.trustedProxyHops;
const originalRetention = config.auditLog.retentionDays;

const ids = { owner: "", admin: "", member: "" };
const tokens = { owner: "", admin: "", member: "" };

beforeEach(async () => {
  loginAttemptMap.clear();
  await truncateAll();
  ids.owner = (
    await seed.user({ email: "owner@example.com", role: "owner", password: PASSWORD })
  ).id;
  ids.admin = (
    await seed.user({ email: "admin@example.com", role: "admin", password: PASSWORD })
  ).id;
  ids.member = (
    await seed.user({ email: "member@example.com", role: "member", password: PASSWORD })
  ).id;
  for (const role of ["owner", "admin", "member"] as const) {
    tokens[role] = (
      await createSession({
        userId: ids[role],
        assurance: "password",
        authMethod: "password",
        ip: null,
        userAgent: null,
      })
    ).token;
  }
  /** Rows the fixtures wrote (none today) never count. */
  await db.delete(auditEvents);
});

afterEach(() => {
  expect(Reflect.set(config.dashboard, "trustedProxyHops", originalProxyHops)).toBe(true);
  expect(Reflect.set(config.auditLog, "retentionDays", originalRetention)).toBe(true);
});

/* ─── Helpers ─── */

/** Every stored event, newest first. */
function allEvents(): Promise<Array<typeof auditEvents.$inferSelect>> {
  return db.select().from(auditEvents).orderBy(desc(auditEvents.occurredAt));
}

/** A dashboard GET with a session cookie. */
function getPage(path: string, token: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      headers: { cookie: `bm_session=${token}` },
    }),
  );
}

/** A login POST from `ip` (the proxy header is trusted in these tests). */
function login(email: string, password: string, ip: string): Promise<Response> {
  return app.handle(
    new Request("http://localhost/dashboard/login", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": ip,
      },
      body: new URLSearchParams({ email, password }).toString(),
    }),
  );
}

/**
 * Runs `fn` while the database refuses to insert audit rows of `action`
 * (a test-only trigger, dropped afterwards).
 */
async function withRefusedAction(action: string, fn: () => Promise<void>): Promise<void> {
  await db.execute(
    sql.raw(`
      CREATE FUNCTION audit_test_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = '${action}' THEN RAISE EXCEPTION 'refused by test'; END IF;
        RETURN NEW;
      END $$`),
  );
  await db.execute(sql`
    CREATE TRIGGER audit_test_refuse BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_test_refuse()`);
  try {
    await fn();
  } finally {
    await db.execute(sql`DROP TRIGGER audit_test_refuse ON audit_events`);
    await db.execute(sql`DROP FUNCTION audit_test_refuse()`);
  }
}

/* ─── recordAuditEvent ─── */

describe("recordAuditEvent", () => {
  test("stores the event, the labels read from the live rows, and keeps them after a delete", async () => {
    const key = await seed.apiKey({ name: "billing key" });
    const domain = await seed.domain({ name: "mail.example.org" });
    await recordAuditEvent({
      action: "api_key.revoked",
      actor: { type: "user", id: ids.admin },
      ip: "203.0.113.9",
      userAgent: "Mozilla/5.0 test",
      target: { type: "api_key", id: key.id },
    });
    await recordAuditEvent({
      action: "domain.deleted",
      actor: { type: "api_key", id: key.id },
      target: { type: "domain", id: domain.id },
    });

    await db.delete(users).where(eq(users.id, ids.admin));
    const [domainEvent, keyEvent] = await allEvents();
    expect(keyEvent).toMatchObject({
      actorType: "user",
      actorId: ids.admin,
      actorLabel: "admin@example.com",
      action: "api_key.revoked",
      outcome: "success",
      targetType: "api_key",
      targetId: key.id,
      targetLabel: "billing key",
      ip: "203.0.113.9",
      userAgent: "Mozilla/5.0 test",
      metadata: null,
    });
    expect(domainEvent).toMatchObject({
      actorType: "api_key",
      actorId: key.id,
      actorLabel: "billing key",
      targetLabel: "mail.example.org",
    });
  });

  test("keeps only an IP literal, cuts the user agent to 256 characters, drops a secret-looking key", async () => {
    const warn = spyOn(logger, "warn");
    try {
      const metadata = { isAdmin: true, allowedSenders: 0, password: "hunter2" };
      await recordAuditEvent({
        action: "api_key.created",
        actor: { type: "system", label: "test" },
        ip: "unknown",
        userAgent: "x".repeat(1000),
        metadata,
      });
      const [event] = await allEvents();
      expect(event?.ip).toBeNull();
      expect(event?.userAgent).toHaveLength(256);
      expect(event?.metadata).toEqual({ isAdmin: true, allowedSenders: 0 });
      expect(JSON.stringify(event)).not.toContain("hunter2");
      expect(warn).toHaveBeenCalledWith(
        "Audit metadata key dropped: looks like a secret",
        { action: "api_key.created", key: "password" },
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("never stores the typed email of an unknown account: no actor id, no label", async () => {
    await recordAuditEvent({
      action: "auth.login.failed",
      outcome: "failure",
      actor: { type: "user", id: null },
      metadata: { step: "password", reason: "unknown_account" },
    });
    const [event] = await allEvents();
    expect(event).toMatchObject({ actorType: "user", actorId: null, actorLabel: null });
  });

  test("inside a transaction, the record rolls back with the change", async () => {
    const thrown = await db
      .transaction(async (tx) => {
        await tx.update(users).set({ name: "Changed" }).where(eq(users.id, ids.member));
        await recordAuditEvent(
          { action: "user.reactivated", actor: { type: "user", id: ids.admin } },
          tx,
        );
        throw new Error("abort");
      })
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect(await allEvents()).toHaveLength(0);
    const [member] = await db.select().from(users).where(eq(users.id, ids.member));
    expect(member?.name).toBeNull();
  });

  test("a record that fails inside an account action rolls the action back (one transaction)", async () => {
    await withRefusedAction("user.deactivated", async () => {
      const outcome = await deactivateAccount(ids.owner, ids.member).then(
        () => null,
        (error: unknown) => error,
      );
      expect(outcome).toBeInstanceOf(Error);
    });
    const [member] = await db.select().from(users).where(eq(users.id, ids.member));
    expect(member?.disabledAt).toBeNull();
    expect(await allEvents()).toHaveLength(0);
    /** With the database accepting it again, the same action applies and is recorded. */
    expect(await deactivateAccount(ids.owner, ids.member)).toEqual({ ok: true });
    expect((await allEvents()).map((event) => event.action)).toEqual([
      "user.deactivated",
    ]);
  });

  test("outside a transaction, a failed write is logged at error and never thrown", async () => {
    const error = spyOn(logger, "error");
    try {
      await withRefusedAction("auth.logout", async () => {
        await recordAuditEvent({
          action: "auth.logout",
          actor: { type: "system", label: "test" },
          target: { type: "user", id: "usr_x", label: "someone@example.com" },
          userAgent: "an agent",
        });
      });
      /** IDs and the SQLSTATE only: never a label or the user agent. */
      expect(error).toHaveBeenCalledWith("Audit event not recorded", {
        action: "auth.logout",
        outcome: "success",
        actorType: "system",
        actorId: null,
        targetType: "user",
        targetId: "usr_x",
        sqlState: "P0001",
      });
      expect(await allEvents()).toHaveLength(0);
    } finally {
      error.mockRestore();
    }
  });
});

/* ─── Append-only ─── */

describe("append-only (migration trigger)", () => {
  test("an UPDATE is refused, from the ORM and from raw SQL; a DELETE works", async () => {
    await recordAuditEvent({
      action: "auth.logout",
      actor: { type: "user", id: ids.member },
    });

    const viaOrm = await db
      .update(auditEvents)
      .set({ outcome: "failure" })
      .where(eq(auditEvents.action, "auth.logout"))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(viaOrm).toBeInstanceOf(Error);
    const viaSql = await db
      .execute(sql`UPDATE audit_events SET actor_label = 'someone else'`)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(viaSql).toBeInstanceOf(Error);
    const [event] = await allEvents();
    expect(event).toMatchObject({ outcome: "success", actorLabel: "member@example.com" });

    await db.delete(auditEvents);
    expect(await allEvents()).toHaveLength(0);
  });

  test("the refusal names the rule", async () => {
    const error = await db
      .execute(sql`UPDATE audit_events SET outcome = 'failure'`)
      .catch((caught: unknown) => caught);
    const cause = error instanceof Error ? error.cause : undefined;
    expect(String(cause instanceof Error ? cause.message : error)).toContain(
      "append-only",
    );
  });
});

/* ─── Retention ─── */

/** Inserts an event `age` old (a Postgres interval), straight into the table. */
async function eventAged(age: string): Promise<string> {
  const id = generateId("aud");
  await db.insert(auditEvents).values({
    id,
    occurredAt: sql`now() - ${sql.raw(`interval '${age}'`)}`,
    actorType: "system",
    actorLabel: "test",
    action: "auth.logout",
    outcome: "success",
  });
  return id;
}

describe("retention purge", () => {
  test("deletes only events older than the retention, across batches", async () => {
    const old = [
      await eventAged("31 days"),
      await eventAged("40 days"),
      await eventAged("400 days"),
      await eventAged("30 days 1 minute"),
      await eventAged("3000 days"),
    ];
    const kept = [await eventAged("29 days 23 hours"), await eventAged("1 minute")];

    expect(await purgeOldAuditEvents(30, 2)).toBe(old.length);
    const left = (await allEvents()).map((event) => event.id).toSorted();
    expect(left).toEqual(kept.toSorted());
    expect(await purgeOldAuditEvents(30, 2)).toBe(0);
  });

  test("the purge job uses AUDIT_LOG_RETENTION_DAYS and records itself", async () => {
    expect(Reflect.set(config.auditLog, "retentionDays", 90)).toBe(true);
    await eventAged("91 days");
    await eventAged("89 days");
    expect(await runAuditRetention()).toEqual({ deleted: 1 });
    const events = await allEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      action: "audit_log.purged",
      actorType: "system",
      actorId: null,
      actorLabel: "retention purge",
      targetType: "audit_log",
      metadata: { deleted: 1, retentionDays: 90 },
    });
    /** Nothing old left: no row, no record. */
    expect(await runAuditRetention()).toEqual({ deleted: 0 });
    expect(await allEvents()).toHaveLength(2);
  });
});

/* ─── Login flood ─── */

describe("a login flood", () => {
  test("records each counted failure and the lockout once per address and window", async () => {
    expect(Reflect.set(config.dashboard, "trustedProxyHops", 1)).toBe(true);
    const { maxAttempts } = config.dashboard.loginRateLimit;
    expect(config.dashboard.loginRateLimit.enabled).toBe(true);
    for (let attempt = 0; attempt < maxAttempts + 25; attempt += 1) {
      await login("nobody@example.com", "a wrong password", "198.51.100.77");
    }
    const events = await allEvents();
    const byAction = (action: string): number =>
      events.filter((event) => event.action === action).length;
    expect(byAction("auth.login.failed")).toBe(maxAttempts);
    expect(byAction("auth.login.rate_limited")).toBe(1);
    expect(events).toHaveLength(maxAttempts + 1);
    for (const event of events) {
      expect(event).toMatchObject({
        actorId: null,
        actorLabel: null,
        ip: "198.51.100.77",
      });
      expect(JSON.stringify(event)).not.toContain("nobody@example.com");
    }

    /** Another address has its own window, and its own single lockout row. */
    for (let attempt = 0; attempt < maxAttempts + 3; attempt += 1) {
      await login("nobody@example.com", "a wrong password", "198.51.100.78");
    }
    expect((await allEvents()).length).toBe(2 * (maxAttempts + 1));
  });
});

/* ─── The page ─── */

describe("GET /dashboard/audit-log", () => {
  test("the owner and admins see it; a member gets the 403 page and no rows", async () => {
    await recordAuditEvent({
      action: "auth.login.succeeded",
      actor: { type: "user", id: ids.admin },
      ip: "203.0.113.5",
      metadata: { method: "password" },
    });
    for (const role of ["owner", "admin"] as const) {
      const response = await getPage("/dashboard/audit-log", tokens[role]);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const page = await response.text();
      expect(page).toContain("Signed in");
      expect(page).toContain("admin@example.com");
      expect(page).toContain("203.0.113.5");
    }
    const denied = await getPage("/dashboard/audit-log", tokens.member);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain("203.0.113.5");
  });

  test("the sidebar links it for admins only", async () => {
    const adminHome = await (await getPage("/dashboard", tokens.admin)).text();
    expect(adminHome).toContain('href="/dashboard/audit-log"');
    const memberHome = await (await getPage("/dashboard", tokens.member)).text();
    expect(memberHome).not.toContain('href="/dashboard/audit-log"');
  });

  test("filters by action, actor and outcome", async () => {
    const key = await seed.apiKey({ name: "ops key" });
    await recordAuditEvent({
      action: "auth.login.succeeded",
      actor: { type: "user", id: ids.admin },
      ip: "192.0.2.1",
      metadata: { method: "password" },
    });
    await recordAuditEvent({
      action: "auth.login.failed",
      outcome: "failure",
      actor: { type: "user", id: ids.member },
      ip: "192.0.2.2",
      metadata: { step: "password", reason: "wrong_password" },
    });
    await recordAuditEvent({
      action: "domain.created",
      actor: { type: "api_key", id: key.id },
      ip: "192.0.2.3",
      target: { type: "domain", id: "dom_x", label: "example.net" },
    });

    const rowsOf = async (query: string): Promise<string[]> => {
      const page = await (
        await getPage(`/dashboard/audit-log?${query}`, tokens.owner)
      ).text();
      return ["192.0.2.1", "192.0.2.2", "192.0.2.3"].filter((ip) => page.includes(ip));
    };
    expect(await rowsOf("")).toEqual(["192.0.2.1", "192.0.2.2", "192.0.2.3"]);
    expect(await rowsOf("action=auth.login.failed")).toEqual(["192.0.2.2"]);
    expect(await rowsOf("outcome=success")).toEqual(["192.0.2.1", "192.0.2.3"]);
    expect(await rowsOf(`actor=api_key:${key.id}`)).toEqual(["192.0.2.3"]);
    expect(await rowsOf(`actor=user:${ids.member}`)).toEqual(["192.0.2.2"]);
    /** A hand-edited value is ignored, never an error. */
    expect(await rowsOf("action=constructor&actor=user:'--&outcome=x")).toEqual([
      "192.0.2.1",
      "192.0.2.2",
      "192.0.2.3",
    ]);

    /** The actor filter offers the users and keys seen, by label. */
    const page = await (await getPage("/dashboard/audit-log", tokens.owner)).text();
    expect(page).toContain(`value="api_key:${key.id}"`);
    expect(page).toContain(`value="user:${ids.member}"`);
  });

  test("escapes hostile labels, user agents and metadata", async () => {
    const hostile = '<script>alert("x")</script>';
    const agent = '"><img src=x onerror=alert(1)>';
    await recordAuditEvent({
      action: "api_key.created",
      actor: { type: "api_key", id: "key_000000000000000000000001", label: hostile },
      userAgent: agent,
      target: { type: "api_key", id: "key_x", label: hostile },
      metadata: { isAdmin: false, allowedSenders: 0 },
    });
    const page = await (await getPage("/dashboard/audit-log", tokens.admin)).text();
    expect(page).not.toContain("<script>alert");
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;script&gt;");
    expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("pages newest first, without overlap", async () => {
    for (let n = 0; n < 5; n += 1) {
      await recordAuditEvent({
        action: "auth.logout",
        actor: { type: "user", id: ids.member },
        ip: `192.0.2.${10 + n}`,
      });
    }
    const first = await listAuditEvents({ page: 1, limit: 2 });
    const second = await listAuditEvents({ page: 2, limit: 2 });
    const third = await listAuditEvents({ page: 3, limit: 2 });
    expect(first.total).toBe(5);
    const seen = [...first.data, ...second.data, ...third.data].map((event) => event.id);
    expect(new Set(seen).size).toBe(5);
    expect(first.data[0]?.ip).toBe("192.0.2.14");
  });
});
