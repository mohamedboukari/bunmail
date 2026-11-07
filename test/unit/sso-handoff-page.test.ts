import { describe, expect, test } from "bun:test";
import { SsoHandoffPage } from "../../src/pages/routes/sso-handoff.tsx";

/**
 * The SSO hand-off page (#409): what the two SSO start routes answer
 * instead of a `302`, which CSP `form-action 'self'` would block after the
 * form POST. A meta refresh and a fallback link to the same URL, the
 * URL's `&` escaped, the operator-set label escaped.
 */

/** An authorization URL as `startSsoFlow` builds it: several query parameters. */
const URL_WITH_PARAMS =
  "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=abc&redirect_uri=https%3A%2F%2Fmail.example.com%2Fdashboard%2Flogin%2Fsso%2Fgoogle%2Fcallback&scope=openid+email+profile&state=s1&nonce=n1&code_challenge=c1&code_challenge_method=S256";

/** The meta refresh target and the link target, both still HTML-encoded. */
function targetsOf(html: string): {
  refresh: string | undefined;
  link: string | undefined;
} {
  return {
    refresh: html.match(/<meta http-equiv="refresh" content="0;url=([^"]*)"/)?.[1],
    link: html.match(/<a href="([^"]*)"/)?.[1],
  };
}

describe("SsoHandoffPage (#409)", () => {
  test("a meta refresh and a link to the same URL, every & escaped", async () => {
    const html = await SsoHandoffPage({
      label: "Google",
      authorizationUrl: URL_WITH_PARAMS,
    });
    const { refresh, link } = targetsOf(html);
    expect(refresh).toBe(URL_WITH_PARAMS.replaceAll("&", "&amp;"));
    expect(link).toBe(refresh);
    expect(html).toContain("Continue to Google");
  });

  test("the operator-set label is escaped", async () => {
    const html = await SsoHandoffPage({
      label: `<script>alert("x")</script>`,
      authorizationUrl: URL_WITH_PARAMS,
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  test("no inline script: the page works under the dashboard CSP", async () => {
    const html = await SsoHandoffPage({
      label: "Google",
      authorizationUrl: URL_WITH_PARAMS,
    });
    /** Only the dashboard's own script file (`script-src 'self'`), no inline code. */
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
});
