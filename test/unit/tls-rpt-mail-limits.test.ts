import { afterEach, describe, expect, test } from "bun:test";
import { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import { setMtaStsDeps } from "../../src/modules/emails/services/mta-sts.ts";
import { setMxRouteDeps } from "../../src/modules/emails/services/mx-route.ts";

/**
 * `sendMail`'s per-call delivery limits (#345): a TLS report tries at most
 * `maxMxHosts` MX hosts, so a hostile domain listing many tarpitting MX
 * hosts cannot hold the report job; an ordinary send still tries up to
 * five. The MX route and MTA-STS are stubbed; every MX host resolves to
 * 127.0.0.1 on a closed port, so nothing leaves the machine.
 */

/** A DNS error with its `code`, as `dns/promises` rejects. */
function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** Routes `example.org` to seven MX hosts and records which ones were looked up. */
function route(): string[] {
  const looked: string[] = [];
  setMxRouteDeps({
    resolveMx: async () =>
      Array.from({ length: 7 }, (_, i) => ({
        exchange: `mx${i}.example.org`,
        priority: i,
      })),
    resolve4: () => Promise.reject(dnsError("ENOTFOUND")),
    resolve6: () => Promise.reject(dnsError("ENOTFOUND")),
    lookup: async (host) => {
      looked.push(host);
      return [{ address: "127.0.0.1" }];
    },
    /** Port 1 on loopback: refused at once, if a connection is made at all. */
    smtpPort: () => 1,
    timeoutMs: 1_000,
  });
  setMtaStsDeps({
    resolveTxt: () => Promise.reject(dnsError("ENOTFOUND")),
    lookup: () => Promise.reject(dnsError("ENOTFOUND")),
    fetch: () => Promise.reject(new Error("no policy host")),
  });
  return looked;
}

afterEach(() => {
  setMxRouteDeps(null);
  setMtaStsDeps(null);
});

function send(limits?: { deadlineMs: number; maxMxHosts: number }) {
  return sendMail({
    from: "noreply@example.com",
    to: "user@example.org",
    subject: "limits",
    text: "hello",
    messageId: `<${crypto.randomUUID()}@bunmail.example.test>`,
    ...(limits ? { deliveryLimits: limits } : {}),
  });
}

describe("sendMail delivery limits", () => {
  test("with limits: at most maxMxHosts hosts are tried", async () => {
    const looked = route();
    const result = await send({ deadlineMs: 120_000, maxMxHosts: 2 });
    expect(looked).toEqual(["mx0.example.org", "mx1.example.org"]);
    expect(result.deliveryState["example.org"]?.status).toBe("retry");
  });

  test("without limits: the usual five hosts", async () => {
    const looked = route();
    await send();
    expect(looked).toHaveLength(5);
  });
});
