import { describe, expect, test } from "bun:test";
import {
  BIMI_LOGO_MAX_BYTES,
  checkBimiLogo,
  fetchBimiLogo,
  type BimiLogoDeps,
} from "../../src/modules/domains/services/bimi-logo.ts";

/**
 * The BIMI logo fetch (#415). The `l=` URL is chosen by whoever controls
 * the domain's DNS, so it goes through the webhook SSRF guard: https only,
 * public addresses only, pinned, no redirects, a size cap and a time cap.
 * The fetch and the address lookup are replaced: no request leaves the
 * machine.
 */

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 10 10"><title>Acme</title><rect width="10" height="10"/></svg>`;

/** One recorded call of the fake fetch. */
interface Call {
  url: string;
  init: BunFetchRequestInit;
}

function deps(
  respond: (call: Call) => Promise<Response> | Response,
  addresses: string[] = ["93.184.216.34"],
  timeoutMs = 1_000,
): { deps: BimiLogoDeps; calls: Call[]; lookups: string[] } {
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

/** An SVG response. */
function svgResponse(
  body: string | Uint8Array,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "image/svg+xml", ...headers },
  });
}

describe("fetchBimiLogo", () => {
  test("GETs the logo from the checked address, pinned to the host name", async () => {
    const fake = deps(() => svgResponse(LOGO));
    const result = await fetchBimiLogo(
      "https://brand.example.com/logo.svg?v=2",
      fake.deps,
    );
    expect(result).toEqual({ kind: "fetched", body: LOGO, contentType: "image/svg+xml" });
    expect(fake.lookups).toEqual(["brand.example.com"]);
    const [call] = fake.calls;
    expect(call?.url).toBe("https://93.184.216.34/logo.svg?v=2");
    expect(call?.init.method).toBe("GET");
    expect(call?.init.redirect).toBe("manual");
    expect(call?.init.keepalive).toBe(false);
    expect(call?.init.decompress).toBe(false);
    expect(call?.init.tls).toEqual({
      serverName: "brand.example.com",
      rejectUnauthorized: true,
    });
    expect(new Headers(call?.init.headers).get("host")).toBe("brand.example.com");
  });

  test("http is refused without a lookup or a request", async () => {
    const fake = deps(() => svgResponse(LOGO));
    const result = await fetchBimiLogo("http://brand.example.com/logo.svg", fake.deps);
    expect(result.kind).toBe("refused");
    expect(fake.lookups).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  test("a private, loopback or metadata address is refused, never fetched", async () => {
    for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "::1"]) {
      const fake = deps(() => svgResponse(LOGO), [address]);
      const result = await fetchBimiLogo("https://brand.example.com/logo.svg", fake.deps);
      expect(result).toMatchObject({ kind: "refused" });
      expect(fake.calls).toEqual([]);
    }
    /** One private address among public ones is enough. */
    const mixed = deps(() => svgResponse(LOGO), ["93.184.216.34", "192.168.1.1"]);
    expect(
      (await fetchBimiLogo("https://brand.example.com/l.svg", mixed.deps)).kind,
    ).toBe("refused");
    /** An IP literal is checked directly. */
    const literal = deps(() => svgResponse(LOGO));
    expect((await fetchBimiLogo("https://127.0.0.1/l.svg", literal.deps)).kind).toBe(
      "refused",
    );
    expect(literal.lookups).toEqual([]);
  });

  test("a host that does not resolve is a temporary failure", async () => {
    const fake = deps(() => svgResponse(LOGO), []);
    expect(await fetchBimiLogo("https://brand.example.com/l.svg", fake.deps)).toEqual({
      kind: "failed",
      reason: "The logo host could not be resolved",
    });
    const throwing: BimiLogoDeps = {
      ...fake.deps,
      resolver: () => Promise.reject(new Error("ENOTFOUND")),
    };
    expect((await fetchBimiLogo("https://brand.example.com/l.svg", throwing)).kind).toBe(
      "failed",
    );
  });

  test("a redirect is not followed: it fails", async () => {
    const fake = deps(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/latest/meta-data" },
        }),
    );
    const result = await fetchBimiLogo("https://brand.example.com/logo.svg", fake.deps);
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.reason).toContain("redirects (HTTP 302)");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.init.redirect).toBe("manual");
  });

  test("the size cap: by Content-Length, and while reading a body without one", async () => {
    const big = "x".repeat(BIMI_LOGO_MAX_BYTES + 1);
    const declared = deps(() =>
      svgResponse("<svg/>", { "content-length": String(BIMI_LOGO_MAX_BYTES + 1) }),
    );
    const byHeader = await fetchBimiLogo(
      "https://brand.example.com/l.svg",
      declared.deps,
    );
    expect(byHeader.kind === "refused" && byHeader.reason).toContain("larger than 32 KB");

    /** A stream with no length: the read stops past the cap. */
    let pulled = 0;
    const streamed = deps(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled++;
              controller.enqueue(new TextEncoder().encode(big.slice(0, 8_192)));
            },
          }),
          { status: 200, headers: { "content-type": "image/svg+xml" } },
        ),
    );
    const byRead = await fetchBimiLogo("https://brand.example.com/l.svg", streamed.deps);
    expect(byRead.kind === "refused" && byRead.reason).toContain("larger than 32 KB");
    expect(pulled).toBeLessThan(10);

    /** Exactly the cap is fine. */
    const exact = deps(() => svgResponse("x".repeat(BIMI_LOGO_MAX_BYTES)));
    expect(
      (await fetchBimiLogo("https://brand.example.com/l.svg", exact.deps)).kind,
    ).toBe("fetched");
  });

  test("statuses, encodings and timeouts", async () => {
    const url = "https://brand.example.com/l.svg";
    expect(
      (await fetchBimiLogo(url, deps(() => new Response("", { status: 404 })).deps)).kind,
    ).toBe("refused");
    expect(
      (await fetchBimiLogo(url, deps(() => new Response("", { status: 503 })).deps)).kind,
    ).toBe("failed");
    const gzipped = await fetchBimiLogo(
      url,
      deps(() => svgResponse(LOGO, { "content-encoding": "gzip" })).deps,
    );
    expect(gzipped.kind === "refused" && gzipped.reason).toContain("compressed");
    const notUtf8 = await fetchBimiLogo(
      url,
      deps(() => svgResponse(new Uint8Array([0xff, 0xfe, 0x00]))).deps,
    );
    expect(notUtf8).toEqual({ kind: "refused", reason: "The logo is not UTF-8 text" });
    const connectionError = await fetchBimiLogo(
      url,
      deps(() => Promise.reject(new Error("https://brand.example.com/l.svg failed")))
        .deps,
    );
    /** The fetch error's own message (which can carry the URL) is never used. */
    expect(connectionError).toEqual({
      kind: "failed",
      reason: "The logo fetch failed (connection or TLS certificate)",
    });
    const hung = deps(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener("abort", () =>
            reject(call.init.signal?.reason),
          );
        }),
      undefined,
      50,
    );
    expect(await fetchBimiLogo(url, hung.deps)).toEqual({
      kind: "failed",
      reason: "The logo fetch timed out",
    });
  });
});

describe("checkBimiLogo", () => {
  test("a valid logo passes", async () => {
    const part = await checkBimiLogo(
      "https://brand.example.com/l.svg",
      deps(() => svgResponse(LOGO)).deps,
    );
    expect(part.outcome).toBe("pass");
    expect(part.findings).toHaveLength(1);
    expect(part.findings[0]).toMatchObject({ area: "logo", severity: "pass" });
  });

  test("each broken rule is a finding; a wrong Content-Type is a warning", async () => {
    const bad = LOGO.replace('baseProfile="tiny-ps"', 'baseProfile="full"').replace(
      "<rect",
      "<script>x</script><rect",
    );
    const part = await checkBimiLogo(
      "https://brand.example.com/l.svg",
      deps(() => svgResponse(bad, { "content-type": "text/html" })).deps,
    );
    expect(part.outcome).toBe("fail");
    expect(part.findings.map((f) => f.severity)).toEqual(["fail", "fail", "warn"]);
    expect(part.findings[2]?.text).toContain("text/html");
  });

  test("a refused URL fails, a temporary failure is unknown", async () => {
    expect(
      (
        await checkBimiLogo(
          "https://brand.example.com/l.svg",
          deps(() => svgResponse(LOGO), ["10.0.0.1"]).deps,
        )
      ).outcome,
    ).toBe("fail");
    expect(
      (
        await checkBimiLogo(
          "https://brand.example.com/l.svg",
          deps(() => new Response("", { status: 500 })).deps,
        )
      ).outcome,
    ).toBe("unknown");
  });
});
