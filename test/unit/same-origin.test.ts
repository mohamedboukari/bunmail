import { describe, test, expect } from "bun:test";
import {
  appBaseOrigin,
  expectedOriginLabel,
  isSameOrigin,
} from "../../src/pages/lib/same-origin.ts";

/**
 * The dashboard CSRF origin check (#133, #420). With a usable
 * `APP_BASE_URL` the full origin (scheme, host, port) of `Origin` (or
 * `Referer` when `Origin` is absent) must equal the configured one, whatever
 * the request URL and `Host` say (behind a reverse proxy they name the
 * container). Without one, the host comparison of #133 is kept. The base
 * URL is passed explicitly, so no `config` is involved.
 */

/** The public URL of an `https://` deployment. */
const BASE = "https://mail.example.com";

/** What the container sees behind a reverse proxy. */
const INTERNAL_URL = "http://127.0.0.1:3000/dashboard/api-keys";

/**
 * A POST to `url` with the given headers.
 *
 * @param headers Request headers, e.g. `origin`, `referer`, `host`.
 * @param url The request URL, the internal bind address by default.
 */
function post(headers: Record<string, string>, url: string = INTERNAL_URL): Request {
  return new Request(url, { method: "POST", headers });
}

describe("with APP_BASE_URL set: full origin of APP_BASE_URL", () => {
  test("the public origin passes behind a proxy (request URL is the container)", () => {
    expect(isSameOrigin(post({ origin: BASE }), BASE)).toBe(true);
    expect(isSameOrigin(post({ origin: BASE, host: "127.0.0.1:3000" }), BASE)).toBe(true);
  });

  test("a scheme mismatch is refused (#420)", () => {
    expect(isSameOrigin(post({ origin: "http://mail.example.com" }), BASE)).toBe(false);
    expect(
      isSameOrigin(
        post({ origin: "https://mail.example.com" }),
        "http://mail.example.com",
      ),
    ).toBe(false);
  });

  test("a port mismatch is refused", () => {
    expect(isSameOrigin(post({ origin: "https://mail.example.com:8443" }), BASE)).toBe(
      false,
    );
    expect(
      isSameOrigin(
        post({ origin: "https://mail.example.com" }),
        "https://mail.example.com:8443",
      ),
    ).toBe(false);
  });

  test.each([
    ["https://mail.example.com", "https://mail.example.com:443"],
    ["https://mail.example.com:443", "https://mail.example.com"],
    ["http://mail.example.com", "http://mail.example.com:80"],
    ["http://mail.example.com:80", "http://mail.example.com"],
  ])("default ports are the same origin: base %p, Origin %p", (base, origin) => {
    expect(isSameOrigin(post({ origin }), base)).toBe(true);
  });

  test("a path or trailing slash on APP_BASE_URL does not matter", () => {
    expect(isSameOrigin(post({ origin: BASE }), `${BASE}/`)).toBe(true);
    expect(isSameOrigin(post({ origin: BASE }), `${BASE}/bunmail`)).toBe(true);
  });

  test("another host is refused", () => {
    expect(isSameOrigin(post({ origin: "https://evil.example" }), BASE)).toBe(false);
    expect(
      isSameOrigin(post({ origin: "https://mail.example.com.evil.example" }), BASE),
    ).toBe(false);
  });

  test("the request host no longer counts: Origin matching only the request URL is refused", () => {
    /** Through a proxy (it adds `X-Forwarded-For`) the internal origin is refused. */
    expect(
      isSameOrigin(
        post({
          origin: "http://127.0.0.1:3000",
          host: "127.0.0.1:3000",
          "x-forwarded-for": "203.0.113.7",
        }),
        BASE,
      ),
    ).toBe(false);
    expect(
      isSameOrigin(
        post(
          { origin: "http://mail.example.com", host: "mail.example.com" },
          "http://mail.example.com/dashboard",
        ),
        BASE,
      ),
    ).toBe(false);
  });

  test("a Referer is the fallback when Origin is absent", () => {
    expect(isSameOrigin(post({ referer: `${BASE}/dashboard/api-keys?x=1` }), BASE)).toBe(
      true,
    );
    expect(
      isSameOrigin(post({ referer: "http://mail.example.com/dashboard/api-keys" }), BASE),
    ).toBe(false);
    expect(
      isSameOrigin(post({ referer: "https://mail.example.com:8443/dashboard" }), BASE),
    ).toBe(false);
  });

  test("a present Origin wins over a matching Referer", () => {
    expect(
      isSameOrigin(
        post({ origin: "https://evil.example", referer: `${BASE}/dashboard` }),
        BASE,
      ),
    ).toBe(false);
    expect(
      isSameOrigin(post({ origin: "null", referer: `${BASE}/dashboard` }), BASE),
    ).toBe(false);
  });

  test.each([
    ["null"],
    [""],
    ["mail.example.com"],
    ["https://"],
    ["https://mail.example.com, https://evil.example"],
    ["data:text/html,hi"],
    ["file:///etc/passwd"],
    ["javascript:alert(1)"],
  ])("Origin %p is refused", (origin) => {
    expect(isSameOrigin(post({ origin }), BASE)).toBe(false);
  });

  test("neither Origin nor Referer is refused", () => {
    expect(isSameOrigin(post({}), BASE)).toBe(false);
  });
});

describe("with APP_BASE_URL set: the SSH-tunnel loopback exception (#420)", () => {
  /** `ssh -L 3000:127.0.0.1:3000`: the browser on `http://localhost:3000`. */
  const TUNNEL_URL = "http://localhost:3000/dashboard/login";

  test("the tunnel passes: loopback Origin equal to the request's own origin", () => {
    expect(
      isSameOrigin(
        post({ origin: "http://localhost:3000", host: "localhost:3000" }, TUNNEL_URL),
        BASE,
      ),
    ).toBe(true);
    expect(
      isSameOrigin(
        post(
          { referer: "http://localhost:3000/dashboard/login", host: "localhost:3000" },
          TUNNEL_URL,
        ),
        BASE,
      ),
    ).toBe(true);
    expect(
      isSameOrigin(
        post(
          { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" },
          "http://127.0.0.1:3000/x",
        ),
        BASE,
      ),
    ).toBe(true);
    expect(
      isSameOrigin(
        post({ origin: "http://[::1]:3000", host: "[::1]:3000" }, "http://[::1]:3000/x"),
        BASE,
      ),
    ).toBe(true);
    expect(
      isSameOrigin(
        post(
          { origin: "http://127.8.9.10:3000", host: "127.8.9.10:3000" },
          "http://127.8.9.10:3000/x",
        ),
        BASE,
      ),
    ).toBe(true);
  });

  test("a loopback Origin with the public Host (through the proxy) is refused", () => {
    const proxied = "http://mail.example.com/dashboard/login";
    for (const origin of [
      "http://localhost",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ]) {
      expect(
        isSameOrigin(post({ origin, host: "mail.example.com" }, proxied), BASE),
      ).toBe(false);
    }
    /** And a hostile origin is not loopback at all. */
    expect(
      isSameOrigin(
        post({ origin: "https://evil.example", host: "mail.example.com" }, proxied),
        BASE,
      ),
    ).toBe(false);
  });

  test("a loopback Origin on another loopback port or name is refused", () => {
    expect(
      isSameOrigin(
        post({ origin: "http://localhost:8080", host: "localhost:3000" }, TUNNEL_URL),
        BASE,
      ),
    ).toBe(false);
    expect(
      isSameOrigin(
        post({ origin: "http://localhost", host: "localhost:3000" }, TUNNEL_URL),
        BASE,
      ),
    ).toBe(false);
    expect(
      isSameOrigin(
        post({ origin: "http://127.0.0.1:3000", host: "localhost:3000" }, TUNNEL_URL),
        BASE,
      ),
    ).toBe(false);
  });

  test("the scheme must be the request's: https://localhost:3000 over plain http is refused", () => {
    expect(
      isSameOrigin(
        post({ origin: "https://localhost:3000", host: "localhost:3000" }, TUNNEL_URL),
        BASE,
      ),
    ).toBe(false);
  });

  test("not loopback: a *.localhost name or a public Host matching its Origin is refused", () => {
    expect(
      isSameOrigin(
        post(
          { origin: "http://app.localhost:3000", host: "app.localhost:3000" },
          "http://app.localhost:3000/x",
        ),
        BASE,
      ),
    ).toBe(false);
    expect(
      isSameOrigin(
        post(
          { origin: "http://evil.example", host: "evil.example" },
          "http://evil.example/x",
        ),
        BASE,
      ),
    ).toBe(false);
  });

  test.each([["forwarded"], ["x-forwarded-for"], ["x-forwarded-host"]])(
    "a request carrying %p (it came through a proxy) never takes the exception",
    (header) => {
      expect(
        isSameOrigin(
          post(
            { origin: "http://localhost:3000", host: "localhost:3000", [header]: "x" },
            TUNNEL_URL,
          ),
          BASE,
        ),
      ).toBe(false);
    },
  );

  test("null or malformed loopback-looking headers are refused", () => {
    expect(
      isSameOrigin(post({ origin: "null", host: "localhost:3000" }, TUNNEL_URL), BASE),
    ).toBe(false);
    expect(
      isSameOrigin(
        post({ origin: "localhost:3000", host: "localhost:3000" }, TUNNEL_URL),
        BASE,
      ),
    ).toBe(false);
  });
});

describe("expectedOriginLabel and appBaseOrigin (logs and boot)", () => {
  test("the APP_BASE_URL origin, or the request host without a usable one", () => {
    expect(expectedOriginLabel("https://mail.example.com/bunmail/")).toBe(BASE);
    expect(expectedOriginLabel("")).toBe("request host");
    expect(expectedOriginLabel("mail.example.com")).toBe("request host");
    expect(appBaseOrigin("https://mail.example.com:443")).toBe(BASE);
    expect(appBaseOrigin("ftp://mail.example.com")).toBeNull();
    expect(appBaseOrigin("javascript:alert(1)")).toBeNull();
    expect(appBaseOrigin("   ")).toBeNull();
  });
});

describe("without a usable APP_BASE_URL: host comparison, as before #420", () => {
  test.each([
    [""],
    ["   "],
    ["javascript:alert(1)"],
    ["mail.example.com"],
    ["ftp://mail.example.com"],
  ])("APP_BASE_URL=%p: the request host decides", (base) => {
    const url = "http://localhost/dashboard/api-keys";
    expect(isSameOrigin(post({ origin: "http://localhost" }, url), base)).toBe(true);
    expect(isSameOrigin(post({ origin: "https://evil.example" }, url), base)).toBe(false);
  });

  test("the scheme is not compared without APP_BASE_URL (the gap #420 closes when it is set)", () => {
    expect(
      isSameOrigin(
        post({ origin: "http://mail.example.com" }, "https://mail.example.com/x"),
        "",
      ),
    ).toBe(true);
  });

  test("the Host header also counts (proxy passing the public Host)", () => {
    expect(
      isSameOrigin(
        post({ origin: "https://mail.example.com", host: "mail.example.com" }),
        "",
      ),
    ).toBe(true);
  });

  test("a port mismatch with the request host is refused", () => {
    expect(
      isSameOrigin(post({ origin: "http://localhost:8080" }, "http://localhost/x"), ""),
    ).toBe(false);
  });

  test("Referer fallback, and null, malformed or missing headers refused", () => {
    const url = "http://localhost/x";
    expect(isSameOrigin(post({ referer: "http://localhost/dashboard" }, url), "")).toBe(
      true,
    );
    expect(
      isSameOrigin(post({ origin: "null", referer: "http://localhost/" }, url), ""),
    ).toBe(false);
    expect(isSameOrigin(post({ origin: "not a url" }, url), "")).toBe(false);
    expect(isSameOrigin(post({}, url), "")).toBe(false);
  });
});
