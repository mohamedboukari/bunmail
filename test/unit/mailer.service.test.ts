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
    mail: { hostname: "test.localhost", mxConcurrency: 1 },
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
 * Per-domain MX resolver hook for multi-MX tests (#87). When set,
 * the mocked `resolveMx` delegates to this function so tests can model
 * topologies like "gmail.com → smtp.gmail.com, outlook.com →
 * smtp.outlook.com". When unset, the default flat `mxResult` is used.
 */
let mxResolver:
  | ((domain: string) => Promise<Array<{ exchange: string; priority: number }>>)
  | null = null;

/**
 * Per-host send behaviour hook. Lets a test cause specific MX hosts
 * to reject while others succeed — used to drive partial-failure
 * paths. Returning `undefined` (or not setting the hook) means
 * success across the board.
 */
let sendBehaviour: ((transportHost: string) => Error | void | undefined) | null = null;

/**
 * `mock.module` registrations live for the entire test process. Multiple
 * test files mock `dns/promises` (mailer needs `resolveMx`,
 * `dns-verification` needs `resolveTxt`); to avoid one file's mock
 * shadowing the other's missing export, both export the full surface.
 */
mock.module("dns/promises", () => ({
  resolveMx: mock(async (domain: string) => {
    if (mxResolver) return mxResolver(domain);
    if (mxResult instanceof Error) throw mxResult;
    return mxResult;
  }),
  resolveTxt: mock(async () => []),
}));

mock.module("nodemailer", () => ({
  default: {
    createTransport: mock((cfg: Record<string, unknown>) => ({
      sendMail: mock(async (opts: Record<string, unknown>) => {
        captured.push({ transportConfig: cfg, mailOptions: opts });
        if (sendBehaviour) {
          const result = sendBehaviour(cfg.host as string);
          if (result instanceof Error) throw result;
        }
        return { messageId: "<test-msg@mx.test>" };
      }),
    })),
  },
}));

const { sendMail } = await import("../../src/modules/emails/services/mailer.service.ts");

beforeEach(() => {
  captured.length = 0;
  mxResult = [{ exchange: "mx.example.org", priority: 10 }];
  mxResolver = null;
  sendBehaviour = null;
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

  test("throws when no recipient parses as a valid email", async () => {
    /** Post-#87: the recipient parser drops malformed inputs silently;
     *  if nothing survives, sendMail throws a dedicated error before
     *  any MX work happens. */
    let thrown: unknown;
    try {
      await sendMail({ from: "hello@example.com", to: "not-an-email", subject: "test" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/No valid recipients/);
  });
});

describe("sendMail — return value", () => {
  test("returns a fresh Message-ID generated up-front (not nodemailer's response value)", async () => {
    /** Post-#87 the canonical Message-ID is generated once in
     *  `sendMail` and pinned to every MX group's mailOptions so all
     *  recipients see the same id. Nodemailer's auto-generated
     *  fallback (used pre-#87) is no longer surfaced. */
    const result = await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
    });
    /** `<hex@hostname>` shape — hex chars only, locks in the hostname
     *  from the mocked config (`test.localhost`). */
    expect(result.messageId).toMatch(/^<[0-9a-f]+@test\.localhost>$/);
    /** Same id appears in the message headers the transport saw. */
    expect(captured[0]!.mailOptions.messageId).toBe(result.messageId);
  });

  test("returns no partialFailures on full success", async () => {
    const result = await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
    });
    expect(result.partialFailures).toBeUndefined();
  });
});

describe("sendMail — multi-MX (#87)", () => {
  test("groups recipients by destination MX and submits once per group", async () => {
    /** Mock the MX resolver so gmail.com and outlook.com map to
     *  distinct hosts — sendMail should open one transport per host. */
    mxResolver = (domain) => {
      if (domain === "gmail.com")
        return Promise.resolve([{ exchange: "smtp.gmail.com", priority: 10 }]);
      if (domain === "outlook.com")
        return Promise.resolve([{ exchange: "smtp.outlook.com", priority: 10 }]);
      return Promise.reject(new Error(`unexpected domain: ${domain}`));
    };

    await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com",
      cc: "bob@outlook.com",
      subject: "test",
    });

    /** Two captured sends — one per MX group. */
    expect(captured).toHaveLength(2);
    const hosts = captured.map((c) => c.transportConfig.host).sort();
    expect(hosts).toEqual(["smtp.gmail.com", "smtp.outlook.com"]);
  });

  test("each group's envelope.to contains only its own recipients", async () => {
    mxResolver = (domain) => {
      if (domain === "gmail.com")
        return Promise.resolve([{ exchange: "smtp.gmail.com", priority: 10 }]);
      if (domain === "outlook.com")
        return Promise.resolve([{ exchange: "smtp.outlook.com", priority: 10 }]);
      return Promise.reject(new Error(`unexpected: ${domain}`));
    };

    await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com",
      cc: "bob@outlook.com",
      subject: "test",
    });

    const gmailSend = captured.find((c) => c.transportConfig.host === "smtp.gmail.com")!;
    const outlookSend = captured.find(
      (c) => c.transportConfig.host === "smtp.outlook.com",
    )!;

    /** Each MX gets RCPT TO only for its own recipients — that's the
     *  whole point of #87. */
    expect((gmailSend.mailOptions.envelope as { to: string[] }).to).toEqual([
      "alice@gmail.com",
    ]);
    expect((outlookSend.mailOptions.envelope as { to: string[] }).to).toEqual([
      "bob@outlook.com",
    ]);
  });

  test("every group's message headers carry the original full recipient list", async () => {
    /** Recipients see who else was on the message — that's why CC
     *  exists. Even on Outlook's MX, the message To:/Cc: list shows
     *  alice@gmail.com so Bob can see the original distribution. */
    mxResolver = (domain) =>
      Promise.resolve([{ exchange: `smtp.${domain}`, priority: 10 }]);

    await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com",
      cc: "bob@outlook.com",
      subject: "test",
    });

    for (const c of captured) {
      expect(c.mailOptions.to).toBe("alice@gmail.com");
      expect(c.mailOptions.cc).toBe("bob@outlook.com");
    }
  });

  test("BCC recipients appear in envelope but never in headers", async () => {
    mxResolver = (domain) =>
      Promise.resolve([{ exchange: `smtp.${domain}`, priority: 10 }]);

    await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com",
      bcc: "hidden@outlook.com",
      subject: "test",
    });

    const outlookSend = captured.find(
      (c) => c.transportConfig.host === "smtp.outlook.com",
    )!;
    /** Outlook gets RCPT TO for the BCC recipient … */
    expect((outlookSend.mailOptions.envelope as { to: string[] }).to).toEqual([
      "hidden@outlook.com",
    ]);
    /** … but the rendered message must not list the BCC anywhere. */
    for (const c of captured) {
      expect(c.mailOptions.bcc).toBeUndefined();
      expect(c.mailOptions.cc).toBeUndefined();
      expect(c.mailOptions.to).toBe("alice@gmail.com");
    }
  });

  test("all groups carry the same canonical Message-ID", async () => {
    mxResolver = (domain) =>
      Promise.resolve([{ exchange: `smtp.${domain}`, priority: 10 }]);

    const result = await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com, bob@outlook.com",
      subject: "test",
    });

    for (const c of captured) {
      expect(c.mailOptions.messageId).toBe(result.messageId);
    }
  });

  test("partial failure: surfaces failing group(s) but still resolves on any success", async () => {
    /** Outlook MX rejects; Gmail accepts. sendMail must NOT throw —
     *  return success with `partialFailures` populated so the queue
     *  can fire per-recipient bounce handling. */
    mxResolver = (domain) => {
      if (domain === "gmail.com")
        return Promise.resolve([{ exchange: "smtp.gmail.com", priority: 10 }]);
      if (domain === "outlook.com")
        return Promise.resolve([{ exchange: "smtp.outlook.com", priority: 10 }]);
      return Promise.reject(new Error("unexpected"));
    };

    /** Make Outlook's sendMail reject specifically. */
    sendBehaviour = (transportHost) => {
      if (transportHost === "smtp.outlook.com") throw new Error("550 5.1.1 user unknown");
      return undefined; // success
    };

    const result = await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com",
      cc: "bob@outlook.com",
      subject: "test",
    });

    expect(result.partialFailures).toBeDefined();
    expect(result.partialFailures!).toHaveLength(1);
    expect(result.partialFailures![0]!.mxHost).toBe("smtp.outlook.com");
    expect(result.partialFailures![0]!.recipients).toEqual(["bob@outlook.com"]);
    expect(result.partialFailures![0]!.error).toMatch(/550 5\.1\.1/);
  });

  test("full failure: rethrows the first error so the queue can classify it", async () => {
    mxResolver = (domain) =>
      Promise.resolve([{ exchange: `smtp.${domain}`, priority: 10 }]);
    sendBehaviour = () => {
      throw new Error("550 5.1.1 boom");
    };

    let thrown: unknown;
    try {
      await sendMail({
        from: "hello@example.com",
        to: "alice@gmail.com, bob@outlook.com",
        subject: "test",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/550 5\.1\.1 boom/);
  });

  test("DNS resolution failure for one domain is reported as a partial failure", async () => {
    mxResolver = (domain) => {
      if (domain === "gmail.com")
        return Promise.resolve([{ exchange: "smtp.gmail.com", priority: 10 }]);
      if (domain === "nomx.example")
        return Promise.reject(new Error("No MX records found for domain: nomx.example"));
      return Promise.reject(new Error("unexpected"));
    };

    const result = await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com",
      cc: "lost@nomx.example",
      subject: "test",
    });

    expect(result.partialFailures).toBeDefined();
    const dnsFailure = result.partialFailures!.find((f) => f.mxHost.startsWith("<dns:"));
    expect(dnsFailure).toBeDefined();
    expect(dnsFailure!.recipients).toEqual(["lost@nomx.example"]);
    expect(dnsFailure!.error).toMatch(/No MX records/);
  });
});
