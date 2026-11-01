import { describe, test, expect } from "bun:test";
import {
  HomePage,
  QUEUE_STUCK_AFTER_SECONDS,
  formatWait,
} from "../../src/pages/routes/home.tsx";
import type { DashboardStats } from "../../src/modules/emails/services/stats.service.ts";
import type { DbSnapshot } from "../../src/modules/metrics/services/db-gauges.service.ts";

/** System health card on the dashboard home (#362): every state, escaped. */

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

function snapshot(overrides: Partial<DbSnapshot> = {}): DbSnapshot {
  return {
    queue: { queued: 7, sending: 2, due: 3, oldestDueAgeSeconds: 4 },
    webhooks: { pending: 5, due: 1 },
    suppressions: [
      { reason: "bounce", count: 12 },
      { reason: "complaint", count: 1 },
    ],
    ...overrides,
  };
}

async function render(systemHealth?: { snapshot: DbSnapshot | null }): Promise<string> {
  return await HomePage({ stats, systemHealth });
}

describe("System health card", () => {
  test("absent for members (no systemHealth passed)", async () => {
    expect(await render()).not.toContain("System health");
  });

  test("a healthy queue: the figures and a moving badge", async () => {
    const html = await render({ snapshot: snapshot() });
    expect(html).toContain("System health");
    expect(html).toContain("moving");
    expect(html).not.toContain("stuck?");
    for (const figure of [
      "Due now",
      "Sending",
      "Queued",
      "Pending",
      "bounce",
      "complaint",
    ]) {
      expect(html).toContain(figure);
    }
    expect(html).toContain(">12<");
  });

  test("an email overdue past the threshold flags the queue as stuck, with the wait", async () => {
    const html = await render({
      snapshot: snapshot({
        queue: {
          queued: 1,
          sending: 0,
          due: 1,
          oldestDueAgeSeconds: QUEUE_STUCK_AFTER_SECONDS + 420,
        },
      }),
    });
    expect(html).toContain("stuck?");
    expect(html).toContain("12 min");
    expect(html).not.toContain(">moving<");
  });

  test("no active suppressions says so", async () => {
    expect(await render({ snapshot: snapshot({ suppressions: [] }) })).toContain("None.");
  });

  test("a failed database read shows the outage, not zeros", async () => {
    const html = await render({ snapshot: null });
    expect(html).toContain("The database did not answer");
    expect(html).not.toContain("Due now");
  });

  test("a reason label is escaped", async () => {
    const html = await render({
      snapshot: snapshot({ suppressions: [{ reason: "<script>x</script>", count: 1 }] }),
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("formatWait", () => {
  test.each([
    [0, "0 s"],
    [44.6, "45 s"],
    [60, "1 min"],
    [59 * 60 + 59, "59 min"],
    [3600, "1 h"],
    [3 * 3600 + 5 * 60, "3 h 5 min"],
    [-5, "0 s"],
  ])("%p seconds -> %s", (seconds, text) => {
    expect(formatWait(seconds)).toBe(text);
  });
});
