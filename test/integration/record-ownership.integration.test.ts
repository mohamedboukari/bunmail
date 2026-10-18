/**
 * Who owns API keys, templates, domains and webhooks (#219), against real
 * Postgres:
 *
 * - the boot backfill: rows with no creator are assigned to the owner by
 *   `bootstrapOwner`, idempotently, also while setup is pending;
 * - the creator recorded on dashboard creates (the signed-in user) and
 *   REST creates (the calling key's creator; null stays null);
 * - member scoping of the API keys pages: own keys only, never an admin
 *   key, others' keys answer "not found", the admin toggle is refused;
 * - member scoping of template edit and delete (403 on others');
 * - deactivation and removal disable the user's keys (an API call with
 *   one is rejected), reactivation leaves them disabled, removal disables
 *   before the delete clears the creator;
 * - ownership transfer moves the old owner's records.
 */
import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { Elysia } from "elysia";
import { eq, inArray } from "drizzle-orm";
import {
  apiKeys,
  db,
  domains,
  emails,
  seed,
  templates,
  truncateAll,
  webhooks,
} from "./_helpers.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { withRequestContext } from "../../src/middleware/request-context.ts";
import { apiKeysPlugin } from "../../src/modules/api-keys/api-keys.plugin.ts";
import { templatesPlugin } from "../../src/modules/templates/templates.plugin.ts";
import { webhooksPlugin } from "../../src/modules/webhooks/webhooks.plugin.ts";
import { domainsPlugin } from "../../src/modules/domains/domains.plugin.ts";
import { emailsPlugin } from "../../src/modules/emails/emails.plugin.ts";
import { bootstrapOwner } from "../../src/modules/users/services/owner.service.ts";
import {
  createApiKey,
  findByHash,
} from "../../src/modules/api-keys/services/api-key.service.ts";
import { ApiKeyCreatorInactiveError } from "../../src/modules/api-keys/errors.ts";
import { inboundEmails } from "../../src/modules/inbound/models/inbound-email.schema.ts";
import { hashApiKey } from "../../src/utils/crypto.ts";
import {
  changeAccountRole,
  deactivateAccount,
  reactivateAccount,
  removeAccount,
  transferOwnership,
} from "../../src/modules/users/services/user-admin.service.ts";
import { users } from "../../src/modules/users/models/user.schema.ts";
import type {
  AttemptLimiter,
  UserRole,
} from "../../src/modules/users/types/user.types.ts";
import { logger } from "../../src/utils/logger.ts";

/** The dashboard as `src/index.ts` mounts it. */
const dashboard = new Elysia().wrap(withRequestContext).use(pagesPlugin);

/** The REST plugins that create records. */
const api = new Elysia()
  .use(emailsPlugin)
  .use(apiKeysPlugin)
  .use(templatesPlugin)
  .use(webhooksPlugin)
  .use(domainsPlugin);

const OWNER_EMAIL = "owner@example.com";
const PASSWORD = "correct horse battery staple";
const HOOK_URL = "https://93.184.216.34/hook";

/** A transfer budget that never limits. */
const NO_LIMIT: AttemptLimiter = {
  isLimited: () => false,
  record: () => undefined,
  clear: () => undefined,
};

type Name = "owner" | "admin" | "member" | "member2";
const NAMES: Name[] = ["owner", "admin", "member", "member2"];
const ROLE_OF: Record<Name, UserRole> = {
  owner: "owner",
  admin: "admin",
  member: "member",
  member2: "member",
};
const ids: Record<Name, string> = { owner: "", admin: "", member: "", member2: "" };
const tokens: Record<Name, string> = { owner: "", admin: "", member: "", member2: "" };

/** Seeds the four accounts with a live session each (the owner with a password). */
async function seedAccounts(): Promise<void> {
  for (const name of NAMES) {
    const { id } = await seed.user({
      email: `${name}@example.com`,
      role: ROLE_OF[name],
      ...(name === "owner" ? { password: PASSWORD } : {}),
    });
    ids[name] = id;
    tokens[name] = (await seed.session({ userId: id })).token;
  }
}

/** A same-origin dashboard request as `name`, with an optional form body. */
function page(
  method: "GET" | "POST",
  path: string,
  name: Name,
  body?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { cookie: `bm_session=${tokens[name]}` };
  const url = `http://localhost${path}`;
  if (method === "GET") return dashboard.handle(new Request(url, { headers }));
  headers["origin"] = "http://localhost";
  headers["content-type"] = "application/x-www-form-urlencoded";
  return dashboard.handle(
    new Request(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(body ?? {}).toString(),
    }),
  );
}

/** A REST request with a Bearer key and an optional JSON body. */
function rest(
  method: "GET" | "POST",
  path: string,
  rawKey: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  const headers = {
    authorization: `Bearer ${rawKey}`,
    "content-type": "application/json",
  };
  const url = `http://localhost${path}`;
  if (method === "GET") return api.handle(new Request(url, { headers }));
  return api.handle(
    new Request(url, { method: "POST", headers, body: JSON.stringify(body ?? {}) }),
  );
}

/** What `promise` rejected with, or null when it resolved. */
async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

/** The decoded `location` header of a redirect. */
function locationOf(response: Response): string {
  return decodeURIComponent(response.headers.get("location") ?? "");
}

/** A key's stored state. */
async function keyRow(id: string): Promise<{
  isActive: boolean;
  isAdmin: boolean;
  disabledReason: string | null;
  createdByUserId: string | null;
  allowedSenders: string[];
}> {
  const [row] = await db
    .select({
      isActive: apiKeys.isActive,
      isAdmin: apiKeys.isAdmin,
      disabledReason: apiKeys.disabledReason,
      createdByUserId: apiKeys.createdByUserId,
      allowedSenders: apiKeys.allowedSenders,
    })
    .from(apiKeys)
    .where(eq(apiKeys.id, id));
  if (!row) throw new Error(`no key ${id}`);
  return row;
}

/** The creator of every row of the four tables, keyed by row id. */
async function creators(): Promise<Record<string, string | null>> {
  const rows = [
    ...(await db.select({ id: apiKeys.id, by: apiKeys.createdByUserId }).from(apiKeys)),
    ...(await db
      .select({ id: templates.id, by: templates.createdByUserId })
      .from(templates)),
    ...(await db.select({ id: domains.id, by: domains.createdByUserId }).from(domains)),
    ...(await db
      .select({ id: webhooks.id, by: webhooks.createdByUserId })
      .from(webhooks)),
  ];
  return Object.fromEntries(rows.map((row) => [row.id, row.by]));
}

/** One record of each kind with the given creator; returns their ids. */
async function seedRecords(
  createdByUserId: string | null,
  tag: string,
): Promise<string[]> {
  const key = await seed.apiKey({ name: `key-${tag}`, createdByUserId });
  const template = await seed.template({ apiKeyId: key.id, createdByUserId });
  const domain = await seed.domain({ name: `${tag}.example.com`, createdByUserId });
  const webhook = await seed.webhook({
    apiKeyId: key.id,
    url: HOOK_URL,
    events: ["email.sent"],
    createdByUserId,
  });
  return [key.id, template.id, domain.id, webhook.id];
}

beforeEach(async () => {
  await truncateAll();
});

/* ─── Boot backfill ─── */

describe("Boot backfill (#219)", () => {
  test("legacy rows end up owned by the owner after one bootstrap; a second changes nothing", async () => {
    const owner = await seed.owner({ email: OWNER_EMAIL, password: PASSWORD });
    const member = await seed.user({ email: "member@example.com" });
    const legacy = await seedRecords(null, "legacy");
    const owned = await seedRecords(member.id, "owned");

    const info = spyOn(logger, "info");
    info.mockClear();
    try {
      expect((await bootstrapOwner(OWNER_EMAIL)).kind).toBe("complete");
      const after = await creators();
      for (const id of legacy) expect(after[id]).toBe(owner.id);
      for (const id of owned) expect(after[id]).toBe(member.id);
      const lines = info.mock.calls.filter(
        ([message]) => message === "Records without a creator assigned to the owner",
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]?.[1]).toEqual({
        ownerId: owner.id,
        records: { keys: 1, templates: 1, domains: 1, webhooks: 1 },
      });

      info.mockClear();
      expect((await bootstrapOwner(OWNER_EMAIL)).kind).toBe("complete");
      expect(await creators()).toEqual(after);
      expect(
        info.mock.calls.filter(
          ([message]) => message === "Records without a creator assigned to the owner",
        ),
      ).toHaveLength(0);
    } finally {
      info.mockRestore();
    }
  });

  test("works while the owner's setup is still pending", async () => {
    const owner = await seed.owner({ email: OWNER_EMAIL });
    const legacy = await seedRecords(null, "pending");
    expect((await bootstrapOwner(OWNER_EMAIL)).kind).toBe("reissued");
    const after = await creators();
    for (const id of legacy) expect(after[id]).toBe(owner.id);
  });

  test("the first boot of an upgrade creates the owner and links the legacy rows to it", async () => {
    const legacy = await seedRecords(null, "upgrade");
    expect((await bootstrapOwner(OWNER_EMAIL)).kind).toBe("created");
    const [owner] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "owner"));
    const after = await creators();
    for (const id of legacy) expect(after[id]).toBe(owner?.id ?? "missing");
  });

  test("with no owner row (email taken by a non-owner) nothing is assigned", async () => {
    await seed.user({ email: OWNER_EMAIL, role: "member" });
    const legacy = await seedRecords(null, "noowner");
    expect((await bootstrapOwner(OWNER_EMAIL)).kind).toBe("email-taken");
    const after = await creators();
    for (const id of legacy) expect(after[id]).toBeNull();
  });
});

/* ─── Creator recorded on create ─── */

describe("Creator recorded on create (#219)", () => {
  beforeEach(seedAccounts);

  test("dashboard creates record the signed-in user", async () => {
    /** Templates and webhooks are attached to an active API key. */
    await seed.apiKey({ name: "sender", isAdmin: true });

    expect(
      (await page("POST", "/dashboard/api-keys", "member", { name: "m-key" })).status,
    ).toBe(302);
    expect(
      (
        await page("POST", "/dashboard/templates", "member", {
          name: "m-tpl",
          subject: "s",
        })
      ).status,
    ).toBe(302);
    expect(
      (await page("POST", "/dashboard/domains", "admin", { name: "admin.example.com" }))
        .status,
    ).toBe(302);
    expect(
      (
        await page("POST", "/dashboard/webhooks", "admin", {
          url: HOOK_URL,
          events: "email.sent",
        })
      ).status,
    ).toBe(302);

    const [key] = await db
      .select({ by: apiKeys.createdByUserId })
      .from(apiKeys)
      .where(eq(apiKeys.name, "m-key"));
    const [template] = await db
      .select({ by: templates.createdByUserId })
      .from(templates)
      .where(eq(templates.name, "m-tpl"));
    const [domain] = await db
      .select({ by: domains.createdByUserId })
      .from(domains)
      .where(eq(domains.name, "admin.example.com"));
    const [webhook] = await db
      .select({ by: webhooks.createdByUserId })
      .from(webhooks)
      .where(eq(webhooks.url, HOOK_URL));
    expect(key?.by).toBe(ids.member);
    expect(template?.by).toBe(ids.member);
    expect(domain?.by).toBe(ids.admin);
    expect(webhook?.by).toBe(ids.admin);
  });

  test("REST creates inherit the calling key's creator", async () => {
    const { rawKey } = await seed.apiKey({
      name: "admin-of-member",
      isAdmin: true,
      createdByUserId: ids.admin,
    });

    const key = await rest("POST", "/api/v1/api-keys", rawKey, { name: "child" });
    const template = await rest("POST", "/api/v1/templates", rawKey, {
      name: "rest-tpl",
      subject: "s",
    });
    const webhook = await rest("POST", "/api/v1/webhooks", rawKey, {
      url: HOOK_URL,
      events: ["email.sent"],
    });
    const domain = await rest("POST", "/api/v1/domains", rawKey, {
      name: "rest.example.com",
    });
    for (const response of [key, template, webhook, domain]) {
      expect(response.status).toBe(200);
    }

    const after = await creators();
    const created = Object.entries(after).filter(([, by]) => by === ids.admin);
    /** The calling key itself plus the four new rows. */
    expect(created).toHaveLength(5);
  });

  test("a key with no creator (the owner's) creates rows with no creator", async () => {
    const { rawKey } = await seed.apiKey({ name: "legacy-admin", isAdmin: true });
    expect(
      (await rest("POST", "/api/v1/templates", rawKey, { name: "t", subject: "s" }))
        .status,
    ).toBe(200);
    const [template] = await db
      .select({ by: templates.createdByUserId })
      .from(templates)
      .where(eq(templates.name, "t"));
    expect(template?.by).toBeNull();
  });
});

/* ─── API keys: member scope ─── */

describe("API keys pages, member scope (#219)", () => {
  let mine = "";
  let theirs = "";
  let legacy = "";

  beforeEach(async () => {
    await seedAccounts();
    mine = (await seed.apiKey({ name: "member-key", createdByUserId: ids.member })).id;
    theirs = (await seed.apiKey({ name: "member2-key", createdByUserId: ids.member2 }))
      .id;
    legacy = (await seed.apiKey({ name: "legacy-key", isAdmin: true })).id;
  });

  test("a member lists only its own keys, without admin controls", async () => {
    const html = await (await page("GET", "/dashboard/api-keys", "member")).text();
    expect(html).toContain("member-key");
    expect(html).not.toContain("member2-key");
    expect(html).not.toContain("legacy-key");
    expect(html).not.toContain('name="isAdmin"');
    expect(html).not.toContain(`/dashboard/api-keys/${mine}/admin`);
  });

  test("admins and the owner list every key, with who created it", async () => {
    for (const name of ["admin", "owner"] as const) {
      const html = await (await page("GET", "/dashboard/api-keys", name)).text();
      for (const keyName of ["member-key", "member2-key", "legacy-key"]) {
        expect(html).toContain(keyName);
      }
      expect(html).toContain("member@example.com");
      expect(html).toContain('name="isAdmin"');
    }
  });

  test("a member's crafted isAdmin=on still creates a restricted key of its own", async () => {
    const response = await page("POST", "/dashboard/api-keys", "member", {
      name: "sneaky",
      isAdmin: "on",
    });
    expect(response.status).toBe(302);
    const [row] = await db
      .select({ isAdmin: apiKeys.isAdmin, by: apiKeys.createdByUserId })
      .from(apiKeys)
      .where(eq(apiKeys.name, "sneaky"));
    expect(row).toEqual({ isAdmin: false, by: ids.member });
  });

  test("an admin can still create an admin key", async () => {
    await page("POST", "/dashboard/api-keys", "admin", { name: "ops", isAdmin: "on" });
    const [row] = await db
      .select({ isAdmin: apiKeys.isAdmin, by: apiKeys.createdByUserId })
      .from(apiKeys)
      .where(eq(apiKeys.name, "ops"));
    expect(row).toEqual({ isAdmin: true, by: ids.admin });
  });

  test("a member cannot revoke, edit or toggle another's key: not found or 403, nothing changes", async () => {
    for (const target of [theirs, legacy]) {
      const before = await keyRow(target);
      const revoke = await page("POST", `/dashboard/api-keys/${target}/revoke`, "member");
      expect(revoke.status).toBe(302);
      expect(locationOf(revoke)).toContain("API key not found");
      const senders = await page(
        "POST",
        `/dashboard/api-keys/${target}/senders`,
        "member",
        {
          allowedSenders: "x@example.com",
        },
      );
      expect(locationOf(senders)).toContain("API key not found");
      const toggle = await page("POST", `/dashboard/api-keys/${target}/admin`, "member", {
        isAdmin: "true",
      });
      expect(toggle.status).toBe(403);
      expect(await keyRow(target)).toEqual(before);
    }
    /** The same answer as a key that does not exist: no existence leak. */
    const ghost = await page("POST", "/dashboard/api-keys/key_nope/revoke", "member");
    expect(locationOf(ghost)).toBe(
      locationOf(await page("POST", `/dashboard/api-keys/${theirs}/revoke`, "member")),
    );
  });

  test("a member manages its own key: senders, then revoke", async () => {
    const senders = await page("POST", `/dashboard/api-keys/${mine}/senders`, "member", {
      allowedSenders: "Hello@Example.com",
    });
    expect(locationOf(senders)).toContain("Allowed senders updated");
    const revoke = await page("POST", `/dashboard/api-keys/${mine}/revoke`, "member");
    expect(locationOf(revoke)).toContain("API key revoked");
    expect(await keyRow(mine)).toMatchObject({
      isActive: false,
      disabledReason: "revoked",
      allowedSenders: ["hello@example.com"],
    });
  });

  test("an admin revokes anyone's key", async () => {
    await page("POST", `/dashboard/api-keys/${theirs}/revoke`, "admin");
    expect((await keyRow(theirs)).isActive).toBe(false);
  });
});

/* ─── Templates: member scope ─── */

describe("Template edit and delete, member scope (#219)", () => {
  let mine = "";
  let theirs = "";
  let legacy = "";

  beforeEach(async () => {
    await seedAccounts();
    const key = await seed.apiKey({ name: "k" });
    mine = (
      await seed.template({ apiKeyId: key.id, name: "mine", createdByUserId: ids.member })
    ).id;
    theirs = (
      await seed.template({
        apiKeyId: key.id,
        name: "theirs",
        createdByUserId: ids.member2,
      })
    ).id;
    legacy = (await seed.template({ apiKeyId: key.id, name: "legacy" })).id;
  });

  /** The stored name of a template, or null when it is gone. */
  async function nameOf(id: string): Promise<string | null> {
    const [row] = await db
      .select({ name: templates.name })
      .from(templates)
      .where(eq(templates.id, id));
    return row?.name ?? null;
  }

  test("a member edits and deletes its own template", async () => {
    const edit = await page("POST", `/dashboard/templates/${mine}/edit`, "member", {
      name: "renamed",
    });
    expect(locationOf(edit)).toContain("Template updated");
    expect(await nameOf(mine)).toBe("renamed");
    const del = await page("POST", `/dashboard/templates/${mine}/delete`, "member");
    expect(locationOf(del)).toContain("Template deleted");
    expect(await nameOf(mine)).toBeNull();
  });

  test("a member gets 403 on another's (or the owner's) template, and nothing changes", async () => {
    for (const target of [theirs, legacy]) {
      const before = await nameOf(target);
      const edit = await page("POST", `/dashboard/templates/${target}/edit`, "member", {
        name: "hijacked",
      });
      expect(edit.status).toBe(403);
      const del = await page("POST", `/dashboard/templates/${target}/delete`, "member");
      expect(del.status).toBe(403);
      expect(await nameOf(target)).toBe(before);
    }
  });

  test("the detail page is read-only for a member on another's template", async () => {
    const html = await (
      await page("GET", `/dashboard/templates/${theirs}`, "member")
    ).text();
    expect(html).toContain("Read-only");
    expect(html).not.toContain(`/dashboard/templates/${theirs}/delete`);
    /** A member sees a nameless creator's email masked (#219). */
    expect(html).toContain("m***@example.com");
    expect(html).not.toContain("member2@example.com");
  });

  test("admins and the owner edit and delete any template", async () => {
    const edit = await page("POST", `/dashboard/templates/${theirs}/edit`, "admin", {
      name: "by-admin",
    });
    expect(locationOf(edit)).toContain("Template updated");
    const del = await page("POST", `/dashboard/templates/${legacy}/delete`, "owner");
    expect(locationOf(del)).toContain("Template deleted");
    expect(await nameOf(theirs)).toBe("by-admin");
    expect(await nameOf(legacy)).toBeNull();
  });
});

/* ─── Deactivation, reactivation, removal ─── */

describe("Account lifecycle and API keys (#219)", () => {
  beforeEach(seedAccounts);

  test("deactivation disables the user's active keys; an API call with one is rejected", async () => {
    const live = await seed.apiKey({ name: "live", createdByUserId: ids.member });
    const revoked = await seed.apiKey({
      name: "old",
      createdByUserId: ids.member,
      isActive: false,
      disabledReason: "revoked",
    });
    const other = await seed.apiKey({ name: "other", createdByUserId: ids.member2 });
    expect((await rest("GET", "/api/v1/templates", live.rawKey)).status).toBe(200);

    const info = spyOn(logger, "info");
    info.mockClear();
    try {
      expect(await deactivateAccount(ids.admin, ids.member)).toEqual({ ok: true });
      const line = info.mock.calls.find(([message]) => message === "Account deactivated");
      expect(line?.[1]).toMatchObject({ targetUserId: ids.member, keysDisabled: 1 });
    } finally {
      info.mockRestore();
    }

    expect(await keyRow(live.id)).toMatchObject({
      isActive: false,
      disabledReason: "creator_deactivated",
    });
    expect((await keyRow(revoked.id)).disabledReason).toBe("revoked");
    expect((await keyRow(other.id)).isActive).toBe(true);
    expect((await rest("GET", "/api/v1/templates", live.rawKey)).status).toBe(401);

    const html = await (await page("GET", "/dashboard/api-keys", "admin")).text();
    expect(html).toContain("Disabled: creator deactivated");

    /** Reactivation does not re-enable the keys. */
    expect(await reactivateAccount(ids.admin, ids.member)).toEqual({ ok: true });
    expect(await keyRow(live.id)).toMatchObject({
      isActive: false,
      disabledReason: "creator_deactivated",
    });
    expect((await rest("GET", "/api/v1/templates", live.rawKey)).status).toBe(401);
  });

  test("removal disables the keys, then the delete clears their creator", async () => {
    const live = await seed.apiKey({ name: "live", createdByUserId: ids.member });
    const records = await seedRecords(ids.member, "removed");

    const info = spyOn(logger, "info");
    info.mockClear();
    try {
      expect(await removeAccount(ids.owner, ids.member, "member@example.com")).toEqual({
        ok: true,
      });
      const line = info.mock.calls.find(([message]) => message === "Account removed");
      /** `live` and the key from `seedRecords`. */
      expect(line?.[1]).toMatchObject({ targetUserId: ids.member, keysDisabled: 2 });
    } finally {
      info.mockRestore();
    }

    const keys = await db
      .select({
        isActive: apiKeys.isActive,
        reason: apiKeys.disabledReason,
        by: apiKeys.createdByUserId,
      })
      .from(apiKeys)
      .where(inArray(apiKeys.id, [live.id, records[0] ?? ""]));
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).toEqual({ isActive: false, reason: "creator_removed", by: null });
    }
    const after = await creators();
    for (const id of records) expect(after[id]).toBeNull();
    expect((await rest("GET", "/api/v1/templates", live.rawKey)).status).toBe(401);

    const html = await (await page("GET", "/dashboard/api-keys", "owner")).text();
    expect(html).toContain("Disabled: creator removed");
  });
});

/* ─── Ownership transfer ─── */

describe("Ownership transfer moves records (#219)", () => {
  beforeEach(seedAccounts);

  test("the old owner's records and unowned rows move to the new owner; others stay", async () => {
    const ownerRecords = await seedRecords(ids.owner, "owner");
    const legacyRecords = await seedRecords(null, "legacy");
    const memberRecords = await seedRecords(ids.member, "member");

    const info = spyOn(logger, "info");
    info.mockClear();
    try {
      expect(await transferOwnership(ids.owner, ids.admin, PASSWORD, NO_LIMIT)).toEqual({
        ok: true,
      });
      const line = info.mock.calls.find(
        ([message]) => message === "Ownership transferred",
      );
      expect(line?.[1]).toMatchObject({
        recordsMoved: { templates: 2, domains: 2, webhooks: 2 },
      });
    } finally {
      info.mockRestore();
    }

    const after = await creators();
    /** seedRecords returns [key, template, domain, webhook]: keys never move. */
    const [ownerKey, ...ownerContent] = ownerRecords;
    const [legacyKey, ...legacyContent] = legacyRecords;
    for (const id of [...ownerContent, ...legacyContent])
      expect(after[id]).toBe(ids.admin);
    expect(after[ownerKey ?? ""]).toBe(ids.owner);
    expect(after[legacyKey ?? ""]).toBeNull();
    for (const id of memberRecords) expect(after[id]).toBe(ids.member);
  });

  test("the former owner's admin key stays reachable: demotion restricts it, deactivation disables it", async () => {
    const key = await seed.apiKey({
      name: "a-ops",
      isAdmin: true,
      createdByUserId: ids.owner,
    });
    expect(await transferOwnership(ids.owner, ids.admin, PASSWORD, NO_LIMIT)).toEqual({
      ok: true,
    });
    expect(await keyRow(key.id)).toMatchObject({
      isAdmin: true,
      isActive: true,
      createdByUserId: ids.owner,
    });

    /** The new owner demotes the former owner (now an admin). */
    expect(await changeAccountRole(ids.admin, ids.owner, "member")).toEqual({ ok: true });
    expect(await keyRow(key.id)).toMatchObject({ isAdmin: false, isActive: true });

    expect(await deactivateAccount(ids.admin, ids.owner)).toEqual({ ok: true });
    expect(await keyRow(key.id)).toMatchObject({
      isActive: false,
      disabledReason: "creator_deactivated",
    });
    expect((await rest("GET", "/api/v1/templates", key.rawKey)).status).toBe(401);
  });
});

/* ─── Demotion and the send page ─── */

describe("Demotion restricts the user's admin keys (#219)", () => {
  beforeEach(seedAccounts);

  test("an admin demoted to member: its admin key becomes restricted but still sends; its other key is untouched", async () => {
    await seed.domain({ name: "example.com" });
    const adminKey = await seed.apiKey({
      name: "ops",
      isAdmin: true,
      createdByUserId: ids.admin,
    });
    const sendKey = await seed.apiKey({ name: "app", createdByUserId: ids.admin });
    const otherAdminKey = await seed.apiKey({
      name: "owner-ops",
      isAdmin: true,
      createdByUserId: ids.owner,
    });
    expect((await rest("GET", "/api/v1/api-keys", adminKey.rawKey)).status).toBe(200);
    const sendBefore = await keyRow(sendKey.id);

    const info = spyOn(logger, "info");
    info.mockClear();
    try {
      expect(await changeAccountRole(ids.owner, ids.admin, "member")).toEqual({
        ok: true,
      });
      const line = info.mock.calls.find(
        ([message]) => message === "Account role changed",
      );
      expect(line?.[1]).toMatchObject({
        targetUserId: ids.admin,
        newRole: "member",
        adminKeysDowngraded: 1,
      });
    } finally {
      info.mockRestore();
    }

    expect(await keyRow(adminKey.id)).toMatchObject({ isActive: true, isAdmin: false });
    expect(await keyRow(sendKey.id)).toEqual(sendBefore);
    expect((await keyRow(otherAdminKey.id)).isAdmin).toBe(true);

    /** The management plane now refuses it... */
    expect((await rest("GET", "/api/v1/api-keys", adminKey.rawKey)).status).toBe(403);
    /** ...but it still sends. */
    const sent = await rest("POST", "/api/v1/emails/send", adminKey.rawKey, {
      from: "hello@example.com",
      to: "user@example.org",
      subject: "still works",
      text: "hi",
    });
    expect(sent.status).toBe(200);
    const queued = await db
      .select({ id: emails.id })
      .from(emails)
      .where(eq(emails.apiKeyId, adminKey.id));
    expect(queued).toHaveLength(1);
  });

  test("a promotion restores no admin key, and a transfer changes no key", async () => {
    const key = await seed.apiKey({
      name: "ops",
      isAdmin: true,
      createdByUserId: ids.admin,
    });
    await changeAccountRole(ids.owner, ids.admin, "member");
    await changeAccountRole(ids.owner, ids.admin, "admin");
    expect((await keyRow(key.id)).isAdmin).toBe(false);

    const ownerKey = await seed.apiKey({
      name: "owner-ops",
      isAdmin: true,
      createdByUserId: ids.owner,
    });
    expect(await transferOwnership(ids.owner, ids.admin, PASSWORD, NO_LIMIT)).toEqual({
      ok: true,
    });
    expect(await keyRow(ownerKey.id)).toMatchObject({ isActive: true, isAdmin: true });
  });
});

describe("Send page: a member sends only with its own keys (#219)", () => {
  let mine = "";

  beforeEach(async () => {
    await seedAccounts();
    mine = (await seed.apiKey({ name: "member-send-key", createdByUserId: ids.member }))
      .id;
    await seed.apiKey({ name: "member2-send-key", createdByUserId: ids.member2 });
    await seed.apiKey({
      name: "admin-send-key",
      isAdmin: true,
      createdByUserId: ids.admin,
    });
    await seed.apiKey({ name: "owner-legacy-key", isAdmin: true });
  });

  /** The send form fields with the given key. */
  function sendForm(apiKeyId: string): Record<string, string> {
    return {
      apiKeyId,
      from: "hello@example.com",
      to: "user@example.org",
      subject: "hi",
      text: "hi",
    };
  }

  /** Number of emails queued with a key. */
  async function sentWith(apiKeyId: string): Promise<number> {
    const rows = await db
      .select({ id: emails.id })
      .from(emails)
      .where(eq(emails.apiKeyId, apiKeyId));
    return rows.length;
  }

  test("a member's picker lists only its own keys; an admin's lists every active key", async () => {
    const memberHtml = await (await page("GET", "/dashboard/send", "member")).text();
    expect(memberHtml).toContain("member-send-key");
    for (const other of ["member2-send-key", "admin-send-key", "owner-legacy-key"]) {
      expect(memberHtml).not.toContain(other);
    }
    const adminHtml = await (await page("GET", "/dashboard/send", "admin")).text();
    for (const name of [
      "member-send-key",
      "member2-send-key",
      "admin-send-key",
      "owner-legacy-key",
    ]) {
      expect(adminHtml).toContain(name);
    }
  });

  test("a member's crafted POST with any other key is refused and sends nothing", async () => {
    const others = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(
        inArray(apiKeys.name, ["member2-send-key", "admin-send-key", "owner-legacy-key"]),
      );
    expect(others).toHaveLength(3);
    const warn = spyOn(logger, "warn");
    warn.mockClear();
    try {
      for (const { id } of others) {
        const response = await page("POST", "/dashboard/send", "member", sendForm(id));
        expect(response.status).toBe(302);
        expect(locationOf(response)).toContain("Selected API key is not available");
        expect(await sentWith(id)).toBe(0);
      }
      const refusals = warn.mock.calls.filter(
        ([message]) =>
          message === "Dashboard send refused: API key not available to the user",
      );
      expect(refusals).toHaveLength(3);
    } finally {
      warn.mockRestore();
    }
  });

  test("a member sends with its own key; an admin with anyone's", async () => {
    await seed.domain({ name: "example.com" });
    const own = await page("POST", "/dashboard/send", "member", sendForm(mine));
    expect(locationOf(own)).toContain("Email queued for delivery");
    expect(await sentWith(mine)).toBe(1);
    const byAdmin = await page("POST", "/dashboard/send", "admin", sendForm(mine));
    expect(locationOf(byAdmin)).toContain("Email queued for delivery");
    expect(await sentWith(mine)).toBe(2);
  });
});

/* ─── Security review fixes ─── */

describe("Promoting a key needs an admin creator (#219)", () => {
  beforeEach(seedAccounts);

  test("a member's key cannot be made admin; an admin's and the owner's can", async () => {
    const memberKey = await seed.apiKey({ name: "m", createdByUserId: ids.member });
    const adminKey = await seed.apiKey({ name: "a", createdByUserId: ids.admin });
    const legacyKey = await seed.apiKey({ name: "l" });

    const refused = await page(
      "POST",
      `/dashboard/api-keys/${memberKey.id}/admin`,
      "owner",
      {
        isAdmin: "true",
      },
    );
    expect(locationOf(refused)).toContain(
      "Only keys of an active admin or the owner can be made admin",
    );
    expect((await keyRow(memberKey.id)).isAdmin).toBe(false);

    for (const id of [adminKey.id, legacyKey.id]) {
      const ok = await page("POST", `/dashboard/api-keys/${id}/admin`, "owner", {
        isAdmin: "true",
      });
      expect(locationOf(ok)).toContain("Key promoted to admin");
      expect((await keyRow(id)).isAdmin).toBe(true);
    }

    /** A deactivated admin's key is refused too; demotion always works. */
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, ids.admin));
    await page("POST", `/dashboard/api-keys/${adminKey.id}/admin`, "owner", {
      isAdmin: "false",
    });
    const again = await page(
      "POST",
      `/dashboard/api-keys/${adminKey.id}/admin`,
      "owner",
      {
        isAdmin: "true",
      },
    );
    expect(locationOf(again)).toContain("Only keys of an active admin");
    expect((await keyRow(adminKey.id)).isAdmin).toBe(false);

    const html = await (await page("GET", "/dashboard/api-keys", "owner")).text();
    expect(html).not.toContain(`/dashboard/api-keys/${memberKey.id}/admin`);
    expect(html).toContain(`/dashboard/api-keys/${legacyKey.id}/admin`);
  });
});

describe("Dashboard creates use the user's own key (#219)", () => {
  beforeEach(seedAccounts);

  /** The `api_key_id` of the template named `name`. */
  async function templateKey(name: string): Promise<string | undefined> {
    const [row] = await db
      .select({ key: templates.apiKeyId })
      .from(templates)
      .where(eq(templates.name, name));
    return row?.key;
  }

  test("a member without a key of its own gets 'Create an API key first'", async () => {
    await seed.apiKey({ name: "admin-key", isAdmin: true, createdByUserId: ids.admin });
    const response = await page("POST", "/dashboard/templates", "member", {
      name: "t",
      subject: "s",
    });
    expect(locationOf(response)).toContain("Create an API key first");
    expect(await templateKey("t")).toBeUndefined();
  });

  test("a member's template uses its own key; an admin prefers its own, else any", async () => {
    await seed.apiKey({ name: "admin-key", isAdmin: true, createdByUserId: ids.admin });
    const memberKey = await seed.apiKey({
      name: "member-key",
      createdByUserId: ids.member,
    });
    await page("POST", "/dashboard/templates", "member", {
      name: "by-member",
      subject: "s",
    });
    expect(await templateKey("by-member")).toBe(memberKey.id);

    /** The owner has no key: falls back to the oldest active key of anyone. */
    await page("POST", "/dashboard/templates", "owner", {
      name: "by-owner",
      subject: "s",
    });
    const [oldest] = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.name, "admin-key"));
    expect(await templateKey("by-owner")).toBe(oldest?.id);

    const ownerKey = await seed.apiKey({ name: "owner-key", createdByUserId: ids.owner });
    await page("POST", "/dashboard/templates", "owner", {
      name: "by-owner-2",
      subject: "s",
    });
    expect(await templateKey("by-owner-2")).toBe(ownerKey.id);
  });

  test("an admin's webhook uses its own key when it has one", async () => {
    await seed.apiKey({ name: "member-key", createdByUserId: ids.member });
    const adminKey = await seed.apiKey({ name: "admin-key", createdByUserId: ids.admin });
    await page("POST", "/dashboard/webhooks", "admin", {
      url: HOOK_URL,
      events: "email.sent",
    });
    const [hook] = await db
      .select({ key: webhooks.apiKeyId })
      .from(webhooks)
      .where(eq(webhooks.url, HOOK_URL));
    expect(hook?.key).toBe(adminKey.id);
  });

  test("with no key at all, a webhook create says 'Create an API key first'", async () => {
    const response = await page("POST", "/dashboard/webhooks", "admin", {
      url: HOOK_URL,
      events: "email.sent",
    });
    expect(locationOf(response)).toContain("Create an API key first");
  });
});

describe("Key creation against the creator's live state (#219)", () => {
  beforeEach(seedAccounts);

  test("a create for a deactivated creator is refused (dashboard race and REST)", async () => {
    await deactivateAccount(ids.owner, ids.member);
    const warn = spyOn(logger, "warn");
    warn.mockClear();
    try {
      expect(
        await errorOf(createApiKey({ name: "late" }, { id: ids.member, role: "member" })),
      ).toBeInstanceOf(ApiKeyCreatorInactiveError);
      expect(
        await errorOf(createApiKey({ name: "late-rest", createdByUserId: ids.member })),
      ).toBeInstanceOf(ApiKeyCreatorInactiveError);
      expect(
        warn.mock.calls.filter(
          ([message]) =>
            message === "API key create refused: creator missing or deactivated",
        ),
      ).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
    const rows = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(inArray(apiKeys.name, ["late", "late-rest"]));
    expect(rows).toHaveLength(0);
  });

  test("admin is decided by the creator's live role, not the session's", async () => {
    /** A session that still says admin, for an account now a member. */
    const { apiKey } = await createApiKey(
      { name: "stale-admin", isAdmin: true },
      { id: ids.member, role: "admin" },
    );
    expect(apiKey.isAdmin).toBe(false);
    const { apiKey: real } = await createApiKey(
      { name: "real-admin", isAdmin: true },
      { id: ids.admin, role: "admin" },
    );
    expect(real.isAdmin).toBe(true);
  });

  test("a key of a deactivated creator is rejected by the API and SMTP lookup even if still active", async () => {
    const key = await seed.apiKey({ name: "zombie", createdByUserId: ids.member });
    expect((await rest("GET", "/api/v1/templates", key.rawKey)).status).toBe(200);
    /** Disable the account without touching the key (is_active stays true). */
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, ids.member));
    expect((await keyRow(key.id)).isActive).toBe(true);
    expect((await rest("GET", "/api/v1/templates", key.rawKey)).status).toBe(401);
    expect(await findByHash(hashApiKey(key.rawKey))).toBeUndefined();

    /** A key with no creator (the owner's) is unaffected. */
    const legacy = await seed.apiKey({ name: "legacy" });
    expect((await rest("GET", "/api/v1/templates", legacy.rawKey)).status).toBe(200);
  });
});

describe("Member-facing key lists are scoped (#219)", () => {
  let mine = "";
  let theirs = "";
  const inboundId = "inb_record_ownership";

  beforeEach(async () => {
    await seedAccounts();
    theirs = (await seed.apiKey({ name: "zz-admin-key", createdByUserId: ids.admin })).id;
    mine = (await seed.apiKey({ name: "member-own-key", createdByUserId: ids.member }))
      .id;
    await db.delete(inboundEmails).where(eq(inboundEmails.id, inboundId));
    await db.insert(inboundEmails).values({
      id: inboundId,
      fromAddress: "someone@example.org",
      toAddress: "hello@example.com",
      subject: "question",
      textContent: "hi",
    });
  });

  test("the emails filter, suppressions filter and inbound reply list only the member's keys", async () => {
    for (const path of [
      "/dashboard/emails",
      "/dashboard/suppressions",
      `/dashboard/inbound/${inboundId}/reply`,
    ]) {
      const html = await (await page("GET", path, "member")).text();
      expect({ path, own: html.includes("member-own-key") }).toEqual({ path, own: true });
      expect({ path, other: html.includes("zz-admin-key") }).toEqual({
        path,
        other: false,
      });
    }
    /** The reply form preselects a key the member may send with. */
    const reply = await (
      await page("GET", `/dashboard/inbound/${inboundId}/reply`, "member")
    ).text();
    expect(reply).toMatch(new RegExp(`value="${mine}"[^>]*selected`));
    expect(reply).not.toContain(theirs);

    const adminHtml = await (await page("GET", "/dashboard/emails", "admin")).text();
    expect(adminHtml).toContain("zz-admin-key");
    await db.delete(inboundEmails).where(eq(inboundEmails.id, inboundId));
  });
});

describe("Created by labels (#219)", () => {
  beforeEach(seedAccounts);

  test("a member sees a nameless creator's email masked, an admin the full address", async () => {
    const key = await seed.apiKey({ name: "k" });
    await seed.template({ apiKeyId: key.id, name: "x", createdByUserId: ids.admin });
    const memberHtml = await (await page("GET", "/dashboard/templates", "member")).text();
    expect(memberHtml).toContain("a***@example.com");
    expect(memberHtml).not.toContain("admin@example.com");
    const adminHtml = await (await page("GET", "/dashboard/templates", "owner")).text();
    expect(adminHtml).toContain("admin@example.com");

    /** A display name is shown as is to everyone. */
    await db.update(users).set({ name: "Ada" }).where(eq(users.id, ids.admin));
    expect(await (await page("GET", "/dashboard/templates", "member")).text()).toContain(
      "Ada",
    );
  });
});
