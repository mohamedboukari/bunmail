import { describe, test, expect } from "bun:test";
import { serializeDomain } from "../../src/modules/domains/serializations/domain.serialization.ts";

/**
 * Unit tests for domain serialization.
 *
 * Verifies that sensitive fields (DKIM private key) are stripped
 * from the public API response shape.
 */

describe("serializeDomain", () => {
  const domain = {
    id: "dom_abc123",
    name: "example.com",
    dkimPrivateKey:
      "-----BEGIN RSA PRIVATE KEY-----\nSECRET\n-----END RSA PRIVATE KEY-----",
    dkimPublicKey: "-----BEGIN PUBLIC KEY-----\nPUBLIC\n-----END PUBLIC KEY-----",
    dkimSelector: "bunmail",
    dkimPendingSelector: null,
    dkimPendingPrivateKey: null,
    dkimPendingPublicKey: null,
    dkimPendingCreatedAt: null,
    dkimPreviousSelector: null,
    dkimPreviousPublicKey: null,
    dkimRotatedAt: null,
    spfVerified: true,
    dkimVerified: false,
    dmarcVerified: false,
    verifiedAt: new Date("2024-06-01"),
    lastCheckedAt: null,
    nextCheckAt: null,
    consecutiveFailures: 0,
    lastCheckResult: null,
    unsubscribeEmail: null as string | null,
    unsubscribeUrl: null as string | null,
    notifyEmail: null as string | null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    createdByUserId: null,
  };

  test("includes public fields", () => {
    const result = serializeDomain(domain, null);
    expect(result.id).toBe("dom_abc123");
    expect(result.name).toBe("example.com");
    expect(result.dkimSelector).toBe("bunmail");
    expect(result.spfVerified).toBe(true);
    expect(result.dkimVerified).toBe(false);
    expect(result.dmarcVerified).toBe(false);
    expect(result.verifiedAt).toEqual(new Date("2024-06-01"));
    expect(result.createdAt).toEqual(new Date("2024-01-01"));
  });

  test("strips dkimPrivateKey from output", () => {
    const result = serializeDomain(domain, null);
    expect("dkimPrivateKey" in result).toBe(false);
  });

  test("strips dkimPublicKey from output", () => {
    const result = serializeDomain(domain, null);
    expect("dkimPublicKey" in result).toBe(false);
  });

  test("pending and previous DKIM state (#250), never a private key", () => {
    const rotating = {
      ...domain,
      dkimPendingSelector: "bm20261019",
      dkimPendingPrivateKey: "v1:pending:private:key",
      dkimPendingPublicKey: "-----BEGIN PUBLIC KEY-----\nNEXT\n-----END PUBLIC KEY-----",
      dkimPendingCreatedAt: new Date("2026-10-19"),
      dkimPreviousSelector: "old",
      dkimPreviousPublicKey: "-----BEGIN PUBLIC KEY-----\nOLD\n-----END PUBLIC KEY-----",
      dkimRotatedAt: new Date("2026-10-01"),
    };
    const result = serializeDomain(rotating, null);
    expect(result.dkimPending).toEqual({
      selector: "bm20261019",
      host: "bm20261019._domainkey.example.com",
      dnsRecord: "v=DKIM1; k=rsa; p=NEXT",
      createdAt: new Date("2026-10-19"),
    });
    expect(result.dkimPrevious).toMatchObject({
      selector: "old",
      host: "old._domainkey.example.com",
      dnsRecord: "v=DKIM1; k=rsa; p=OLD",
      rotatedAt: new Date("2026-10-01"),
    });
    expect(result.dkimPrevious?.advice).toContain("7 days");
    expect(result.dnsRecords.find((r) => r.pending)?.host).toBe(
      "bm20261019._domainkey.example.com",
    );
    const json = JSON.stringify(result);
    expect(json).not.toContain("v1:pending:private:key");
    expect(json).not.toContain("SECRET");
    expect(json).not.toContain("PRIVATE");
  });

  test("no rotation: dkimPending and dkimPrevious are null", () => {
    const result = serializeDomain(domain, null);
    expect(result.dkimPending).toBeNull();
    expect(result.dkimPrevious).toBeNull();
  });

  test("strips updatedAt from output", () => {
    const result = serializeDomain(domain, null);
    expect("updatedAt" in result).toBe(false);
  });

  test("exposes unsubscribe overrides as nullable fields", () => {
    /**
     * The mailer falls back to `unsubscribe@<domain>` when these are
     * null, so the API needs to surface "unset" distinctly from a real
     * value the caller previously set.
     */
    const noOverrides = serializeDomain(domain, null);
    expect(noOverrides.unsubscribeEmail).toBeNull();
    expect(noOverrides.unsubscribeUrl).toBeNull();

    const withOverrides = serializeDomain(
      {
        ...domain,
        unsubscribeEmail: "optout@example.com",
        unsubscribeUrl: "https://example.com/unsubscribe?id=abc",
      },
      null,
    );
    expect(withOverrides.unsubscribeEmail).toBe("optout@example.com");
    expect(withOverrides.unsubscribeUrl).toBe("https://example.com/unsubscribe?id=abc");
  });

  test("exposes notifyEmail (null when unset)", () => {
    expect(serializeDomain(domain, null).notifyEmail).toBeNull();
    const withNotify = serializeDomain(
      { ...domain, notifyEmail: "ops@external.com" },
      null,
    );
    expect(withNotify.notifyEmail).toBe("ops@external.com");
  });

  test("exposes the DNS records to publish and the DNS status (#250)", () => {
    const withoutDns = serializeDomain(domain, null);
    expect(withoutDns.dmarc).toBeNull();
    expect(withoutDns.mx).toBeNull();
    expect(withoutDns.dnsRecords.map((r) => r.type)).toContain("MX");
    expect(withoutDns.dnsRecords.some((r) => r.host === "_dmarc.example.com")).toBe(true);

    const mx = { status: "elsewhere" as const, hosts: ["aspmx.l.google.com"] };
    const dmarc = {
      status: "missing" as const,
      ok: false,
      reason: "No DMARC record at _dmarc.example.com",
      warnings: [],
      problems: [],
      recordDomain: null,
      inherited: false,
      policy: null,
      subdomainPolicy: null,
      effectivePolicy: null,
      pct: null,
      adkim: null,
      aspf: null,
      rua: [],
    };
    const withDns = serializeDomain(domain, { dmarc, mx });
    expect(withDns.mx).toEqual(mx);
    expect(withDns.dmarc).toEqual(dmarc);
  });
});
