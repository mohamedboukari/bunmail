/**
 * Outbound MTA-STS (#250), end to end: the real mailer against real
 * receiving servers (`test/smtp-fixture.ts`, run under Node) and a local
 * HTTPS policy server. No real DNS and no real HTTPS: the MX route seam
 * points every MX host at 127.0.0.1 (allowed here with
 * `MAIL_ALLOW_PRIVATE_MX`) on its fixture's port, and the MTA-STS seam
 * answers the `_mta-sts` TXT lookup, points `mta-sts.example.org` at the
 * local policy server and trusts the test-only CA
 * (`test/fixtures/tls/test-ca.cert.pem`), never the system store.
 *
 * The certificates under `test/fixtures/tls/` for `mx1.example.test`,
 * `mx2.example.test` and `mta-sts.example.org` are signed by that CA; the
 * `hook.example.test` one is self-signed.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, spyOn } from "bun:test";
import { createServer } from "node:net";
import { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import { setMxRouteDeps } from "../../src/modules/emails/services/mx-route.ts";
import { setMtaStsDeps } from "../../src/modules/emails/services/mta-sts.ts";
import { config } from "../../src/config.ts";
import {
  startFixtureServer,
  type FixtureMode,
  type FixtureServer,
} from "../smtp-fixture.ts";
import { installHermeticMtaSts } from "./_dns-stub.ts";

const TLS_DIR = new URL("../fixtures/tls/", import.meta.url);
const CA = await Bun.file(new URL("test-ca.cert.pem", TLS_DIR)).text();

const running: FixtureServer[] = [];
const savedAllowPrivate = config.mail.allowPrivateMx;

/** A local port nothing listens on: bound, then released. */
let closedPort = 0;

/** The policy the local HTTPS server serves for `mta-sts.example.org`. */
let policyBody = "";
/** Policy fetches the server answered. */
let policyFetches = 0;
let policyServer: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  Object.assign(config.mail, { allowPrivateMx: true });
  const probe = createServer();
  closedPort = await new Promise<number>((resolve) => {
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  policyServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: {
      key: Bun.file(new URL("mta-sts.example.org.key.pem", TLS_DIR)),
      cert: Bun.file(new URL("mta-sts.example.org.cert.pem", TLS_DIR)),
    },
    fetch(request) {
      if (new URL(request.url).pathname !== "/.well-known/mta-sts.txt") {
        return new Response("not found", { status: 404 });
      }
      policyFetches += 1;
      return new Response(policyBody, { headers: { "content-type": "text/plain" } });
    },
  });
});

afterEach(() => {
  setMxRouteDeps(null);
  installHermeticMtaSts();
});

afterAll(() => {
  Object.assign(config.mail, { allowPrivateMx: savedAllowPrivate });
  for (const server of running) server.stop();
  void policyServer?.stop(true);
});

async function startServer(mode: FixtureMode, certName: string): Promise<FixtureServer> {
  const server = await startFixtureServer(mode, certName);
  running.push(server);
  return server;
}

/** A DNS error with its `code`, as `dns/promises` rejects. */
function dnsError(code: string): Error {
  return Object.assign(new Error(`query ${code}`), { code });
}

/**
 * Routes `example.org` to `mx1.example.test` (preference 10) then
 * `mx2.example.test` (20), each at 127.0.0.1 on the port given (a closed
 * port when none).
 */
function routeExampleOrg(ports: { mx1?: number; mx2?: number }): void {
  const portOf: Record<string, number | undefined> = {
    "mx1.example.test": ports.mx1,
    "mx2.example.test": ports.mx2,
  };
  setMxRouteDeps({
    resolveMx: async (domain) => {
      if (domain !== "example.org") throw dnsError("ENOTFOUND");
      return [
        { exchange: "mx2.example.test", priority: 20 },
        { exchange: "mx1.example.test", priority: 10 },
      ];
    },
    resolve4: () => Promise.reject(dnsError("ENOTFOUND")),
    resolve6: () => Promise.reject(dnsError("ENOTFOUND")),
    lookup: async () => [{ address: "127.0.0.1" }],
    smtpPort: (mxHost) => portOf[mxHost] ?? closedPort,
  });
}

/**
 * Publishes an MTA-STS policy for `example.org` (TXT id `id`), served by
 * the local HTTPS server, or none at all with `null`.
 */
function publishPolicy(
  policy: { mode: "enforce" | "testing" | "none"; mx: string[] } | null,
  id = "20261019",
): void {
  policyFetches = 0;
  if (policy === null) {
    setMtaStsDeps({
      resolveTxt: () => Promise.reject(dnsError("ENOTFOUND")),
      lookup: () => Promise.reject(dnsError("ENOTFOUND")),
      fetch: () => Promise.reject(new Error("no policy host")),
    });
    return;
  }
  policyBody = [
    "version: STSv1",
    `mode: ${policy.mode}`,
    ...policy.mx.map((mx) => `mx: ${mx}`),
    "max_age: 86400",
    "",
  ].join("\r\n");
  setMtaStsDeps({
    resolveTxt: async (name) => {
      if (name !== "_mta-sts.example.org") throw dnsError("ENOTFOUND");
      return [[`v=STSv1; id=${id};`]];
    },
    lookup: async () => [{ address: "127.0.0.1" }],
    fetch: (url, init) => fetch(url, init),
    httpsPort: policyServer?.port ?? 0,
    ca: CA,
  });
}

/** One send of a fixed message, straight through the mailer. */
function send(to: string) {
  return sendMail({
    from: "hello@example.com",
    to,
    subject: "mta-sts",
    text: "hello",
    messageId: `<${crypto.randomUUID()}@bunmail.example.test>`,
  });
}

describe("MTA-STS enforce against real receiving servers", () => {
  test("a matching MX with a valid certificate delivers, recorded as enforced", async () => {
    const mx1 = await startServer("starttls", "mx1.example.test");
    routeExampleOrg({ mx1: mx1.port });
    publishPolicy({ mode: "enforce", mx: ["*.example.test"] });
    const result = await send("user@example.org");
    expect(result.deliveryState["example.org"]).toMatchObject({
      status: "sent",
      mxHost: "mx1.example.test",
      tls: "starttls",
      mtaSts: "enforce",
    });
    expect(mx1.messages()).toBe(1);
    expect(policyFetches).toBe(1);

    /** The next attempt uses the cached policy: same TXT id, no fetch. */
    await send("user2@example.org");
    expect(policyFetches).toBe(1);
    expect(mx1.messages()).toBe(2);
  });

  test("an MX outside the policy is never tried", async () => {
    const mx1 = await startServer("starttls", "mx1.example.test");
    const mx2 = await startServer("starttls", "mx2.example.test");
    routeExampleOrg({ mx1: mx1.port, mx2: mx2.port });
    publishPolicy({ mode: "enforce", mx: ["mx2.example.test"] });
    const result = await send("user@example.org");
    expect(result.deliveryState["example.org"]).toMatchObject({
      status: "sent",
      mxHost: "mx2.example.test",
      mtaSts: "enforce",
    });
    expect(mx1.connections()).toBe(0);
    expect(mx2.messages()).toBe(1);
  });

  test("a certificate for the wrong name fails over to the next matching host", async () => {
    /** mx1 presents mx2's certificate. */
    const mx1 = await startServer("starttls", "mx2.example.test");
    const mx2 = await startServer("starttls", "mx2.example.test");
    routeExampleOrg({ mx1: mx1.port, mx2: mx2.port });
    publishPolicy({ mode: "enforce", mx: ["*.example.test"] });
    const result = await send("user@example.org");
    expect(result.deliveryState["example.org"]).toMatchObject({
      status: "sent",
      mxHost: "mx2.example.test",
      tls: "starttls",
      mtaSts: "enforce",
    });
    expect(mx1.connections()).toBe(1);
    expect(mx1.messages()).toBe(0);
    expect(mx2.messages()).toBe(1);
  });

  test("a certificate for the wrong name on the only matching host: retried, nothing sent", async () => {
    const mx1 = await startServer("starttls", "mx2.example.test");
    routeExampleOrg({ mx1: mx1.port });
    publishPolicy({ mode: "enforce", mx: ["mx1.example.test"] });
    const result = await send("user@example.org");
    const entry = result.deliveryState["example.org"];
    expect(entry).toMatchObject({ status: "retry", tls: null, mtaSts: "enforce" });
    expect(entry?.failureKind).toBeUndefined();
    expect(entry?.lastError).toContain("MTA-STS: no verified TLS with mx1.example.test");
    expect(mx1.messages()).toBe(0);
  });

  test("a self-signed certificate: retried, nothing sent", async () => {
    const mx1 = await startServer("starttls", "hook.example.test");
    routeExampleOrg({ mx1: mx1.port });
    publishPolicy({ mode: "enforce", mx: ["mx1.example.test"] });
    const result = await send("user@example.org");
    expect(result.deliveryState["example.org"]).toMatchObject({
      status: "retry",
      mtaSts: "enforce",
    });
    expect(mx1.messages()).toBe(0);
  });

  test("no MX host matches the policy: retried without connecting", async () => {
    const mx1 = await startServer("starttls", "mx1.example.test");
    const mx2 = await startServer("starttls", "mx2.example.test");
    routeExampleOrg({ mx1: mx1.port, mx2: mx2.port });
    publishPolicy({ mode: "enforce", mx: ["mx.elsewhere.example"] });
    const result = await send("user@example.org");
    const entry = result.deliveryState["example.org"];
    expect(entry).toMatchObject({ status: "retry", tls: null, mtaSts: "enforce" });
    expect(entry?.failureKind).toBeUndefined();
    expect(entry?.lastError).toContain("no MX host matches the MTA-STS policy");
    expect(mx1.connections()).toBe(0);
    expect(mx2.connections()).toBe(0);
  });

  test("a server that offers no STARTTLS: retried, never bounced", async () => {
    const mx1 = await startServer("plaintext", "mx1.example.test");
    routeExampleOrg({ mx1: mx1.port });
    publishPolicy({ mode: "enforce", mx: ["mx1.example.test"] });
    const result = await send("user@example.org");
    const entry = result.deliveryState["example.org"];
    expect(entry).toMatchObject({ status: "retry", mtaSts: "enforce" });
    expect(entry?.failureKind).toBeUndefined();
    expect(entry?.lastError).toContain("MTA-STS: no verified TLS with mx1.example.test");
    expect(mx1.connections()).toBe(1);
    expect(mx1.messages()).toBe(0);
  });
});

describe("MTA-STS testing and no policy", () => {
  test("testing mode with no matching MX delivers as today and warns once", async () => {
    const warn = spyOn(console, "warn");
    try {
      /** A self-signed certificate: accepted, as without a policy. */
      const mx1 = await startServer("starttls", "hook.example.test");
      routeExampleOrg({ mx1: mx1.port });
      publishPolicy({ mode: "testing", mx: ["mx.elsewhere.example"] });
      const first = await send("user@example.org");
      expect(first.deliveryState["example.org"]).toMatchObject({
        status: "sent",
        mxHost: "mx1.example.test",
        tls: "starttls",
        mtaSts: "testing",
      });
      await send("user2@example.org");
      expect(mx1.messages()).toBe(2);
      const warnings = warn.mock.calls.filter((call) =>
        String(call[0]).includes("MTA-STS testing policy would fail in enforce mode"),
      );
      expect(warnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("no policy: delivered exactly as before, unverified STARTTLS", async () => {
    const mx1 = await startServer("starttls", "hook.example.test");
    routeExampleOrg({ mx1: mx1.port });
    publishPolicy(null);
    const result = await send("user@example.org");
    expect(result.deliveryState["example.org"]).toMatchObject({
      status: "sent",
      mxHost: "mx1.example.test",
      tls: "starttls",
      mtaSts: null,
    });
    expect(mx1.messages()).toBe(1);
  });

  test("mode none: delivered as without a policy", async () => {
    const mx1 = await startServer("plaintext", "hook.example.test");
    routeExampleOrg({ mx1: mx1.port });
    publishPolicy({ mode: "none", mx: [] });
    const result = await send("user@example.org");
    expect(result.deliveryState["example.org"]).toMatchObject({
      status: "sent",
      tls: "plaintext",
      mtaSts: null,
    });
    expect(policyFetches).toBe(1);
  });
});
