/**
 * Scheduled DNS re-verification of domains (#250) against a real Postgres,
 * with DNS driven per test through `setDomainDnsDeps` (the hermetic stub of
 * `_dns-stub.ts` is put back afterwards) and SPF evaluation injected.
 *
 * Covers the claim (exclusive across concurrent claims, skips locked rows
 * instead of waiting), the schedule, the failure rule (one failure counts,
 * two flip a verified domain in one transaction with its
 * `domain.verification_failed` outbox row, a DNS error never counts),
 * recovery, the `REQUIRE_VERIFIED_DOMAIN` gate after a flip, manual Verify
 * and the disabled loop.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { eq, sql } from "drizzle-orm";
import { config } from "../../src/config.ts";
import { domainsPlugin } from "../../src/modules/domains/domains.plugin.ts";
import {
  resolveDomainTxt,
  setDomainDnsDeps,
} from "../../src/modules/domains/services/domain-dns-status.service.ts";
import {
  verifyDomain,
  type VerificationDeps,
} from "../../src/modules/domains/services/dns-verification.service.ts";
import {
  claimDueDomains,
  isRunning,
  runReverifyCycle,
  start,
  stop,
} from "../../src/modules/domains/services/domain-reverify.service.ts";
import { checkSenderDomain } from "../../src/modules/emails/services/sender-domain.service.ts";
import { SenderDomainUnverifiedError } from "../../src/modules/emails/errors.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import type { Domain } from "../../src/modules/domains/types/domain.types.ts";
import {
  truncateAll,
  seed,
  db,
  domains,
  failWritesWhere,
  removeInjectedFailures,
} from "./_helpers.ts";
import { installHermeticDomainDns } from "./_dns-stub.ts";
import { readJson } from "../read-json.ts";

const HOUR_MS = 60 * 60 * 1000;
const PUBLIC_KEY_PEM = "-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----";

/** TXT answers by name; a name in `txtErrors` fails with that code; else NXDOMAIN. */
let txt: Record<string, string[][]> = {};
let txtErrors: Record<string, string> = {};

/** SPF for every sending IP: the injected evaluation result. */
let spfResult = "pass";

/** Verification deps of the loop: the DNS seam above and a fixed sending IP. */
const verification: VerificationDeps = {
  resolveTxt: resolveDomainTxt,
  evaluateSpf: () => Promise.resolve(spfResult),
  sendingIps: () => Promise.resolve({ ips: ["203.0.113.10"], source: "MAIL_PUBLIC_IP" }),
};

/** Publishes correct SPF, DKIM and DMARC records for `name`. */
function publishAll(name: string): void {
  txt[name] = [["v=spf1 ip4:203.0.113.10 -all"]];
  txt[`bunmail._domainkey.${name}`] = [["v=DKIM1; k=rsa; p=FAKE"]];
  txt[`_dmarc.${name}`] = [["v=DMARC1; p=reject"]];
}

/** Every TXT lookup of `name` fails with SERVFAIL: unknown, not a failure. */
function breakDns(name: string): void {
  for (const host of [name, `bunmail._domainkey.${name}`, `_dmarc.${name}`]) {
    txtErrors[host] = "ESERVFAIL";
  }
}

/** A domain that passed every check: flags set, `verifiedAt` set, due now. */
async function verifiedDomain(name: string): Promise<string> {
  const { id } = await seed.domain({ name, publicKeyPem: PUBLIC_KEY_PEM });
  await db
    .update(domains)
    .set({
      spfVerified: true,
      dkimVerified: true,
      dmarcVerified: true,
      verifiedAt: new Date("2026-10-01T00:00:00Z"),
    })
    .where(eq(domains.id, id));
  return id;
}

async function row(id: string): Promise<Domain> {
  const [found] = await db.select().from(domains).where(eq(domains.id, id));
  if (!found) throw new Error(`domain ${id} not found`);
  return found;
}

/** Makes every domain due again (the loop claims by database time). */
async function makeDue(): Promise<void> {
  await db.update(domains).set({ nextCheckAt: sql`NOW() - interval '1 minute'` });
}

async function deliveriesOf(webhookId: string) {
  return db
    .select({ event: webhookDeliveries.event, payload: webhookDeliveries.payload })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, webhookId));
}

/** An admin key's webhook and a restricted key's, both on the domain events. */
async function subscribedWebhooks(): Promise<{ adminHook: string; otherHook: string }> {
  const admin = await seed.apiKey({ isAdmin: true });
  const other = await seed.apiKey({ isAdmin: false });
  const events = ["domain.verification_failed", "domain.verified"];
  const adminHook = await seed.webhook({
    apiKeyId: admin.id,
    url: "https://hooks.example.com/admin",
    events,
  });
  /** Inserted directly: the API refuses these events to a restricted key. */
  const otherHook = await seed.webhook({
    apiKeyId: other.id,
    url: "https://hooks.example.com/other",
    events,
  });
  return { adminHook: adminHook.id, otherHook: otherHook.id };
}

const originalEnabled = config.domainReverify.enabled;
const originalRequire = config.mail.requireVerifiedDomain;

beforeEach(async () => {
  await truncateAll();
  txt = {};
  txtErrors = {};
  spfResult = "pass";
  setDomainDnsDeps({
    resolveTxt: (name) => {
      const code = txtErrors[name];
      if (code) {
        return Promise.reject(Object.assign(new Error(code), { code }));
      }
      const answer = txt[name];
      if (answer) return Promise.resolve(answer);
      return Promise.reject(Object.assign(new Error("nx"), { code: "ENOTFOUND" }));
    },
  });
});

afterEach(async () => {
  await removeInjectedFailures();
  Object.assign(config.domainReverify, { enabled: originalEnabled });
  Object.assign(config.mail, { requireVerifiedDomain: originalRequire });
  stop();
});

afterAll(() => {
  installHermeticDomainDns();
});

describe("claimDueDomains", () => {
  test("two concurrent claims return disjoint domains", async () => {
    for (let i = 0; i < 6; i++) await seed.domain({ name: `claim${i}.example.com` });

    const [a, b] = await Promise.all([claimDueDomains(3), claimDueDomains(3)]);
    const ids = [...a, ...b].map((d) => d.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  test("skips domains another claim holds instead of waiting for them", async () => {
    for (let i = 0; i < 6; i++) await seed.domain({ name: `held${i}.example.com` });

    await db.transaction(async (tx) => {
      const held = await claimDueDomains(2, tx);
      expect(held).toHaveLength(2);
      /** The first claim is still open: without SKIP LOCKED this one blocks. */
      const other = await Promise.race([
        claimDueDomains(10),
        Bun.sleep(3_000).then(() => "blocked" as const),
      ]);
      expect(other).not.toBe("blocked");
      if (other === "blocked") return;
      expect(other).toHaveLength(4);
      const heldIds = new Set(held.map((d) => d.id));
      expect(other.some((d) => heldIds.has(d.id))).toBe(false);
    });
  });

  test("pushes next_check_at forward, so the domain is not claimed twice", async () => {
    await seed.domain({ name: "lease.example.com" });
    expect(await claimDueDomains(10)).toHaveLength(1);
    expect(await claimDueDomains(10)).toHaveLength(0);
  });

  test("a domain scheduled in the future is not claimed", async () => {
    const { id } = await seed.domain({ name: "later.example.com" });
    await db
      .update(domains)
      .set({ nextCheckAt: new Date(Date.now() + HOUR_MS) })
      .where(eq(domains.id, id));
    expect(await claimDueDomains(10)).toHaveLength(0);
  });
});

describe("runReverifyCycle", () => {
  test("checks a due domain and reschedules it about 24 hours ahead", async () => {
    const { id } = await seed.domain({
      name: "due.example.com",
      publicKeyPem: PUBLIC_KEY_PEM,
    });
    publishAll("due.example.com");

    const before = Date.now();
    const summary = await runReverifyCycle({ verification });

    expect(summary).toMatchObject({ checked: 1, passed: 1, failed: 0, recovered: 1 });
    const after = await row(id);
    expect(after.lastCheckedAt).not.toBeNull();
    expect(after.verifiedAt).not.toBeNull();
    expect(after.consecutiveFailures).toBe(0);
    const next = after.nextCheckAt?.getTime() ?? 0;
    expect(next).toBeGreaterThanOrEqual(before + 23 * HOUR_MS);
    expect(next).toBeLessThanOrEqual(Date.now() + 25 * HOUR_MS);
    expect(after.lastCheckResult).toMatchObject({
      spf: { status: "pass" },
      dkim: { status: "pass" },
      dmarc: { status: "pass" },
    });
  });

  test("two definitive failures flip a verified domain and enqueue the event to admin webhooks", async () => {
    const { adminHook, otherHook } = await subscribedWebhooks();
    const id = await verifiedDomain("flip.example.com");
    publishAll("flip.example.com");
    delete txt["bunmail._domainkey.flip.example.com"];

    const first = await runReverifyCycle({ verification });
    expect(first).toMatchObject({ checked: 1, failed: 1, flipped: 0 });
    const afterOne = await row(id);
    /** A single failure does not flip: still verified, still signing. */
    expect(afterOne.verifiedAt).not.toBeNull();
    expect(afterOne.dkimVerified).toBe(true);
    expect(afterOne.consecutiveFailures).toBe(1);
    const recheck = (afterOne.nextCheckAt?.getTime() ?? 0) - Date.now();
    expect(recheck).toBeGreaterThan(0.9 * HOUR_MS);
    expect(recheck).toBeLessThanOrEqual(HOUR_MS);
    expect(await deliveriesOf(adminHook)).toHaveLength(0);

    await makeDue();
    const second = await runReverifyCycle({ verification });
    expect(second).toMatchObject({ checked: 1, failed: 1, flipped: 1 });
    const flipped = await row(id);
    expect(flipped.verifiedAt).toBeNull();
    expect(flipped.dkimVerified).toBe(false);
    expect(flipped.spfVerified).toBe(true);
    expect(flipped.consecutiveFailures).toBe(2);

    const delivered = await deliveriesOf(adminHook);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.event).toBe("domain.verification_failed");
    const body = JSON.parse(delivered[0]?.payload ?? "{}");
    expect(body.event).toBe("domain.verification_failed");
    expect(body.data).toMatchObject({
      domainId: id,
      domain: "flip.example.com",
      failedChecks: ["dkim"],
    });
    expect(typeof body.data.checkedAt).toBe("string");
    /** Domains are admin-only: a restricted key's webhook gets nothing. */
    expect(await deliveriesOf(otherHook)).toHaveLength(0);
  });

  test("the flip and its event commit together: a failed enqueue leaves the domain verified", async () => {
    const { adminHook } = await subscribedWebhooks();
    const id = await verifiedDomain("atomic.example.com");
    publishAll("atomic.example.com");
    delete txt["bunmail._domainkey.atomic.example.com"];

    await runReverifyCycle({ verification });
    await failWritesWhere("webhook_deliveries", { webhook_id: adminHook });
    await makeDue();
    const summary = await runReverifyCycle({ verification });

    expect(summary).toMatchObject({ checked: 0, errors: 1, flipped: 0 });
    const after = await row(id);
    expect(after.verifiedAt).not.toBeNull();
    expect(after.dkimVerified).toBe(true);
    expect(after.consecutiveFailures).toBe(1);
    expect(await deliveriesOf(adminHook)).toHaveLength(0);
  });

  test("a DNS error never flips, however often it repeats", async () => {
    const { adminHook } = await subscribedWebhooks();
    const id = await verifiedDomain("blip.example.com");
    breakDns("blip.example.com");

    for (let i = 0; i < 3; i++) {
      const summary = await runReverifyCycle({ verification });
      expect(summary).toMatchObject({ checked: 1, unknown: 1, failed: 0 });
      await makeDue();
    }

    const after = await row(id);
    expect(after.verifiedAt).not.toBeNull();
    expect(after.spfVerified && after.dkimVerified && after.dmarcVerified).toBe(true);
    expect(after.consecutiveFailures).toBe(0);
    expect(after.lastCheckResult?.dkim.status).toBe("unknown");
    expect(await deliveriesOf(adminHook)).toHaveLength(0);
  });

  test("a DNS error between two failures does not reset the count", async () => {
    const id = await verifiedDomain("mixed.example.com");
    publishAll("mixed.example.com");
    delete txt["bunmail._domainkey.mixed.example.com"];
    await runReverifyCycle({ verification });

    await makeDue();
    breakDns("mixed.example.com");
    await runReverifyCycle({ verification });
    expect((await row(id)).consecutiveFailures).toBe(1);

    await makeDue();
    txtErrors = {};
    await runReverifyCycle({ verification });
    expect((await row(id)).verifiedAt).toBeNull();
  });

  test("a flipped domain that passes again is verified again, with domain.verified", async () => {
    const { adminHook } = await subscribedWebhooks();
    const id = await verifiedDomain("recover.example.com");
    publishAll("recover.example.com");
    delete txt["bunmail._domainkey.recover.example.com"];
    await runReverifyCycle({ verification });
    await makeDue();
    await runReverifyCycle({ verification });
    expect((await row(id)).verifiedAt).toBeNull();

    publishAll("recover.example.com");
    await makeDue();
    const summary = await runReverifyCycle({ verification });

    expect(summary).toMatchObject({ passed: 1, recovered: 1 });
    const after = await row(id);
    expect(after.verifiedAt).not.toBeNull();
    expect(after.dkimVerified).toBe(true);
    expect(after.consecutiveFailures).toBe(0);
    const events = (await deliveriesOf(adminHook)).map((d) => d.event);
    expect(events).toEqual(["domain.verification_failed", "domain.verified"]);
  });

  test("the disabled loop does nothing", async () => {
    Object.assign(config.domainReverify, { enabled: false });
    const { id } = await seed.domain({ name: "off.example.com" });

    const summary = await runReverifyCycle({ verification });
    start();

    expect(summary.checked).toBe(0);
    expect(isRunning()).toBe(false);
    const after = await row(id);
    expect(after.lastCheckedAt).toBeNull();
    expect(after.nextCheckAt).toBeNull();
  });
});

describe("REQUIRE_VERIFIED_DOMAIN after re-verification", () => {
  const IDS = { id: "msg_test", apiKeyId: "key_test" };

  /** The real gate, re-verifying inline through the test DNS. */
  function gate(name: string) {
    return checkSenderDomain(name, IDS, {
      verify: (domain) => verifyDomain(domain, verification),
      now: () => Date.now(),
      cache: { unverifiedUntil: new Map(), inFlight: new Map() },
    });
  }

  test("a flipped domain's sends are refused", async () => {
    Object.assign(config.mail, { requireVerifiedDomain: true });
    await verifiedDomain("refused.example.com");
    publishAll("refused.example.com");
    delete txt["bunmail._domainkey.refused.example.com"];
    await runReverifyCycle({ verification });
    /** One failure: still allowed. */
    expect((await gate("refused.example.com")).domainId).not.toBeNull();

    await makeDue();
    await runReverifyCycle({ verification });

    let rejected: unknown = null;
    try {
      await gate("refused.example.com");
    } catch (error: unknown) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(SenderDomainUnverifiedError);
  });

  test("a domain whose lookups keep erroring keeps sending", async () => {
    Object.assign(config.mail, { requireVerifiedDomain: true });
    const id = await verifiedDomain("blip-send.example.com");
    breakDns("blip-send.example.com");
    await runReverifyCycle({ verification });
    await makeDue();
    await runReverifyCycle({ verification });

    const result = await gate("blip-send.example.com");
    expect(result.domainId).toBe(id);
  });
});

describe("manual Verify", () => {
  test("updates last_checked_at and the per-check result", async () => {
    const admin = await seed.apiKey({ isAdmin: true });
    const { id } = await seed.domain({ name: "manual.example.com" });

    const res = await new Elysia().use(domainsPlugin).handle(
      new Request(`http://localhost/api/v1/domains/${id}/verify`, {
        method: "POST",
        headers: { authorization: `Bearer ${admin.rawKey}` },
      }),
    );

    expect(res.status).toBe(200);
    const body = await readJson<{
      data: {
        lastCheckedAt: string | null;
        lastCheckResult: { spf: { status: string } };
      };
    }>(res);
    expect(body.data.lastCheckedAt).not.toBeNull();
    /** The hermetic DNS answers NXDOMAIN: a definitive failure. */
    expect(body.data.lastCheckResult.spf.status).toBe("fail");
    const after = await row(id);
    expect(after.lastCheckedAt).not.toBeNull();
    expect(after.consecutiveFailures).toBe(1);
    expect(after.verifiedAt).toBeNull();
    expect(after.nextCheckAt).not.toBeNull();
  });
});
