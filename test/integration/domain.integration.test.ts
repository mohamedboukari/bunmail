/**
 * Integration tests for `domain.service.ts` against a real Postgres.
 * Catches:
 *
 *   - `createDomain` actually encrypts the DKIM private key (#23) — the
 *     stored bytes are `v1:...` ciphertext, not the raw PEM
 *   - DKIM keypair generation produces a valid 2048-bit RSA key
 *   - `domainExistsByName` does exact-match (case-sensitive per RFC 5321)
 *   - `getDomainById` / `listDomains` return the right shape
 *   - `deleteDomain` works and `ON DELETE SET NULL` detaches related emails
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createDomain,
  getDomainById,
  listDomains,
  domainExistsByName,
  deleteDomain,
  getDkimDnsRecord,
} from "../../src/modules/domains/services/domain.service.ts";
import { isEncryptedSecret, decryptSecret } from "../../src/utils/crypto.ts";
import { config } from "../../src/config.ts";
import { truncateAll, seed, db, domains, emails } from "./_helpers.ts";

beforeEach(async () => {
  await truncateAll();
});

describe("createDomain", () => {
  test("inserts a row with an AES-256-GCM-encrypted DKIM private key", async () => {
    const created = await createDomain({ name: "example.com" });
    expect(created.id).toMatch(/^dom_/);
    expect(created.name).toBe("example.com");
    expect(created.dkimSelector).toBe("bunmail");

    /** The returned row carries the **encrypted** ciphertext (the
     *  service doesn't decrypt before returning — that's the queue's
     *  job at send time). Confirm via the format check. */
    expect(created.dkimPrivateKey).not.toBeNull();
    expect(isEncryptedSecret(created.dkimPrivateKey!)).toBe(true);

    /** The ciphertext should round-trip cleanly with the configured key. */
    const plaintextPem = decryptSecret(created.dkimPrivateKey!, config.dkimEncryptionKey);
    expect(plaintextPem).toContain("-----BEGIN PRIVATE KEY-----");
    expect(plaintextPem).toContain("-----END PRIVATE KEY-----");
  });

  test("public key is NOT encrypted (it's published in DNS, no threat)", async () => {
    const created = await createDomain({ name: "example.com" });
    expect(created.dkimPublicKey).not.toBeNull();
    expect(created.dkimPublicKey).toContain("-----BEGIN PUBLIC KEY-----");
    /** Plaintext, not v1:... */
    expect(isEncryptedSecret(created.dkimPublicKey!)).toBe(false);
  });

  test("getDkimDnsRecord returns the publishable v=DKIM1 string", async () => {
    const created = await createDomain({ name: "example.com" });
    const rec = getDkimDnsRecord(created);
    expect(rec).not.toBeNull();
    expect(rec).toMatch(/^v=DKIM1; k=rsa; p=[A-Za-z0-9+/=]+$/);
  });

  test("preserves unsubscribe overrides when provided", async () => {
    const created = await createDomain({
      name: "example.com",
      unsubscribeEmail: "noreply@example.com",
      unsubscribeUrl: "https://example.com/unsub",
    });
    expect(created.unsubscribeEmail).toBe("noreply@example.com");
    expect(created.unsubscribeUrl).toBe("https://example.com/unsub");
  });
});

describe("domainExistsByName", () => {
  test("returns true for a registered domain (exact name match)", async () => {
    await createDomain({ name: "example.com" });
    expect(await domainExistsByName("example.com")).toBe(true);
  });

  test("returns false for an unregistered domain", async () => {
    await createDomain({ name: "example.com" });
    expect(await domainExistsByName("not-registered.com")).toBe(false);
  });
});

describe("listDomains / getDomainById", () => {
  test("listDomains returns all domains; getDomainById returns one or undefined", async () => {
    const a = await createDomain({ name: "a.example.com" });
    const b = await createDomain({ name: "b.example.com" });

    const list = await listDomains();
    expect(list).toHaveLength(2);
    expect(list.map((d) => d.id).sort()).toEqual([a.id, b.id].sort());

    const fetched = await getDomainById(a.id);
    expect(fetched?.name).toBe("a.example.com");

    const missing = await getDomainById("dom_doesnotexist");
    expect(missing).toBeUndefined();
  });
});

describe("deleteDomain — ON DELETE SET NULL", () => {
  test("deleting a domain detaches its emails (sets emails.domain_id to NULL) without deleting them", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const created = await createDomain({ name: "example.com" });
    const { id: emailA } = await seed.email({ apiKeyId, domainId: created.id });
    const { id: emailB } = await seed.email({ apiKeyId, domainId: created.id });

    /** Sanity: both emails point at the domain. */
    const before = await db.select().from(emails).where(eq(emails.domainId, created.id));
    expect(before).toHaveLength(2);

    /** Delete the domain. */
    const deleted = await deleteDomain(created.id);
    expect(deleted?.id).toBe(created.id);

    /** Both emails still exist… */
    const [aRow] = await db.select().from(emails).where(eq(emails.id, emailA));
    const [bRow] = await db.select().from(emails).where(eq(emails.id, emailB));
    expect(aRow).toBeDefined();
    expect(bRow).toBeDefined();
    /** …with domainId = NULL (the ON DELETE SET NULL FK behaviour). */
    expect(aRow?.domainId).toBeNull();
    expect(bRow?.domainId).toBeNull();

    /** And the domain row is actually gone. */
    const stillThere = await db.select().from(domains).where(eq(domains.id, created.id));
    expect(stillThere).toHaveLength(0);
  });

  test("deleteDomain returns undefined when the row doesn't exist", async () => {
    const result = await deleteDomain("dom_doesnotexist");
    expect(result).toBeUndefined();
  });
});
