/**
 * Custom DKIM selector and zero-downtime key rotation (#250), over the
 * REST API and the dashboard against real Postgres, with TXT lookups
 * stubbed through the domains DNS seam (`setDomainDnsDeps`).
 *
 * Covers: a selector chosen on create (and a bad one refused), the full
 * rotation (start, mail still signed with the active key, complete refused
 * until the pending record is published, then the switch, the previous
 * selector, the audit trail), one pending rotation at a time, cancel, the
 * admin-only dashboard buttons, and that no private key ever leaves.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Elysia, ValidationError } from "elysia";
import { and, eq } from "drizzle-orm";
import { domainsPlugin } from "../../src/modules/domains/domains.plugin.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import {
  DkimRotationError,
  InvalidDkimSelectorError,
} from "../../src/modules/domains/errors.ts";
import { createDomain } from "../../src/modules/domains/services/domain.service.ts";
import {
  checkDkimKeyPublished,
  completeDkimRotation,
  startDkimRotation,
} from "../../src/modules/domains/services/dkim-rotation.service.ts";
import { dkimRecordValue } from "../../src/modules/domains/services/dkim-keys.ts";
import { setDomainDnsDeps } from "../../src/modules/domains/services/domain-dns-status.service.ts";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import type { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import { findUndecryptableDomainKeys } from "../../src/db/encrypt-domain-keys.ts";
import { auditEvents } from "../../src/modules/audit/models/audit-event.schema.ts";
import type { AuditContext } from "../../src/modules/audit/types/audit.types.ts";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from "../../src/utils/crypto.ts";
import { config } from "../../src/config.ts";
import { randomBytes } from "crypto";
import { truncateAll, seed, db, domains } from "./_helpers.ts";
import { readJson } from "../read-json.ts";
import { installHermeticDomainDns } from "./_dns-stub.ts";

/** Mirrors the VALIDATION, selector and rotation branches of the global onError. */
const api = new Elysia()
  .onError(({ error, code, set }) => {
    if (code === "VALIDATION" && error instanceof ValidationError) {
      set.status = 422;
      return {
        success: false,
        error: "Request validation failed",
        code: "VALIDATION_ERROR",
      };
    }
    if (error instanceof InvalidDkimSelectorError) {
      set.status = 422;
      return { success: false, error: error.message, code: error.code };
    }
    if (error instanceof DkimRotationError) {
      set.status = error.status;
      return { success: false, error: error.message, code: error.code };
    }
  })
  .use(domainsPlugin);

const pages = new Elysia().use(pagesPlugin);

interface DnsRecord {
  type: string;
  host: string;
  value: string;
  optional: boolean;
  pending?: boolean;
}

interface DomainData {
  id: string;
  name: string;
  dkimSelector: string;
  dkimDnsRecord: string | null;
  dkimPending: {
    selector: string;
    host: string;
    dnsRecord: string;
    createdAt: string | null;
  } | null;
  dkimPrevious: {
    selector: string;
    host: string;
    dnsRecord: string | null;
    rotatedAt: string | null;
    advice: string;
  } | null;
  dnsRecords: DnsRecord[];
}

interface ApiBody {
  success: boolean;
  data?: DomainData;
  dnsRecord?: DnsRecord | null;
  error?: string;
  code?: string;
}

/** TXT answers by name; anything else is NXDOMAIN. */
let txt: Record<string, string[][]> = {};

let adminKey = { id: "", rawKey: "" };

/** Every response body text seen, checked for key material at the end of a test. */
let bodies: string[] = [];

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiBody & { status: number }> {
  const res = await api.handle(
    new Request(`http://localhost/api/v1/domains${path}`, {
      method,
      headers: {
        authorization: `Bearer ${adminKey.rawKey}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  bodies.push(await res.clone().text());
  return { status: res.status, ...(await readJson<ApiBody>(res)) };
}

/** A same-origin dashboard request with a session cookie. */
function dash(
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { cookie: `bm_session=${token}` };
  const url = `http://localhost${path}`;
  if (method === "GET") return pages.handle(new Request(url, { headers }));
  headers["origin"] = "http://localhost";
  headers["content-type"] = "application/x-www-form-urlencoded";
  return pages.handle(
    new Request(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(body ?? {}).toString(),
    }),
  );
}

/** Publishes a TXT value the way DNS returns a long one: 255-character strings. */
function publish(host: string, value: string): void {
  const parts: string[] = [];
  for (let i = 0; i < value.length; i += 255) parts.push(value.slice(i, i + 255));
  txt[host] = [parts];
}

async function row(id: string) {
  const [r] = await db.select().from(domains).where(eq(domains.id, id));
  if (!r) throw new Error(`domain ${id} not found`);
  return r;
}

/** A mailer that records the DKIM options of each send. */
function recordingMailer(): {
  mailer: typeof sendMail;
  calls: Parameters<typeof sendMail>[0][];
} {
  const calls: Parameters<typeof sendMail>[0][] = [];
  const mailer: typeof sendMail = async (options) => {
    calls.push(options);
    return {
      messageId: options.messageId,
      deliveryState: {
        "mx.example.org": {
          status: "sent",
          recipients: ["user@example.org"],
          attempts: 1,
        },
      },
    };
  };
  return { mailer, calls };
}

/** Queues one email from `domain` and runs the queue: returns the DKIM options used. */
async function signWith(domainId: string, domainName: string) {
  const { id: apiKeyId } = await seed.apiKey();
  await seed.email({
    apiKeyId,
    domainId,
    fromAddress: `hello@${domainName}`,
    toAddress: "user@example.org",
  });
  const { mailer, calls } = recordingMailer();
  await runQueueCycle({ sendMail: mailer });
  expect(calls).toHaveLength(1);
  return calls[0]?.dkim;
}

async function auditRows(action: string) {
  return db.select().from(auditEvents).where(eq(auditEvents.action, action));
}

/** The UTC day of `now` as the dated selector spells it. */
function today(): string {
  return `bm${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
}

const systemAudit: AuditContext = {
  actor: { type: "system", label: "test" },
  ip: null,
  userAgent: null,
};

beforeEach(async () => {
  await truncateAll();
  txt = {};
  bodies = [];
  setDomainDnsDeps({
    resolveTxt: (name) => {
      const answer = txt[name];
      if (answer) return Promise.resolve(answer);
      return Promise.reject(Object.assign(new Error("nx"), { code: "ENOTFOUND" }));
    },
    resolveMx: () =>
      Promise.reject(Object.assign(new Error("nx"), { code: "ENOTFOUND" })),
    timeoutMs: 1000,
  });
  adminKey = await seed.apiKey({ name: "rotation key", isAdmin: true });
});

/** Back to the run-wide hermetic stub, never to real DNS. */
afterAll(() => {
  installHermeticDomainDns();
});

/** No response may carry a private key, pending or active, in any form. */
async function expectNoPrivateKeyIn(texts: string[], domainId: string): Promise<void> {
  const r = await row(domainId);
  const secrets = [r.dkimPrivateKey, r.dkimPendingPrivateKey].filter(
    (s): s is string => s !== null,
  );
  const plaintexts = secrets.map((s) =>
    isEncryptedSecret(s) ? decryptSecret(s, config.dkimEncryptionKey) : s,
  );
  /** The base64 body of each PEM, not just its armour. */
  const bodiesOf = plaintexts.map((pem) =>
    pem
      .replace(/-----[^-]+-----/g, "")
      .replace(/\s/g, "")
      .slice(0, 64),
  );
  for (const text of texts) {
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain("dkimPrivateKey");
    expect(text).not.toContain("dkimPendingPrivateKey");
    for (const secret of [...secrets, ...bodiesOf]) expect(text).not.toContain(secret);
  }
}

describe("DKIM selector on create (#250)", () => {
  test("a custom selector is stored and used for the DKIM record", async () => {
    const res = await call("POST", "", { name: "acme.io", dkimSelector: "mail-2026" });
    expect(res.status).toBe(200);
    expect(res.data?.dkimSelector).toBe("mail-2026");
    const dkim = res.data?.dnsRecords.find(
      (r) => r.host === "mail-2026._domainkey.acme.io",
    );
    expect(dkim?.type).toBe("TXT");
    expect((await row(res.data!.id)).dkimSelector).toBe("mail-2026");
  });

  test("without one the selector stays bunmail", async () => {
    const res = await call("POST", "", { name: "acme.io" });
    expect(res.data?.dkimSelector).toBe("bunmail");
  });

  test.each([
    ["uppercase", "Bunmail"],
    ["leading hyphen", "-mail"],
    ["trailing hyphen", "mail-"],
    ["a dot (two labels)", "a.b"],
    ["an underscore", "a_b"],
    ["empty", ""],
    ["64 characters", "a".repeat(64)],
  ])("%s is a 422 and creates nothing", async (_label, selector) => {
    const res = await call("POST", "", { name: "acme.io", dkimSelector: selector });
    expect(res.status).toBe(422);
    expect(await db.select().from(domains)).toHaveLength(0);
  });

  test("63 characters is accepted", async () => {
    const res = await call("POST", "", { name: "acme.io", dkimSelector: "a".repeat(63) });
    expect(res.status).toBe(200);
  });

  test("the service refuses a bad selector too (the dashboard path)", async () => {
    let caught: unknown;
    try {
      await createDomain({ name: "acme.io", dkimSelector: "Not Valid" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidDkimSelectorError);
    expect(await db.select().from(domains)).toHaveLength(0);
  });
});

describe("DKIM key rotation over REST (#250)", () => {
  test("start, still signed with the old key, complete refused until published, then switched", async () => {
    const created = await call("POST", "", { name: "acme.io" });
    const id = created.data!.id;
    const before = await row(id);
    const oldPrivate = decryptSecret(before.dkimPrivateKey!, config.dkimEncryptionKey);

    /* Start */
    const started = await call("POST", `/${id}/dkim/rotate`);
    expect(started.status).toBe(200);
    const selector = today();
    expect(started.data?.dkimPending?.selector).toBe(selector);
    expect(started.data?.dkimPending?.host).toBe(`${selector}._domainkey.acme.io`);
    expect(started.data?.dkimSelector).toBe("bunmail");
    expect(started.dnsRecord).toMatchObject({
      type: "TXT",
      host: `${selector}._domainkey.acme.io`,
      pending: true,
    });
    const pendingEntry = started.data?.dnsRecords.find((r) => r.pending === true);
    expect(pendingEntry?.value).toBe(started.dnsRecord?.value);
    /** The active record is still listed, unchanged. */
    expect(
      started.data?.dnsRecords.some((r) => r.host === "bunmail._domainkey.acme.io"),
    ).toBe(true);

    const pendingRow = await row(id);
    expect(pendingRow.dkimSelector).toBe("bunmail");
    expect(pendingRow.dkimPrivateKey).toBe(before.dkimPrivateKey);
    expect(isEncryptedSecret(pendingRow.dkimPendingPrivateKey!)).toBe(true);
    const newPrivate = decryptSecret(
      pendingRow.dkimPendingPrivateKey!,
      config.dkimEncryptionKey,
    );
    expect(newPrivate).toContain("BEGIN PRIVATE KEY");
    expect(newPrivate).not.toBe(oldPrivate);
    expect(pendingRow.dkimPendingCreatedAt).not.toBeNull();

    /* While pending, mail is signed with the active key and selector. */
    const whilePending = await signWith(id, "acme.io");
    expect(whilePending?.keySelector).toBe("bunmail");
    expect(whilePending?.privateKey).toBe(oldPrivate);

    await expectNoPrivateKeyIn(bodies, id);

    /* Complete before the record exists: refused, nothing changes. */
    const early = await call("POST", `/${id}/dkim/rotate/complete`);
    expect(early.status).toBe(409);
    expect(early.code).toBe("DKIM_PENDING_NOT_PUBLISHED");
    expect(early.error).toContain(`No TXT record at ${selector}._domainkey.acme.io`);
    expect((await row(id)).dkimPendingSelector).toBe(selector);
    expect((await row(id)).dkimSelector).toBe("bunmail");

    /* A record with another key: refused with the reason. */
    publish(`${selector}._domainkey.acme.io`, created.data!.dkimDnsRecord!);
    const wrong = await call("POST", `/${id}/dkim/rotate/complete`);
    expect(wrong.status).toBe(409);
    expect(wrong.code).toBe("DKIM_PENDING_NOT_PUBLISHED");
    expect(wrong.error).toContain("does not carry the pending public key");
    expect((await row(id)).dkimSelector).toBe("bunmail");

    /** Verify does not switch on its own. */
    publish(`${selector}._domainkey.acme.io`, started.data!.dkimPending!.dnsRecord);
    expect((await call("POST", `/${id}/verify`)).status).toBe(200);
    expect((await row(id)).dkimSelector).toBe("bunmail");

    /* Published: the switch. */
    const done = await call("POST", `/${id}/dkim/rotate/complete`);
    expect(done.status).toBe(200);
    expect(done.data?.dkimSelector).toBe(selector);
    expect(done.data?.dkimPending).toBeNull();
    expect(done.data?.dkimPrevious).toMatchObject({
      selector: "bunmail",
      host: "bunmail._domainkey.acme.io",
      dnsRecord: created.data!.dkimDnsRecord,
    });
    expect(done.data?.dkimPrevious?.advice).toContain("at least 7 days");
    expect(done.data?.dkimPrevious?.rotatedAt).not.toBeNull();
    expect(done.data?.dkimDnsRecord).toBe(started.data!.dkimPending!.dnsRecord);
    expect(done.data?.dnsRecords.some((r) => r.pending === true)).toBe(false);

    const switched = await row(id);
    expect(switched.dkimSelector).toBe(selector);
    expect(switched.dkimPrivateKey).toBe(pendingRow.dkimPendingPrivateKey);
    expect(switched.dkimPublicKey).toBe(pendingRow.dkimPendingPublicKey);
    expect(switched.dkimPreviousSelector).toBe("bunmail");
    expect(switched.dkimPreviousPublicKey).toBe(before.dkimPublicKey);
    expect(switched.dkimRotatedAt).not.toBeNull();
    expect(switched.dkimVerified).toBe(true);
    expect(switched.dkimPendingSelector).toBeNull();
    expect(switched.dkimPendingPrivateKey).toBeNull();
    expect(switched.dkimPendingPublicKey).toBeNull();
    expect(switched.dkimPendingCreatedAt).toBeNull();

    /* After the switch, mail is signed with the new key and selector. */
    const after = await signWith(id, "acme.io");
    expect(after?.keySelector).toBe(selector);
    expect(after?.privateKey).toBe(newPrivate);

    /* Audit: started and completed once each, selector only; refusals are not audited. */
    const startedEvents = await auditRows("domain.dkim_rotation_started");
    const completedEvents = await auditRows("domain.dkim_rotation_completed");
    expect(startedEvents).toHaveLength(1);
    expect(completedEvents).toHaveLength(1);
    for (const event of [...startedEvents, ...completedEvents]) {
      expect(event).toMatchObject({
        actorType: "api_key",
        actorId: adminKey.id,
        actorLabel: "rotation key",
        targetType: "domain",
        targetId: id,
        targetLabel: "acme.io",
        outcome: "success",
        metadata: { selector },
      });
    }

    await expectNoPrivateKeyIn(bodies, id);
  });

  test("a second rotation the same day takes the next dated selector, never the current one", async () => {
    const created = await call("POST", "", { name: "acme.io" });
    const id = created.data!.id;
    const first = await call("POST", `/${id}/dkim/rotate`);
    publish(first.data!.dkimPending!.host, first.data!.dkimPending!.dnsRecord);
    expect((await call("POST", `/${id}/dkim/rotate/complete`)).status).toBe(200);

    const second = await call("POST", `/${id}/dkim/rotate`);
    expect(second.status).toBe(200);
    expect(second.data?.dkimSelector).toBe(today());
    expect(second.data?.dkimPending?.selector).toBe(`${today()}-2`);
  });

  test("starting while one is pending is 409, and the pending key stays", async () => {
    const id = (await call("POST", "", { name: "acme.io" })).data!.id;
    expect((await call("POST", `/${id}/dkim/rotate`)).status).toBe(200);
    const pending = (await row(id)).dkimPendingPublicKey;

    const again = await call("POST", `/${id}/dkim/rotate`);
    expect(again.status).toBe(409);
    expect(again.code).toBe("DKIM_ROTATION_PENDING");
    expect((await row(id)).dkimPendingPublicKey).toBe(pending);
    expect(await auditRows("domain.dkim_rotation_started")).toHaveLength(1);
  });

  test("cancel drops the pending key and is audited; nothing pending is 409", async () => {
    const id = (await call("POST", "", { name: "acme.io" })).data!.id;
    const before = await row(id);
    const started = await call("POST", `/${id}/dkim/rotate`);
    const selector = started.data!.dkimPending!.selector;

    const cancelled = await call("DELETE", `/${id}/dkim/rotate`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.data?.dkimPending).toBeNull();
    expect(cancelled.data?.dkimSelector).toBe("bunmail");
    const r = await row(id);
    expect(r.dkimPendingSelector).toBeNull();
    expect(r.dkimPendingPrivateKey).toBeNull();
    expect(r.dkimPendingPublicKey).toBeNull();
    expect(r.dkimPendingCreatedAt).toBeNull();
    expect(r.dkimPrivateKey).toBe(before.dkimPrivateKey);
    expect(r.dkimPreviousSelector).toBeNull();

    const [event] = await auditRows("domain.dkim_rotation_cancelled");
    expect(event).toMatchObject({
      actorType: "api_key",
      targetId: id,
      metadata: { selector },
    });

    const again = await call("DELETE", `/${id}/dkim/rotate`);
    expect(again.status).toBe(409);
    expect(again.code).toBe("DKIM_NO_PENDING_ROTATION");
    const complete = await call("POST", `/${id}/dkim/rotate/complete`);
    expect(complete.status).toBe(409);
    expect(complete.code).toBe("DKIM_NO_PENDING_ROTATION");

    /** A new rotation can start after a cancel. */
    expect((await call("POST", `/${id}/dkim/rotate`)).status).toBe(200);
  });

  test("an unknown domain is 404 on every step", async () => {
    expect((await call("POST", "/dom_missing/dkim/rotate")).status).toBe(404);
    expect((await call("POST", "/dom_missing/dkim/rotate/complete")).status).toBe(404);
    expect((await call("DELETE", "/dom_missing/dkim/rotate")).status).toBe(404);
  });

  test("a restricted key is refused (admin-only)", async () => {
    const id = (await call("POST", "", { name: "acme.io" })).data!.id;
    const restricted = await seed.apiKey({ isAdmin: false });
    for (const [method, path] of [
      ["POST", `/${id}/dkim/rotate`],
      ["POST", `/${id}/dkim/rotate/complete`],
      ["DELETE", `/${id}/dkim/rotate`],
    ] as const) {
      const res = await api.handle(
        new Request(`http://localhost/api/v1/domains${path}`, {
          method,
          headers: { authorization: `Bearer ${restricted.rawKey}` },
        }),
      );
      expect(res.status).toBe(403);
    }
    expect((await row(id)).dkimPendingSelector).toBeNull();
  });
});

describe("the publish check (#250)", () => {
  test("a lookup failure is reported as temporary, not as a missing record", async () => {
    setDomainDnsDeps({
      resolveTxt: () =>
        Promise.reject(Object.assign(new Error("dns"), { code: "ESERVFAIL" })),
    });
    const check = await checkDkimKeyPublished(
      "acme.io",
      "s1",
      "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----",
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("failed (temporary)");
  });

  test("a pending key that does not decrypt cannot be completed", async () => {
    const created = await call("POST", "", { name: "acme.io" });
    const id = created.data!.id;
    const started = await startDkimRotation(id, systemAudit);
    await db
      .update(domains)
      .set({
        dkimPendingPrivateKey: encryptSecret(
          "-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----",
          randomBytes(32),
        ),
      })
      .where(eq(domains.id, id));
    publish(
      `${started!.dkimPendingSelector}._domainkey.acme.io`,
      dkimRecordValue(started!.dkimPendingPublicKey!),
    );

    let caught: unknown;
    try {
      await completeDkimRotation(id, systemAudit);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DkimRotationError);
    expect(caught instanceof DkimRotationError ? caught.code : "").toBe(
      "DKIM_PENDING_KEY_UNREADABLE",
    );
    expect((await row(id)).dkimSelector).toBe("bunmail");

    /** The boot check reports it apart from the active keys: it holds no mail. */
    expect(await findUndecryptableDomainKeys()).toEqual({
      active: [],
      pending: ["acme.io"],
    });
    const dkim = await signWith(id, "acme.io");
    expect(dkim?.keySelector).toBe("bunmail");
  });
});

describe("DKIM rotation from the dashboard (#250)", () => {
  async function sessionOf(
    role: "admin" | "member",
  ): Promise<{ id: string; token: string }> {
    const user = await seed.user({ email: `${role}@example.org`, role });
    const { token } = await seed.session({ userId: user.id });
    return { id: user.id, token };
  }

  test("an admin starts, completes and cancels; the page shows each state", async () => {
    const admin = await sessionOf("admin");
    const id = (await call("POST", "", { name: "acme.io" })).data!.id;

    const start = await dash("POST", `/dashboard/domains/${id}/dkim/rotate`, admin.token);
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toContain(`/dashboard/domains/${id}?flash=`);
    expect(start.headers.get("location")).toContain("flashType=success");
    const pending = await row(id);
    expect(pending.dkimPendingSelector).toBe(today());

    const page = await dash("GET", `/dashboard/domains/${id}`, admin.token);
    const html = await page.text();
    expect(html).toContain("Rotation pending");
    expect(html).toContain(`${today()}._domainkey.acme.io`);
    expect(html).toContain(`/dashboard/domains/${id}/dkim/rotate/complete`);
    expect(html).toContain("data-confirm=");
    expect(html).not.toContain("PRIVATE KEY");

    /** Not published yet: an error flash, nothing changes. */
    const early = await dash(
      "POST",
      `/dashboard/domains/${id}/dkim/rotate/complete`,
      admin.token,
    );
    expect(early.headers.get("location")).toContain("flashType=error");
    expect((await row(id)).dkimSelector).toBe("bunmail");

    publish(
      `${today()}._domainkey.acme.io`,
      dkimRecordValue(pending.dkimPendingPublicKey!),
    );
    const done = await dash(
      "POST",
      `/dashboard/domains/${id}/dkim/rotate/complete`,
      admin.token,
    );
    expect(done.headers.get("location")).toContain("flashType=success");
    expect((await row(id)).dkimSelector).toBe(today());

    const after = await (
      await dash("GET", `/dashboard/domains/${id}`, admin.token)
    ).text();
    expect(after).toContain("Previous selector");
    expect(after).toContain("at least 7 days");

    await dash("POST", `/dashboard/domains/${id}/dkim/rotate`, admin.token);
    const cancel = await dash(
      "POST",
      `/dashboard/domains/${id}/dkim/rotate/cancel`,
      admin.token,
    );
    expect(cancel.headers.get("location")).toContain("flashType=success");
    expect((await row(id)).dkimPendingSelector).toBeNull();

    const events = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorType, "user"), eq(auditEvents.actorId, admin.id)));
    expect(events.map((e) => e.action).toSorted()).toEqual([
      "domain.dkim_rotation_cancelled",
      "domain.dkim_rotation_completed",
      "domain.dkim_rotation_started",
      "domain.dkim_rotation_started",
    ]);
  });

  test("a member is refused on every rotation button and nothing changes", async () => {
    const member = await sessionOf("member");
    const id = (await call("POST", "", { name: "acme.io" })).data!.id;

    const start = await dash(
      "POST",
      `/dashboard/domains/${id}/dkim/rotate`,
      member.token,
    );
    expect(start.status).toBe(403);
    expect((await row(id)).dkimPendingSelector).toBeNull();

    await startDkimRotation(id, systemAudit);
    const pending = await row(id);
    publish(
      `${pending.dkimPendingSelector}._domainkey.acme.io`,
      dkimRecordValue(pending.dkimPendingPublicKey!),
    );
    for (const path of ["complete", "cancel"]) {
      const res = await dash(
        "POST",
        `/dashboard/domains/${id}/dkim/rotate/${path}`,
        member.token,
      );
      expect(res.status).toBe(403);
    }
    const r = await row(id);
    expect(r.dkimSelector).toBe("bunmail");
    expect(r.dkimPendingSelector).toBe(pending.dkimPendingSelector);
  });

  test("the add form takes a selector; a bad one is an error flash", async () => {
    const admin = await sessionOf("admin");
    const ok = await dash("POST", "/dashboard/domains", admin.token, {
      name: "acme.io",
      dkimSelector: "s2026",
    });
    expect(ok.headers.get("location")).not.toContain("flashType=error");
    const [created] = await db.select().from(domains);
    expect(created?.dkimSelector).toBe("s2026");

    const bad = await dash("POST", "/dashboard/domains", admin.token, {
      name: "other.io",
      dkimSelector: "Not_Valid",
    });
    expect(bad.headers.get("location")).toContain("flashType=error");
    expect(decodeURIComponent(bad.headers.get("location") ?? "")).toContain(
      "lowercase DNS label",
    );
    expect(await db.select().from(domains)).toHaveLength(1);

    const empty = await dash("POST", "/dashboard/domains", admin.token, {
      name: "third.io",
      dkimSelector: "",
    });
    expect(empty.headers.get("location")).not.toContain("flashType=error");
    const [third] = await db.select().from(domains).where(eq(domains.name, "third.io"));
    expect(third?.dkimSelector).toBe("bunmail");
  });
});
