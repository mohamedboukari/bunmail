import { expect } from "bun:test";

/**
 * The provider URL an SSO start's hand-off page (#409) sends the browser
 * to. Checks what a browser relies on: a `200` HTML page, no `location`
 * (a cross-origin `302` after the form POST is blocked by CSP
 * `form-action 'self'`), and a meta refresh and a fallback link that
 * point to the same URL. The attribute's `&amp;` is decoded back to `&`.
 *
 * A response that is not a hand-off (a refusal's redirect, a `429`)
 * fails the expectations; read `response.status` before calling this.
 */
export function handoffTargetOf(response: Response, html: string): string {
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("content-type") ?? "").toContain("text/html");
  const refresh = html.match(/<meta http-equiv="refresh" content="0;url=([^"]*)"/)?.[1];
  const link = html.match(/<a href="([^"]*)"/)?.[1];
  expect(refresh).toBeDefined();
  expect(link).toBe(refresh);
  /** Every `&` of the URL is escaped in the attribute. */
  expect(refresh).not.toMatch(/&(?!amp;)/);
  return (refresh ?? "").replaceAll("&amp;", "&");
}
