import { describe, test, expect } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { getDkimDnsRecord } from "../../src/modules/domains/services/domain.service.ts";
import {
  TXT_STRING_MAX,
  getRequiredDnsRecords,
  splitTxtValue,
} from "../../src/modules/domains/services/required-dns-records.ts";

/**
 * The DNS records an operator publishes for a domain (#250): SPF, DKIM
 * split into 255-character strings, DMARC p=none with rua, the A/AAAA and
 * PTR records of MAIL_HOSTNAME, and an optional MX.
 */

const { publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const domain = { name: "acme.io", dkimSelector: "bunmail", dkimPublicKey: publicKey };
const settings = { mailHostname: "mail.bunmail.test", publicIps: ["203.0.113.10"] };

/** The quoted strings of a split TXT value. */
function strings(value: string): string[] {
  return [...value.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
}

describe("splitTxtValue", () => {
  test("a 2048-bit DKIM record splits into strings of at most 255 that rejoin", () => {
    const record = getDkimDnsRecord(domain)!;
    expect(record.length).toBeGreaterThan(TXT_STRING_MAX);
    const split = splitTxtValue(record);
    const parts = strings(split);
    expect(parts.length).toBe(Math.ceil(record.length / 255));
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(255);
    expect(parts[0]!.length).toBe(255);
    expect(parts.join("")).toBe(record);
    /** Nothing outside the quotes but the separating spaces. */
    expect(split).toBe(parts.map((p) => `"${p}"`).join(" "));
  });

  test("a short value stays one string", () => {
    expect(splitTxtValue("v=DKIM1; p=abc")).toBe('"v=DKIM1; p=abc"');
  });
});

describe("getRequiredDnsRecords", () => {
  test("SPF, DKIM, DMARC, A, PTR and an optional MX, in that order", () => {
    const records = getRequiredDnsRecords(domain, settings);
    expect(records.map((r) => r.type)).toEqual(["TXT", "TXT", "TXT", "A", "PTR", "MX"]);
    expect(records.filter((r) => r.optional).map((r) => r.type)).toEqual(["MX"]);
  });

  test("SPF authorizes MAIL_HOSTNAME, with the merge note", () => {
    const [spf] = getRequiredDnsRecords(domain, settings);
    expect(spf).toMatchObject({
      type: "TXT",
      host: "acme.io",
      value: "v=spf1 a:mail.bunmail.test -all",
    });
    expect(spf?.note).toContain("a:mail.bunmail.test");
    expect(spf?.note).toContain("exactly one SPF record");
  });

  test("DKIM goes on <selector>._domainkey.<domain>, pre-split", () => {
    const dkim = getRequiredDnsRecords(domain, settings)[1]!;
    expect(dkim.host).toBe("bunmail._domainkey.acme.io");
    expect(strings(dkim.value).join("")).toBe(getDkimDnsRecord(domain)!);
    for (const part of strings(dkim.value)) expect(part.length).toBeLessThanOrEqual(255);
  });

  test("no DKIM record without a public key", () => {
    const records = getRequiredDnsRecords({ ...domain, dkimPublicKey: null }, settings);
    expect(records.some((r) => r.host.includes("_domainkey"))).toBe(false);
  });

  test("DMARC starts at p=none with reports to dmarc@<domain>", () => {
    const dmarc = getRequiredDnsRecords(domain, settings).find(
      (r) => r.host === "_dmarc.acme.io",
    )!;
    expect(dmarc.value).toBe("v=DMARC1; p=none; rua=mailto:dmarc@acme.io");
    expect(dmarc.note).toContain("dmarc@acme.io");
  });

  test("A and PTR name MAIL_PUBLIC_IP when set, AAAA for IPv6", () => {
    const records = getRequiredDnsRecords(domain, {
      ...settings,
      publicIps: ["203.0.113.10", "2001:db8::5"],
    });
    expect(records.filter((r) => r.type === "A" || r.type === "AAAA")).toMatchObject([
      { type: "A", host: "mail.bunmail.test", value: "203.0.113.10" },
      { type: "AAAA", host: "mail.bunmail.test", value: "2001:db8::5" },
    ]);
    expect(records.filter((r) => r.type === "PTR")).toMatchObject([
      { host: "203.0.113.10", value: "mail.bunmail.test" },
      { host: "2001:db8::5", value: "mail.bunmail.test" },
    ]);
    expect(records.find((r) => r.type === "PTR")?.note).toContain("hosting provider");
  });

  test("without MAIL_PUBLIC_IP the A and PTR records describe the address", () => {
    const records = getRequiredDnsRecords(domain, { ...settings, publicIps: [] });
    const a = records.find((r) => r.type === "A")!;
    const ptr = records.find((r) => r.type === "PTR")!;
    expect(a.host).toBe("mail.bunmail.test");
    expect(a.value).toBe("this server's public IP address");
    expect(a.note).toContain("MAIL_PUBLIC_IP");
    expect(ptr.value).toBe("mail.bunmail.test");
    /** No placeholder in angle brackets to paste as is (#247). */
    expect(records.some((r) => /[<>]/.test(r.value))).toBe(false);
  });

  test("the MX record is optional and warns about existing mailboxes", () => {
    const mx = getRequiredDnsRecords(domain, settings).at(-1)!;
    expect(mx).toMatchObject({
      type: "MX",
      host: "acme.io",
      value: "10 mail.bunmail.test",
      optional: true,
    });
    expect(mx.note).toContain("Leave an MX that serves mailboxes");
  });
});
