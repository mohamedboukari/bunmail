import { describe, test, expect } from "bun:test";
import { composeMessageBody } from "../../src/modules/emails/services/message-body.ts";
import { insertOpenPixel } from "../../src/modules/tracking/services/body-tracking.ts";
import {
  trackingForEmail,
  type TrackedEmail,
  type TrackingSettings,
} from "../../src/modules/tracking/services/tracking-injection.ts";
import {
  clientKindOf,
  storedClickUrl,
} from "../../src/modules/tracking/services/tracking-client.ts";
import {
  deriveTrackingKeys,
  verifyClickToken,
} from "../../src/modules/tracking/services/tracking-token.ts";

/**
 * Tracking in the composed body (#187): what `trackingForEmail` builds
 * for an email, the order inside `composeMessageBody` (text alternative
 * from the original HTML, then links, then the pixel), determinism (same
 * body on every retry), and the client helpers.
 */

const keys = deriveTrackingKeys(Buffer.alloc(32, 3));
const settings: TrackingSettings = {
  enabled: true,
  appBaseUrl: "https://mail.example.com",
  keys,
};
const email: TrackedEmail = {
  id: "msg_0123456789abcdef01234567",
  toAddress: "user@example.org",
  cc: null,
  bcc: null,
  trackOpens: true,
  trackClicks: true,
};
const HTML = `<p>Hello, see <a href="https://example.com/pricing?ref=mail">pricing</a>.</p><p><a href="https://example.com/leave">unsubscribe</a></p>`;

describe("trackingForEmail", () => {
  test("both kinds: a pixel URL and link options", () => {
    const tracking = trackingForEmail(email, null, settings);
    expect(tracking?.pixelUrl).toMatch(
      /^https:\/\/mail\.example\.com\/t\/o\/[0-9a-f]{24}\.[0-9a-f]{32}\.gif$/,
    );
    expect(tracking?.links?.ownHost).toBe("mail.example.com");
    expect(tracking?.links?.unsubscribeUrl).toBeNull();
  });

  test("only what the row says, and nothing when it says neither", () => {
    expect(
      trackingForEmail({ ...email, trackClicks: false }, null, settings)?.links,
    ).toBeNull();
    expect(
      trackingForEmail({ ...email, trackOpens: false }, null, settings)?.pixelUrl,
    ).toBeNull();
    expect(
      trackingForEmail(
        { ...email, trackOpens: false, trackClicks: false },
        null,
        settings,
      ),
    ).toBeUndefined();
  });

  test("nothing while TRACKING_ENABLED is off (checked at send time)", () => {
    expect(
      trackingForEmail(email, null, { ...settings, enabled: false }),
    ).toBeUndefined();
  });

  test("nothing without one recipient or an https APP_BASE_URL", () => {
    expect(
      trackingForEmail({ ...email, cc: "x@example.org" }, null, settings),
    ).toBeUndefined();
    expect(
      trackingForEmail(
        { ...email, toAddress: "a@example.org, b@example.org" },
        null,
        settings,
      ),
    ).toBeUndefined();
    expect(
      trackingForEmail(email, null, {
        ...settings,
        appBaseUrl: "http://mail.example.com",
      }),
    ).toBeUndefined();
  });

  test("the domain's unsubscribe URL is skipped, canonical", () => {
    const tracking = trackingForEmail(email, "https://Example.com/leave", settings);
    expect(tracking?.links?.unsubscribeUrl).toBe("https://example.com/leave");
  });
});

describe("composeMessageBody with tracking", () => {
  const tracking = trackingForEmail(email, "https://example.com/leave", settings);

  test("the text part comes from the original HTML: no tracking URL in it", () => {
    const body = composeMessageBody(HTML, null, tracking);
    expect(body.textDerived).toBe(true);
    expect(body.text).toContain("https://example.com/pricing?ref=mail");
    expect(body.text).not.toContain("/t/");
  });

  test("links rewritten, unsubscribe link kept, pixel before </body>", () => {
    const body = composeMessageBody(HTML, null, tracking);
    const html = body.html ?? "";
    expect(body.tracked).toEqual({ links: 1, pixel: true });
    expect(html).not.toContain("https://example.com/pricing?ref=mail");
    expect(html).toContain(`<a href="https://example.com/leave">`);
    expect(html).toMatch(
      /<img src="https:\/\/mail\.example\.com\/t\/o\/[^"]+\.gif" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px"><\/body><\/html>$/,
    );
    const href =
      /href="https:\/\/mail\.example\.com\/t\/c\/([^"]+)"/.exec(html)?.[1] ?? "";
    expect(verifyClickToken(href, keys)).toEqual({
      emailId: email.id,
      position: 0,
      url: "https://example.com/pricing?ref=mail",
    });
  });

  test("a caller's own text part is kept untouched", () => {
    const body = composeMessageBody(
      HTML,
      "My text https://example.com/pricing",
      tracking,
    );
    expect(body.text).toBe("My text https://example.com/pricing");
  });

  test("deterministic: a retry composes the same body, so the DKIM body hash is stable", () => {
    const again = trackingForEmail(email, "https://example.com/leave", settings);
    expect(composeMessageBody(HTML, null, again)).toEqual(
      composeMessageBody(HTML, null, tracking),
    );
  });

  test("without tracking the body is as before", () => {
    const body = composeMessageBody(HTML, null);
    expect(body.tracked).toBeUndefined();
    expect(body.html).toContain("https://example.com/pricing?ref=mail");
  });
});

describe("insertOpenPixel", () => {
  const url = "https://mail.example.com/t/o/x.gif";

  test("before the last </body>, any case", () => {
    expect(insertOpenPixel("<html><BODY>a</BODY></html>", url)).toBe(
      `<html><BODY>a<img src="${url}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px"></BODY></html>`,
    );
    expect(insertOpenPixel("<body>a</body><p>x</p></body>", url)).toMatch(
      /<\/body><p>x<\/p><img/,
    );
  });

  test("a </body> inside a comment or script is not the place", () => {
    expect(
      insertOpenPixel("<body>a</body><!-- </body> --><script>'</body>'</script>", url),
    ).toMatch(/^<body>a<img src=[^>]+><\/body><!--/);
  });

  test("at the end without a </body>", () => {
    expect(insertOpenPixel("<p>a</p>", url)).toMatch(/^<p>a<\/p><img src=/);
  });
});

describe("tracking-client", () => {
  test("known mail image proxies, else unknown", () => {
    expect(
      clientKindOf(
        "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)",
      ),
    ).toBe("image_proxy");
    expect(
      clientKindOf(
        "YahooMailProxy; https://help.yahoo.com/kb/yahoo-mail-proxy-SLN28749.html",
      ),
    ).toBe("image_proxy");
    expect(clientKindOf("Mozilla/5.0 (Macintosh)")).toBe("unknown");
    expect(clientKindOf(null)).toBe("unknown");
    expect(clientKindOf("")).toBe("unknown");
  });

  test("stored click URLs drop query, fragment and credentials", () => {
    expect(storedClickUrl("https://user:pw@example.com/a/b?token=secret#frag")).toBe(
      "https://example.com/a/b",
    );
  });
});
