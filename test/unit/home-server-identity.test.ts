import { describe, test, expect } from "bun:test";
import { HomePage } from "../../src/pages/routes/home.tsx";
import type { DashboardStats } from "../../src/modules/emails/services/stats.service.ts";
import type { ReverseDnsStatus } from "../../src/modules/domains/services/sending-ips.service.ts";

/** Server identity card on the dashboard home (#248). */

const stats = {
  totalEmails: 0,
  sentCount: 0,
  failedCount: 0,
  queuedCount: 0,
  sentLast24h: 0,
  failedLast24h: 0,
  successRate: null,
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

function status(checks: ReverseDnsStatus["checks"]): ReverseDnsStatus {
  return {
    hostname: "mail.example.com",
    source: "MAIL_HOSTNAME",
    checks,
    checkedAt: new Date(),
  };
}

async function render(serverIdentity?: {
  status: ReverseDnsStatus | null;
}): Promise<string> {
  return await HomePage({ stats, serverIdentity });
}

describe("HomePage server identity card", () => {
  test("absent for members (no serverIdentity prop)", async () => {
    expect(await render()).not.toContain("Server identity");
  });

  test("says it is checking before the first result", async () => {
    const html = await render({ status: null });
    expect(html).toContain("Server identity");
    expect(html).toContain("Checking reverse DNS");
  });

  test("shows each IP with its result, reason escaped", async () => {
    const html = await render({
      status: status([
        {
          ip: "203.0.113.10",
          ok: true,
          ptr: ["mail.example.com"],
          reason: "ok <both ways>",
        },
        {
          ip: "2001:db8::10",
          ok: false,
          ptr: [],
          reason: "PTR of 2001:db8::10 is missing",
        },
      ]),
    });
    expect(html).toContain("PTR ok");
    expect(html).toContain("PTR problem");
    expect(html).toContain("203.0.113.10");
    expect(html).toContain("ok &lt;both ways&gt;");
    expect(html).not.toContain("<both ways>");
  });

  test("no sending IP found", async () => {
    expect(await render({ status: status([]) })).toContain("No sending IP found");
  });
});
