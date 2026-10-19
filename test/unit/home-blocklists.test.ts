import { describe, test, expect } from "bun:test";
import { HomePage } from "../../src/pages/routes/home.tsx";
import type { DashboardStats } from "../../src/modules/emails/services/stats.service.ts";
import type {
  DnsblSnapshot,
  DnsblStatus,
  ZoneResult,
} from "../../src/modules/domains/services/sending-ip-dnsbl.service.ts";

/** Blocklists card on the dashboard home (#250), every state, escaped. */

const stats = {
  totalEmails: 0,
  sentCount: 0,
  failedCount: 0,
  queuedCount: 0,
  bouncedCount: 0,
  sentLast24h: 0,
  failedLast24h: 0,
  bouncedLast24h: 0,
  successRate: null,
  bounceRate: 0,
  inboundTotal: 0,
  inboundLast24h: 0,
  emailsInTrash: 0,
  inboundInTrash: 0,
  totalApiKeys: 0,
  activeApiKeys: 0,
  totalDomains: 0,
  totalTemplates: 0,
  totalWebhooks: 0,
} satisfies DashboardStats;

function zoneCheck(
  zone: string,
  name: string,
  result: ZoneResult,
): DnsblSnapshot["addresses"][number]["zones"][number] {
  return { zone, name, removalUrl: `https://${zone}/removal`, result };
}

function snapshot(addresses: DnsblSnapshot["addresses"]): DnsblSnapshot {
  return {
    source: "MAIL_PUBLIC_IP",
    addresses,
    checkedAt: new Date("2026-10-19T08:00:00.000Z"),
  };
}

async function render(blocklists?: DnsblStatus): Promise<string> {
  return await HomePage({ stats, blocklists });
}

describe("HomePage blocklists card", () => {
  test("absent for members (no blocklists prop)", async () => {
    expect(await render()).not.toContain("Blocklists");
  });

  test("off", async () => {
    const html = await render({ enabled: false, snapshot: null });
    expect(html).toContain("Blocklists");
    expect(html).toContain("SENDING_IP_DNSBL_CHECK=false");
  });

  test("not checked yet", async () => {
    expect(await render({ enabled: true, snapshot: null })).toContain("Not checked yet");
  });

  test("each state, with the time of the check and every value escaped", async () => {
    const html = await render({
      enabled: true,
      snapshot: snapshot([
        {
          ip: "203.0.113.10",
          skipped: false,
          zones: [
            zoneCheck("zen.spamhaus.org", "Spamhaus ZEN", {
              status: "listed",
              codes: [
                { code: "127.0.0.2", meaning: "SBL <b>spam</b>", policy: false },
                { code: "127.0.0.11", meaning: "PBL", policy: true },
              ],
            }),
            zoneCheck("b.barracudacentral.org", "Barracuda BRBL", {
              status: "unavailable",
              code: "127.255.255.254",
            }),
            zoneCheck("bl.spamcop.net", "SpamCop", {
              status: "unknown",
              reason: "unexpected answer <script>alert(1)</script>",
            }),
          ],
        },
        {
          ip: "2001:db8::10",
          skipped: false,
          zones: [
            zoneCheck("zen.spamhaus.org", "Spamhaus ZEN", { status: "not-listed" }),
          ],
        },
        { ip: "10.0.0.5", skipped: true, zones: [] },
      ]),
    });
    expect(html).toContain("2026-10-19T08:00:00.000Z");
    expect(html).toContain(">listed<");
    expect(html).toContain("https://zen.spamhaus.org/removal");
    expect(html).toContain("Look up and request removal");
    expect(html).toContain("SBL &lt;b&gt;spam&lt;/b&gt;");
    expect(html).not.toContain("<b>spam</b>");
    expect(html).toContain(">unavailable<");
    expect(html).toContain("127.255.255.254");
    expect(html).toContain("public resolvers");
    expect(html).toContain(">unknown<");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)");
    expect(html).toContain(">not listed<");
    expect(html).toContain("Barracuda BRBL, SpamCop");
    expect(html).toContain("do not list");
    expect(html).toContain("Not publicly routable");
    expect(html).toContain("never holds or refuses mail");
  });

  test("a PBL-only listing is a policy warning with an explanation", async () => {
    const html = await render({
      enabled: true,
      snapshot: snapshot([
        {
          ip: "203.0.113.10",
          skipped: false,
          zones: [
            zoneCheck("zen.spamhaus.org", "Spamhaus ZEN", {
              status: "listed",
              codes: [{ code: "127.0.0.10", meaning: "PBL", policy: true }],
            }),
          ],
        },
      ]),
    });
    expect(html).toContain("policy listing");
    expect(html).not.toContain(">listed<");
    expect(html).toContain("Not a sign of abuse");
    expect(html).not.toContain("public resolvers");
  });

  test("no sending IP found", async () => {
    expect(await render({ enabled: true, snapshot: snapshot([]) })).toContain(
      "No sending IP found",
    );
  });
});
