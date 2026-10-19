import { describe, test, expect } from "bun:test";
import { DomainDetailPage } from "../../src/pages/routes/domain-detail.tsx";
import { checkDmarc } from "../../src/modules/domains/services/dmarc-check.service.ts";
import { getRequiredDnsRecords } from "../../src/modules/domains/services/required-dns-records.ts";

/**
 * The domain page's DMARC panel, DNS record table and MX panel (#250).
 * Values that come from DNS are attacker-controlled (anyone can publish a
 * TXT or MX record for a domain someone registers here) and must render
 * escaped.
 */

const now = new Date("2026-10-19T00:00:00Z");

const domain = {
  id: "dom_x",
  name: "acme.io",
  dkimPrivateKey: null,
  dkimPublicKey: "-----BEGIN PUBLIC KEY-----\nMIIBIj\n-----END PUBLIC KEY-----",
  dkimSelector: "bunmail",
  dkimPendingSelector: null,
  dkimPendingPrivateKey: null,
  dkimPendingPublicKey: null,
  dkimPendingCreatedAt: null,
  dkimPreviousSelector: null,
  dkimPreviousPublicKey: null,
  dkimRotatedAt: null,
  spfVerified: false,
  dkimVerified: false,
  dmarcVerified: false,
  verifiedAt: null,
  unsubscribeEmail: null,
  unsubscribeUrl: null,
  notifyEmail: null,
  createdAt: now,
  updatedAt: now,
  createdByUserId: null,
};

const settings = { mailHostname: "mail.bunmail.test", publicIps: ["203.0.113.10"] };

const XSS = "<img src=x onerror=alert(1)>";
/** No whitespace, so it survives as a valid-looking rua address. */
const XSS_RUA = "<svg/onload=alert(1)>";

/** A DMARC check of one hostile TXT record. */
async function hostileDmarc(): Promise<Awaited<ReturnType<typeof checkDmarc>>> {
  return checkDmarc("acme.io", {
    resolveTxt: () =>
      Promise.resolve([
        [
          `v=DMARC1; p=none; sp=${XSS}; rua=mailto:${XSS}@acme.io,mailto:${XSS_RUA}@acme.io; ${XSS}`,
        ],
      ]),
  });
}

describe("DomainDetailPage: DNS panels (#250)", () => {
  test("hostile TXT and MX content renders escaped", async () => {
    const dmarc = await hostileDmarc();
    expect(dmarc.problems.length).toBeGreaterThan(0);
    expect(dmarc.rua).toEqual([`mailto:${XSS_RUA}@acme.io`]);
    const html = await DomainDetailPage({
      domain,
      dnsRecords: getRequiredDnsRecords(domain, settings),
      dns: { dmarc, mx: { status: "elsewhere", hosts: [`${XSS}.example`] } },
      smtpEnabled: true,
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg/onload");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("mailto:&lt;svg/onload=alert(1)&gt;@acme.io");
  });

  test("shows the DMARC policy, the records table and the mail flows", async () => {
    const dmarc = await checkDmarc("mail.acme.io", {
      resolveTxt: (name) =>
        name === "_dmarc.acme.io"
          ? Promise.resolve([["v=DMARC1; p=reject; sp=quarantine; rua=mailto:d@acme.io"]])
          : Promise.reject(Object.assign(new Error("x"), { code: "ENOTFOUND" })),
    });
    const html = await DomainDetailPage({
      domain,
      dnsRecords: getRequiredDnsRecords(domain, settings),
      dns: { dmarc, mx: { status: "here", hosts: ["mail.bunmail.test"] } },
      smtpEnabled: true,
    });
    expect(html).toContain("_dmarc.acme.io (inherited)");
    expect(html).toContain("quarantine");
    expect(html).toContain("v=DMARC1; p=none; rua=mailto:dmarc@acme.io");
    expect(html).toContain("10 mail.bunmail.test");
    expect(html).toContain("optional");
    expect(html).toContain("select-all");
    expect(html).toContain("Signed return paths");
    expect(html).toContain("The MX points at this server.");
    expect(html).not.toContain(">Off<");
  });

  test("with SMTP off every flow is off and says why", async () => {
    const dmarc = await checkDmarc("acme.io", {
      resolveTxt: () =>
        Promise.reject(Object.assign(new Error("x"), { code: "ENOTFOUND" })),
    });
    const html = await DomainDetailPage({
      domain,
      dnsRecords: getRequiredDnsRecords(domain, settings),
      dns: { dmarc, mx: { status: "here", hosts: ["mail.bunmail.test"] } },
      smtpEnabled: false,
    });
    expect(html).toContain("No DMARC record at _dmarc.acme.io");
    expect(html).toContain("SMTP_ENABLED=false");
    expect(html).not.toContain(">Active<");
  });
});
