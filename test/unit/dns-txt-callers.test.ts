import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { getServers, setServers } from "dns";
import { checkHost } from "../../src/modules/domains/services/spf-evaluator.ts";
import {
  getDomainDnsStatus,
  setDomainDnsDeps,
} from "../../src/modules/domains/services/domain-dns-status.service.ts";
import {
  discoverMtaStsPolicy,
  setMtaStsDeps,
} from "../../src/modules/emails/services/mta-sts.ts";
import { verifyDkimSignatures } from "../../src/modules/inbound/services/dkim-verifier.service.ts";
import {
  BASE_MESSAGE,
  keyName,
  publicKeyValue,
  signWithNodemailer,
} from "../dkim-vectors.ts";
import { startFakeDns, zoneHandler, type FakeDnsServer } from "../fake-dns.ts";

/**
 * Regression tests for the Bun TXT bug (oven-sh/bun#44692): Bun's
 * `resolveTxt` returns each string of a multi-string record as a record of
 * its own. Each caller's real default TXT path (`utils/dns-txt.ts`, which
 * reads `dns.getServers()`) is pointed at a fake DNS server on 127.0.0.1
 * with `dns.setServers`, and each record is published as two strings, the
 * way a 2048-bit DKIM key or a long SPF record is. With Bun's split, every
 * case here gives the wrong answer. The servers are restored afterwards;
 * other lookups (MX, address, the policy fetch) are stubbed through the
 * callers' seams.
 */

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const dkimKey = `v=DKIM1; k=rsa; p=${publicKeyValue(rsa.publicKey)}`;

const ZONE = {
  /** 2048-bit key: 255 characters, then the rest, as DNS hosting panels publish it. */
  [keyName("rsa")]: [[dkimKey.slice(0, 255), dkimKey.slice(255)]],
  /** The IP that passes is only in the second string. */
  "example.com": [["v=spf1 ip4:192.0.2.1", " ip4:203.0.113.10 -all"]],
  /** `p=reject` straddles the two strings. */
  "_dmarc.example.com": [["v=DMARC1; p=rej", "ect; rua=mailto:dmarc@example.com"]],
  /** The `id` is only in the second string. */
  "_mta-sts.example.org": [["v=STSv1; ", "id=20261102;"]],
};

let dns: FakeDnsServer;
let systemServers: string[];

beforeAll(async () => {
  dns = await startFakeDns(zoneHandler(ZONE));
  systemServers = getServers();
  setServers([dns.server]);
});

afterAll(() => {
  setServers(systemServers);
  dns.stop();
});

describe("multi-string TXT records through each caller's default lookup", () => {
  test("the DKIM verifier reads a 2048-bit key published as two strings", async () => {
    expect(dkimKey.length).toBeGreaterThan(255);
    const signed = await signWithNodemailer(BASE_MESSAGE, {
      privateKey: rsa.privateKey,
      selector: "rsa",
    });
    const [result] = await verifyDkimSignatures(Buffer.from(signed, "latin1"));
    expect(result?.result).toBe("pass");
  });

  test("the SPF evaluator reads the whole record", async () => {
    const { result } = await checkHost({
      ip: "203.0.113.10",
      domain: "example.com",
      sender: "postmaster@example.com",
      helo: "mail.example.com",
    });
    expect(result).toBe("pass");
  });

  test("the DMARC check of the domain status reads the whole record", async () => {
    setDomainDnsDeps({ resolveMx: async () => [] });
    try {
      const { dmarc } = await getDomainDnsStatus("example.com");
      expect(dmarc.status).toBe("pass");
      expect(dmarc.policy).toBe("reject");
      expect(dmarc.rua).toEqual(["mailto:dmarc@example.com"]);
    } finally {
      setDomainDnsDeps(null);
    }
  });

  test("MTA-STS discovery reads the policy id from the second string", async () => {
    setMtaStsDeps({
      lookup: async () => [{ address: "203.0.113.7" }],
      fetch: async () =>
        new Response(
          "version: STSv1\nmode: enforce\nmx: mx1.example.org\nmax_age: 86400\n",
          {
            headers: { "content-type": "text/plain" },
          },
        ),
    });
    try {
      const active = await discoverMtaStsPolicy("example.org", { allowPrivate: false });
      expect(active?.id).toBe("20261102");
      expect(active?.policy.mode).toBe("enforce");
    } finally {
      setMtaStsDeps(null);
    }
  });
});
