import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import {
  BlockedUrlError,
  buildPinnedRequest,
  type PinnedRequest,
  type PublicWebhookTarget,
} from "../../src/utils/ssrf-guard.ts";

/**
 * Webhook requests are sent to the address the SSRF guard validated, while
 * the receiver still sees the configured host name (Host header) and the
 * certificate is still checked against it (SNI / `tls.serverName`).
 *
 * These tests drive Bun's real `fetch` against local servers on 127.0.0.1
 * with the exact request parts `performHttpAttempt` uses
 * (`buildPinnedRequest`). The guard itself refuses 127.0.0.1, so the test
 * seam is the target: it is built here by hand instead of coming from
 * `resolvePublicWebhookTarget`, which is unchanged and tested on its own.
 *
 * The TLS key and certificate under `test/fixtures/tls/` are a TEST-ONLY
 * self-signed pair for `hook.example.test`.
 */

const FIXTURES = join(import.meta.dir, "..", "fixtures", "tls");
const HOOK_HOST = "hook.example.test";

/** A target as the guard would return it, pinned to `address`. */
function target(
  rawUrl: string,
  address: string,
  family: 4 | 6 = 4,
  isIpLiteral = false,
): PublicWebhookTarget {
  const url = new URL(rawUrl);
  return {
    url,
    hostname: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    isIpLiteral,
    address,
    family,
  };
}

/** Sends one POST the way `performHttpAttempt` does, plus a trusted CA. */
function send(pinned: PinnedRequest, ca?: string): Promise<Response> {
  return fetch(pinned.url, {
    method: "POST",
    headers: { Host: pinned.host, "Content-Type": "application/json" },
    body: "{}",
    tls: pinned.tls && ca ? { ...pinned.tls, ca } : pinned.tls,
    keepalive: false,
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
}

describe("buildPinnedRequest", () => {
  test("http: host replaced by the address, everything else kept", () => {
    const pinned = buildPinnedRequest(
      target("http://hook.example.test:8080/path/x?a=1&b=2", "93.184.216.34"),
    );
    expect(pinned.url).toBe("http://93.184.216.34:8080/path/x?a=1&b=2");
    expect(pinned.host).toBe("hook.example.test:8080");
    expect(pinned.tls).toBeUndefined();
  });

  test("https: default port omitted from Host, TLS bound to the host name", () => {
    const pinned = buildPinnedRequest(
      target("https://hook.example.test/hook", "93.184.216.34"),
    );
    expect(pinned.url).toBe("https://93.184.216.34/hook");
    expect(pinned.host).toBe(HOOK_HOST);
    /** Exactly `serverName`: a custom `checkServerIdentity` would replace
     *  Bun's pre-send certificate check with one that runs after sending. */
    expect(pinned.tls).toEqual({ serverName: HOOK_HOST });
  });

  test("an IPv6 address is bracketed in the URL", () => {
    const pinned = buildPinnedRequest(
      target("https://hook.example.test:8443/h", "2606:4700:4700::1111", 6),
    );
    expect(pinned.url).toBe("https://[2606:4700:4700::1111]:8443/h");
    expect(pinned.host).toBe("hook.example.test:8443");
    expect(pinned.tls?.serverName).toBe(HOOK_HOST);
  });

  test("a trailing dot is dropped from the TLS name only", () => {
    const pinned = buildPinnedRequest(
      target("https://hook.example.test./h", "93.184.216.34"),
    );
    expect(pinned.host).toBe("hook.example.test.");
    expect(pinned.tls?.serverName).toBe(HOOK_HOST);
  });

  test("IP-literal hosts keep the default TLS check against the IP", () => {
    const pinned = buildPinnedRequest(
      target("https://[2606:4700:4700::1111]/h", "2606:4700:4700::1111", 6, true),
    );
    expect(pinned.url).toBe("https://[2606:4700:4700::1111]/h");
    expect(pinned.host).toBe("[2606:4700:4700::1111]");
    expect(pinned.tls).toBeUndefined();
  });

  test("an uncompressed IPv6 address still pins (compared group by group)", () => {
    const pinned = buildPinnedRequest(
      target("https://hook.example.test/h", "2606:4700:4700:0:0:0:0:1111", 6),
    );
    expect(pinned.url).toBe("https://[2606:4700:4700::1111]/h");
  });

  test("fails closed when the address cannot become the URL host", () => {
    for (const [address, family] of [
      ["evil.example", 4], // not an IP: the setter would accept it as a name
      ["93.184.216.34/x", 4], // the setter would keep only part of it
      ["2606:4700:4700::1111%eth0", 6], // zone id: the setter keeps the old host
      ["not:an:ip", 6],
      ["93.184.216.34", 6], // family mismatch
    ] as const) {
      expect(() =>
        buildPinnedRequest(target("https://hook.example.test/h", address, family)),
      ).toThrow(BlockedUrlError);
    }
  });
});

describe("pinned requests through Bun's fetch (local servers)", () => {
  let key = "";
  let cert = "";
  let plain: ReturnType<typeof Bun.serve>;
  let secure: ReturnType<typeof Bun.serve>;
  /** Every request either server received since the last reset. */
  const seen: Array<{ host: string | null; path: string }> = [];

  beforeAll(async () => {
    key = await Bun.file(join(FIXTURES, `${HOOK_HOST}.key.pem`)).text();
    cert = await Bun.file(join(FIXTURES, `${HOOK_HOST}.cert.pem`)).text();
    const handler = (req: Request): Response => {
      const url = new URL(req.url);
      seen.push({ host: req.headers.get("host"), path: url.pathname + url.search });
      return new Response("received");
    };
    plain = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    secure = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key, cert },
      fetch: handler,
    });
  });

  afterAll(async () => {
    await plain.stop(true);
    await secure.stop(true);
  });

  test("http: the pinned IP is reached and the server sees the original Host", async () => {
    seen.length = 0;
    const pinned = buildPinnedRequest(
      target(`http://${HOOK_HOST}:${plain.port}/hook?x=1`, "127.0.0.1"),
    );
    expect(pinned.url).toBe(`http://127.0.0.1:${plain.port}/hook?x=1`);

    const res = await send(pinned);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("received");
    expect(seen).toEqual([{ host: `${HOOK_HOST}:${plain.port}`, path: "/hook?x=1" }]);
  });

  test("https: certificate verified against the host name, not the IP", async () => {
    seen.length = 0;
    const pinned = buildPinnedRequest(
      target(`https://${HOOK_HOST}:${secure.port}/hook`, "127.0.0.1"),
    );
    expect(pinned.url).toBe(`https://127.0.0.1:${secure.port}/hook`);

    const res = await send(pinned, cert);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("received");
    expect(seen).toEqual([{ host: `${HOOK_HOST}:${secure.port}`, path: "/hook" }]);
  });

  test("https: a certificate that does not match the host name is refused", async () => {
    seen.length = 0;
    /** Same server and certificate, configured for another name. */
    const pinned = buildPinnedRequest(
      target(`https://other.example.test:${secure.port}/hook`, "127.0.0.1"),
    );
    expect(pinned.tls?.serverName).toBe("other.example.test");

    const err = await send(pinned, cert).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err instanceof Error ? err.message : "").toMatch(/ALTNAME|altnames|match/);
    /** Refused during the handshake: no request reached the server. */
    expect(seen).toEqual([]);
  });

  test("https: an untrusted certificate is still refused", async () => {
    seen.length = 0;
    const pinned = buildPinnedRequest(
      target(`https://${HOOK_HOST}:${secure.port}/hook`, "127.0.0.1"),
    );
    /** No `ca`: the self-signed fixture is not trusted. */
    const err = await send(pinned).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(seen).toEqual([]);
  });

  test("https: each request checks the certificate, even right after a success", async () => {
    const good = buildPinnedRequest(
      target(`https://${HOOK_HOST}:${secure.port}/a`, "127.0.0.1"),
    );
    const bad = buildPinnedRequest(
      target(`https://other.example.test:${secure.port}/b`, "127.0.0.1"),
    );
    const first = await send(good, cert);
    expect(first.status).toBe(200);
    await first.text();
    seen.length = 0;
    /** Same address and port: no pooled connection may skip the check. */
    const err = await send(bad, cert).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(seen).toEqual([]);
  });
});
