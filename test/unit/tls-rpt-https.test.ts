import { describe, expect, test } from "bun:test";
import {
  postReport,
  type TlsRptHttpsDeps,
} from "../../src/modules/tls-rpt/services/tls-rpt-https.service.ts";

/**
 * HTTPS delivery of a TLS report (RFC 8460 section 5.4, #345). The URL is
 * chosen by the recipient domain, so it goes through the webhook SSRF guard:
 * public addresses only, pinned, no redirects, a time cap, the response
 * never read. The fetch and the DNS lookup are replaced: no request leaves
 * the machine.
 */

const BODY = new Uint8Array([0x1f, 0x8b, 1, 2, 3]);

/** One recorded call of the fake fetch. */
interface Call {
  url: string;
  init: BunFetchRequestInit;
}

function deps(
  respond: (call: Call) => Promise<Response> | Response,
  addresses: string[] = ["93.184.216.34"],
  timeoutMs = 1_000,
): { deps: TlsRptHttpsDeps; calls: Call[]; lookups: string[] } {
  const calls: Call[] = [];
  const lookups: string[] = [];
  return {
    calls,
    lookups,
    deps: {
      fetch: async (url, init) => {
        const call = { url, init };
        calls.push(call);
        return respond(call);
      },
      resolver: async (host) => {
        lookups.push(host);
        return addresses.map((address) => ({ address }));
      },
      timeoutMs,
    },
  };
}

describe("postReport", () => {
  test("POSTs the gzipped report to the checked address, pinned to the host name", async () => {
    const fake = deps(() => new Response(null, { status: 201 }));
    const outcome = await postReport(
      "https://reports.example.com/v1/tlsrpt?k=secret",
      BODY,
      fake.deps,
    );
    expect(outcome).toEqual({ kind: "sent" });
    expect(fake.lookups).toEqual(["reports.example.com"]);
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call?.url).toBe("https://93.184.216.34/v1/tlsrpt?k=secret");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers).toEqual({
      Host: "reports.example.com",
      "Content-Type": "application/tlsrpt+gzip",
      "Accept-Encoding": "identity",
    });
    expect(call?.init.body).toBe(BODY);
    expect(call?.init.tls).toEqual({
      serverName: "reports.example.com",
      rejectUnauthorized: true,
    });
    expect(call?.init.redirect).toBe("manual");
    expect(call?.init.keepalive).toBe(false);
    expect(call?.init.decompress).toBe(false);
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test.each([
    ["loopback", ["127.0.0.1"]],
    ["private", ["10.1.2.3"]],
    ["cloud metadata", ["169.254.169.254"]],
    ["IPv6 loopback", ["::1"]],
    ["one public and one private address", ["93.184.216.34", "192.168.1.10"]],
  ])(
    "a host resolving to a %s address is refused, nothing sent",
    async (_name, addresses) => {
      const fake = deps(() => new Response(null, { status: 200 }), addresses);
      const outcome = await postReport("https://reports.example.com/r", BODY, fake.deps);
      expect(outcome).toEqual({
        kind: "failed",
        reason: "target refused (not a public https address)",
      });
      expect(fake.calls).toHaveLength(0);
    },
  );

  test.each([
    "https://127.0.0.1/r",
    "https://[::ffff:10.0.0.1]/r",
    "http://reports.example.com/r",
    "ftp://reports.example.com/r",
  ])("refuses %p without a request", async (url) => {
    const fake = deps(() => new Response(null, { status: 200 }));
    expect((await postReport(url, BODY, fake.deps)).kind).toBe("failed");
    expect(fake.calls).toHaveLength(0);
  });

  test("a redirect is a failure and is never followed", async () => {
    const fake = deps(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/meta-data/" },
        }),
    );
    const outcome = await postReport("https://reports.example.com/r", BODY, fake.deps);
    expect(outcome).toEqual({ kind: "failed", reason: "HTTP 302" });
    expect(fake.calls).toHaveLength(1);
  });

  test("a non-2xx status fails; any 2xx is sent", async () => {
    for (const [status, kind] of [
      [200, "sent"],
      [202, "sent"],
      [204, "sent"],
      [400, "failed"],
      [500, "failed"],
    ] as const) {
      const fake = deps(() => new Response(null, { status }));
      expect(
        (await postReport("https://reports.example.com/r", BODY, fake.deps)).kind,
      ).toBe(kind);
    }
  });

  test("past the time cap the request is aborted and fails", async () => {
    const fake = deps(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener("abort", () =>
            reject(call.init.signal?.reason),
          );
        }),
      ["93.184.216.34"],
      50,
    );
    const started = Date.now();
    const outcome = await postReport("https://reports.example.com/r", BODY, fake.deps);
    expect(outcome).toEqual({ kind: "failed", reason: "timed out" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("the response body is never read, only cancelled", async () => {
    let pulls = 0;
    let cancelled = false;
    const huge = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fake = deps(() => new Response(huge, { status: 200 }));
    expect(
      (await postReport("https://reports.example.com/r", BODY, fake.deps)).kind,
    ).toBe("sent");
    expect(cancelled).toBe(true);
    /** At most the stream's own first pull, never a read loop. */
    expect(pulls).toBeLessThanOrEqual(1);
  });

  test("a connection error fails without leaking its text", async () => {
    const fake = deps(() => {
      throw new Error("connect ECONNREFUSED 93.184.216.34:443 /v1/secret-path");
    });
    expect(
      await postReport("https://reports.example.com/v1/secret-path", BODY, fake.deps),
    ).toEqual({
      kind: "failed",
      reason: "connection failed",
    });
  });
});
