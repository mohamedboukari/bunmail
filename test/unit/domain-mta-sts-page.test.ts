import { describe, test, expect } from "bun:test";
import { MtaStsPanel } from "../../src/pages/routes/domain-detail-mta-sts.tsx";
import { servedMtaStsPolicy } from "../../src/modules/domains/services/mta-sts-served-policy.ts";
import type { DomainCheckResult } from "../../src/modules/domains/types/domain-check.types.ts";

/**
 * The domain page's MTA-STS panel (#472): the mode select posting to
 * `/dashboard/domains/:id/mta-sts`, and, once a mode is set, the TXT
 * record with the current id, the policy text, the last check (escaped),
 * and the warnings for an unverified domain and a server without inbound
 * STARTTLS.
 */

const domain = {
  id: "dom_sts",
  name: "example.org",
  mtaStsMode: "none" as const,
  verifiedAt: new Date("2026-11-01"),
  lastCheckResult: null,
};

const passing: DomainCheckResult = {
  spf: { status: "pass", reason: "ok" },
  dkim: { status: "pass", reason: "ok" },
  dmarc: { status: "pass", reason: "ok" },
  checkedAt: "2026-11-15T00:00:00.000Z",
};

describe("MtaStsPanel", () => {
  test("off: the select posts to the domain's route, Off selected, no records", async () => {
    const html = await MtaStsPanel({ domain, inboundStarttls: true });
    expect(html).toContain('action="/dashboard/domains/dom_sts/mta-sts"');
    expect(html).toMatch(/<option value="none" selected>/);
    expect(html).not.toContain("_mta-sts.example.org");
    expect(html).not.toContain("no inbound STARTTLS");
  });

  test("enforce: the TXT record with the current id, the policy, the URL", async () => {
    const html = await MtaStsPanel({
      domain: { ...domain, mtaStsMode: "enforce" },
      inboundStarttls: true,
    });
    const policy = servedMtaStsPolicy("enforce");
    expect(html).toMatch(/<option value="enforce" selected>/);
    expect(html).toContain("_mta-sts.example.org");
    expect(html).toContain(`v=STSv1; id=${policy.id}`);
    expect(html).toContain("https://mta-sts.example.org/.well-known/mta-sts.txt");
    expect(html).toContain("mode: enforce");
    expect(html).toContain("Not checked yet");
    expect(html).not.toContain("Not served yet");
  });

  test("warns when the domain is unverified and when there is no inbound STARTTLS", async () => {
    const html = await MtaStsPanel({
      domain: { ...domain, mtaStsMode: "testing", verifiedAt: null },
      inboundStarttls: false,
    });
    expect(html).toContain("Not served yet");
    expect(html).toContain("no inbound STARTTLS");
  });

  test("the last check's reason is escaped", async () => {
    const html = await MtaStsPanel({
      domain: {
        ...domain,
        mtaStsMode: "testing",
        lastCheckResult: {
          ...passing,
          mtaSts: { status: "fail", reason: "<script>alert(1)</script>" },
        },
      },
      inboundStarttls: true,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Last check: failed");
  });
});
