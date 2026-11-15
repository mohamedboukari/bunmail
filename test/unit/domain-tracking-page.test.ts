import { describe, test, expect } from "bun:test";
import { TrackingPanel } from "../../src/pages/routes/domain-detail-tracking.tsx";

/**
 * The domain page's open and click tracking panel (#187): two checkboxes
 * posting to `/dashboard/domains/:id/tracking`, ticked from the stored
 * opt-in, and a note while `TRACKING_ENABLED` keeps everything off.
 * Plus "Revoke tracking links" (#424), a confirmed POST.
 */

const domain = {
  id: "dom_track",
  trackOpens: false,
  trackClicks: false,
  trackingEpoch: 0,
};

/** The `<input>` tag of the checkbox named `name`. */
function checkbox(html: string, name: string): string {
  const match = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`));
  if (!match) throw new Error(`no ${name} checkbox`);
  return match[0];
}

describe("TrackingPanel", () => {
  test("posts both checkboxes to the domain's tracking route", async () => {
    const html = await TrackingPanel({ domain, trackingEnabled: true });
    expect(html).toContain('action="/dashboard/domains/dom_track/tracking"');
    expect(checkbox(html, "trackOpens")).toContain('value="true"');
    expect(checkbox(html, "trackClicks")).toContain('value="true"');
  });

  test("ticks the boxes from the stored opt-in", async () => {
    const off = await TrackingPanel({ domain, trackingEnabled: true });
    expect(checkbox(off, "trackOpens")).not.toContain("checked");
    expect(checkbox(off, "trackClicks")).not.toContain("checked");

    const on = await TrackingPanel({
      domain: { ...domain, trackOpens: true, trackClicks: false },
      trackingEnabled: true,
    });
    expect(checkbox(on, "trackOpens")).toContain("checked");
    expect(checkbox(on, "trackClicks")).not.toContain("checked");
  });

  test("says when TRACKING_ENABLED keeps everything off", async () => {
    const disabled = await TrackingPanel({ domain, trackingEnabled: false });
    expect(disabled).toContain("TRACKING_ENABLED is off on this server");
    const enabled = await TrackingPanel({ domain, trackingEnabled: true });
    expect(enabled).not.toContain("TRACKING_ENABLED is off on this server");
  });

  test("carries the unreliability caveat", async () => {
    const html = await TrackingPanel({ domain, trackingEnabled: true });
    expect(html).toContain("Open counts are unreliable");
  });

  test("revoke tracking links: a confirmed POST to the domain's revoke route (#424)", async () => {
    const html = await TrackingPanel({ domain, trackingEnabled: true });
    const form = html.match(
      /<form method="POST" action="\/dashboard\/domains\/dom_track\/tracking-revoke">[\s\S]*?<\/form>/,
    );
    expect(form?.[0]).toContain("data-confirm=");
    expect(form?.[0]).toContain("Revoke tracking links");
    expect(html).not.toContain("so far.");
    const revoked = await TrackingPanel({
      domain: { ...domain, trackingEpoch: 2 },
      trackingEnabled: true,
    });
    expect(revoked).toContain("Revoked 2 times so far.");
  });
});
