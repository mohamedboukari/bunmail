import { describe, test, expect, mock } from "bun:test";

/**
 * Unit tests for getDkimDnsRecord.
 *
 * Tests DNS TXT record generation from a domain's DKIM public key.
 * Mocks the DB, logger, and config since the domain service imports them.
 */

/* ─── Mock config ─── */
mock.module("../../src/config.ts", () => ({
  config: {
    database: { url: "postgres://test:test@localhost/test" },
    server: { port: 3000, host: "0.0.0.0" },
    mail: { hostname: "localhost" },
    dashboard: { password: "", sessionSecret: "test-secret" },
    logLevel: "error",
  },
}));

/* ─── Mock logger ─── */
mock.module("../../src/utils/logger.ts", () => ({
  logger: {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
}));

/* ─── Mock DB ─── */
mock.module("../../src/db/index.ts", () => ({
  db: {},
}));

/* ─── Import after mocking ─── */
const { getDkimDnsRecord } =
  await import("../../src/modules/domains/services/domain.service.ts");

/** Realistic PEM-encoded public key for testing */
const SAMPLE_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Z3VS5JJcds3xfn/ygWe
FsGEsRFKB2p9XDCFtk7E4q3t0W8NMQE+G9LaucCcM0nXPDOG+gMCMnO7sxLiGHH
YQKHwbt6jaF/k1gMi5GK8J1F7WQPXNLQ8bRXr3kF+vR6MwxhZQh/BnT1bZ3QTFQ
woXgTUUFR0gR4B8RVMHB1cEOycMsST8GFHBFJjz1YDGRVACIqPGCNQkeSIiAQDX
pDMiOmjCnJiE8OMGEhsIkdMDGnvufnBLgKfbHcRMzl4fMRZ3y3jP5F6jiMBPOhk8
pJ5RE1O3EhJmEFnNkWMA6kG0p3doWBAzjiQMjdHPGf+MO6GgPGnGKkYImuwdP7Gy
3QIDAQAB
-----END PUBLIC KEY-----`;

/** Expected base64 with PEM headers and whitespace stripped */
const EXPECTED_B64 = SAMPLE_PEM.replace(/-----BEGIN PUBLIC KEY-----/g, "")
  .replace(/-----END PUBLIC KEY-----/g, "")
  .replace(/\s/g, "");

/** Minimal domain-shaped object for testing */
function makeDomain(overrides: Record<string, unknown> = {}) {
  return {
    id: "dom_test123",
    name: "example.com",
    dkimPrivateKey:
      "-----BEGIN RSA PRIVATE KEY-----\nSECRET\n-----END RSA PRIVATE KEY-----",
    dkimPublicKey: SAMPLE_PEM,
    dkimSelector: "bunmail",
    spfVerified: false,
    dkimVerified: false,
    dmarcVerified: false,
    verifiedAt: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

describe("getDkimDnsRecord", () => {
  test("returns null when dkimPublicKey is null", () => {
    const domain = makeDomain({ dkimPublicKey: null });
    const result = getDkimDnsRecord(domain);
    expect(result).toBeNull();
  });

  test("returns a string starting with 'v=DKIM1; k=rsa; p='", () => {
    const domain = makeDomain();
    const result = getDkimDnsRecord(domain);
    expect(result).toStartWith("v=DKIM1; k=rsa; p=");
  });

  test("strips PEM headers and whitespace from the public key", () => {
    const domain = makeDomain();
    const result = getDkimDnsRecord(domain)!;
    expect(result).not.toContain("-----BEGIN PUBLIC KEY-----");
    expect(result).not.toContain("-----END PUBLIC KEY-----");
    expect(result).not.toContain("\n");
  });

  test("output contains the base64 key material without line breaks", () => {
    const domain = makeDomain();
    const result = getDkimDnsRecord(domain)!;
    const keyPart = result.replace("v=DKIM1; k=rsa; p=", "");
    expect(keyPart).toBe(EXPECTED_B64);
    expect(keyPart).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});
