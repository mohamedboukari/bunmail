import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * Unit tests for the mailer service. Exercises the transport
 * configuration, header construction, DKIM passthrough, and MX
 * resolution. Network is fully mocked — `dns/promises.resolveMx` and
 * `nodemailer.createTransport` are intercepted at the module boundary.
 *
 * What these tests catch:
 *   - Direct-MX delivery configuration (port 25, `opportunisticTLS`,
 *     `rejectUnauthorized: false`)
 *   - List-Unsubscribe header construction (default mailto, URL form,
 *     One-Click POST gating)
 *   - DKIM options passthrough into nodemailer's mail options
 *   - MX-resolution error path
 *
 * What they don't catch: actual SMTP wire behaviour. Real send is
 * exercised in production; integration tests use the same mock pattern
 * since we don't run a fake SMTP server.
 */

/**
 * Self-contained config mock so this test isn't affected by mock-leak
 * from any other test file in the same process (Bun's `mock.module`
 * registrations are global to the test run).
 */
mock.module("../../src/config.ts", () => ({
  config: {
    mail: { hostname: "test.localhost" },
    env: "test" as const,
    database: { url: "" },
    server: { port: 3000, host: "0.0.0.0" },
    dashboard: { password: "", sessionSecret: "test" },
    logLevel: "error" as const,
  },
}));

interface CapturedSend {
  transportConfig: Record<string, unknown>;
  mailOptions: Record<string, unknown>;
}

const captured: CapturedSend[] = [];
let mxResult: Array<{ exchange: string; priority: number }> | Error = [];

/**
 * `mock.module` registrations live for the entire test process. Multiple
 * test files mock `dns/promises` (mailer needs `resolveMx`,
 * `dns-verification` needs `resolveTxt`); to avoid one file's mock
 * shadowing the other's missing export, both export the full surface.
 */
mock.module("dns/promises", () => ({
  resolveMx: mock(async () => {
    if (mxResult instanceof Error) throw mxResult;
    return mxResult;
  }),
  resolveTxt: mock(async () => []),
}));

mock.module("nodemailer", () => ({
  default: {
    createTransport: mock((config: Record<string, unknown>) => ({
      sendMail: mock(async (opts: Record<string, unknown>) => {
        captured.push({ transportConfig: config, mailOptions: opts });
        return { messageId: "<test-msg@mx.test>" };
      }),
    })),
  },
}));

const { sendMail } = await import("../../src/modules/emails/services/mailer.service.ts");

beforeEach(() => {
  captured.length = 0;
  mxResult = [{ exchange: "mx.example.org", priority: 10 }];
});

describe("sendMail — transport configuration", () => {
  test("connects to the lowest-priority MX on port 25 with opportunistic TLS + relaxed cert validation", async () => {
    mxResult = [
      { exchange: "mx2.example.org", priority: 20 },
      { exchange: "mx1.example.org", priority: 10 },
      { exchange: "mx3.example.org", priority: 30 },
    ];
    await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
      html: "<p>hi</p>",
    });
    const cfg = captured[0]!.transportConfig;
    /** Lowest priority wins — `mx1.example.org` (priority 10). */
    expect(cfg.host).toBe("mx1.example.org");
    expect(cfg.port).toBe(25);
    expect(cfg.secure).toBe(false);
    expect(cfg.opportunisticTLS).toBe(true);
    expect((cfg.tls as { rejectUnauthorized: boolean }).rejectUnauthorized).toBe(false);
  });
});

describe("sendMail — List-Unsubscribe header", () => {
  test("emits default mailto form when no override is configured", async () => {
    await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
    });
    const headers = captured[0]!.mailOptions.headers as Record<string, string>;
    expect(headers["List-Unsubscribe"]).toBe("<mailto:unsubscribe@example.com>");
    /** No URL → no List-Unsubscribe-Post header. */
    expect(headers["List-Unsubscribe-Post"]).toBeUndefined();
  });

  test("uses the override mailto when provided", async () => {
    await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
      unsubscribe: { mailto: "no-reply@example.com" },
    });
    const headers = captured[0]!.mailOptions.headers as Record<string, string>;
    expect(headers["List-Unsubscribe"]).toBe("<mailto:no-reply@example.com>");
  });

  test("includes URL form + One-Click POST when a URL is configured", async () => {
    await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
      unsubscribe: { url: "https://example.com/unsub?u=abc" },
    });
    const headers = captured[0]!.mailOptions.headers as Record<string, string>;
    expect(headers["List-Unsubscribe"]).toBe(
      "<mailto:unsubscribe@example.com>, <https://example.com/unsub?u=abc>",
    );
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  test("respects both mailto and URL overrides together", async () => {
    await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
      unsubscribe: {
        mailto: "no-reply@example.com",
        url: "https://example.com/unsub",
      },
    });
    const headers = captured[0]!.mailOptions.headers as Record<string, string>;
    expect(headers["List-Unsubscribe"]).toBe(
      "<mailto:no-reply@example.com>, <https://example.com/unsub>",
    );
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});

describe("sendMail — DKIM passthrough", () => {
  test("passes DKIM options to nodemailer's mailOptions when provided", async () => {
    await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
      dkim: {
        domainName: "example.com",
        keySelector: "bunmail",
        privateKey: "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----",
      },
    });
    const dkim = captured[0]!.mailOptions.dkim as Record<string, string>;
    expect(dkim.domainName).toBe("example.com");
    expect(dkim.keySelector).toBe("bunmail");
    expect(dkim.privateKey).toContain("BEGIN PRIVATE KEY");
  });

  test("omits DKIM when not provided (unsigned mail still attempted)", async () => {
    await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
    });
    expect(captured[0]!.mailOptions.dkim).toBeUndefined();
  });
});

describe("sendMail — error paths", () => {
  test("throws when the recipient domain has no MX records", async () => {
    mxResult = [];
    let thrown: unknown;
    try {
      await sendMail({
        from: "hello@example.com",
        to: "user@nomx.test",
        subject: "test",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/No MX records found/);
  });

  test("throws when the recipient address has no @ separator", async () => {
    let thrown: unknown;
    try {
      await sendMail({ from: "hello@example.com", to: "not-an-email", subject: "test" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/Invalid email address/);
  });
});

describe("sendMail — return value", () => {
  test("returns the messageId from nodemailer", async () => {
    const result = await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
    });
    expect(result.messageId).toBe("<test-msg@mx.test>");
  });
});
