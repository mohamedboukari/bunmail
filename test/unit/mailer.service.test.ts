import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * Unit tests for the mailer service. Network is fully mocked —
 * `dns/promises.resolveMx` and `nodemailer.createTransport` are
 * intercepted at the module boundary.
 *
 * Coverage at this layer:
 *   - Direct-MX delivery configuration (port 25, opportunisticTLS,
 *     rejectUnauthorized: false)
 *   - List-Unsubscribe header construction (mailto, URL form, One-Click)
 *   - DKIM passthrough into nodemailer's mailOptions
 *   - Multi-MX envelope splitting + BCC isolation (#87)
 *   - Stateful retry: existingState honoured, sent groups skipped (#97)
 *   - Group status semantics: sent / retry / failed (#97)
 *   - DNS resolution failure → terminal failed group, not a thrown error (#97)
 *
 * What they don't catch: actual SMTP wire behaviour. Real send is
 * exercised in production; integration tests use the same mock pattern.
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
let mxResolver:
  | ((domain: string) => Promise<Array<{ exchange: string; priority: number }>>)
  | null = null;
let sendBehaviour: ((transportHost: string) => Error | void | undefined) | null = null;

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

/** Canonical Message-ID used across tests. Mirrors the queue's
 *  responsibility of generating + passing it on every call (#97). */
const MID = "<test-mid@local>";

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
      messageId: MID,
    });
    const cfg = captured[0]!.transportConfig;
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
      messageId: MID,
    });
    const headers = captured[0]!.mailOptions.headers as Record<string, string>;
    expect(headers["List-Unsubscribe"]).toBe("<mailto:unsubscribe@example.com>");
    expect(headers["List-Unsubscribe-Post"]).toBeUndefined();
  });

  test("uses the override mailto when provided", async () => {
    await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
      messageId: MID,
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
      messageId: MID,
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
      messageId: MID,
      unsubscribe: { mailto: "no-reply@example.com", url: "https://example.com/unsub" },
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
      messageId: MID,
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

  test("omits DKIM when not provided", async () => {
    await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
      messageId: MID,
    });
    expect(captured[0]!.mailOptions.dkim).toBeUndefined();
  });
});

describe("sendMail — fundamental error paths", () => {
  test("throws when no recipient parses as a valid email", async () => {
    let thrown: unknown;
    try {
      await sendMail({
        from: "hello@example.com",
        to: "not-an-email",
        subject: "test",
        messageId: MID,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/No valid recipients/);
  });

  test("DNS resolution failure becomes a terminal `failed` group instead of throwing", async () => {
    /** Post-#97 a domain with no MX records doesn't crash the send —
     *  it shows up as a synthetic `<dns:...>` entry in `failed` state
     *  so the queue can render it in the row's delivery_state for the
     *  operator. Retrying that group is pointless (no MX exists), so
     *  it stays terminal. */
    mxResult = [];
    const result = await sendMail({
      from: "hello@example.com",
      to: "user@nomx.test",
      subject: "test",
      messageId: MID,
    });
    const entry = result.deliveryState["<dns:nomx.test>"];
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("failed");
    expect(entry!.recipients).toEqual(["user@nomx.test"]);
    expect(entry!.lastError).toMatch(/No MX records/);
  });
});

describe("sendMail — return value", () => {
  test("messageId in the result matches the canonical id the caller passed", async () => {
    const result = await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
      messageId: MID,
    });
    expect(result.messageId).toBe(MID);
    expect(captured[0]!.mailOptions.messageId).toBe(MID);
  });

  test("first-send state for a single group reaches `sent`", async () => {
    const result = await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
      messageId: MID,
    });
    const groups = Object.values(result.deliveryState);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.status).toBe("sent");
    expect(groups[0]!.recipients).toEqual(["user@example.org"]);
    expect(groups[0]!.attempts).toBe(1);
    expect(typeof groups[0]!.deliveredAt).toBe("string");
  });
});

describe("sendMail — multi-MX (#87)", () => {
  test("groups recipients by destination MX and submits once per group", async () => {
    mxResolver = (domain) =>
      Promise.resolve([{ exchange: `smtp.${domain}`, priority: 10 }]);

    await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com",
      cc: "bob@outlook.com",
      subject: "test",
      messageId: MID,
    });

    expect(captured).toHaveLength(2);
    const hosts = captured.map((c) => c.transportConfig.host).sort();
    expect(hosts).toEqual(["smtp.gmail.com", "smtp.outlook.com"]);
  });

  test("each group's envelope.to contains only its own recipients", async () => {
    mxResolver = (domain) =>
      Promise.resolve([{ exchange: `smtp.${domain}`, priority: 10 }]);

    await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com",
      cc: "bob@outlook.com",
      subject: "test",
      messageId: MID,
    });

    const gmailSend = captured.find((c) => c.transportConfig.host === "smtp.gmail.com")!;
    const outlookSend = captured.find(
      (c) => c.transportConfig.host === "smtp.outlook.com",
    )!;
    expect((gmailSend.mailOptions.envelope as { to: string[] }).to).toEqual([
      "alice@gmail.com",
    ]);
    expect((outlookSend.mailOptions.envelope as { to: string[] }).to).toEqual([
      "bob@outlook.com",
    ]);
  });

  test("every group's message headers carry the original full recipient list", async () => {
    mxResolver = (domain) =>
      Promise.resolve([{ exchange: `smtp.${domain}`, priority: 10 }]);

    await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com",
      cc: "bob@outlook.com",
      subject: "test",
      messageId: MID,
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
      messageId: MID,
    });

    const outlookSend = captured.find(
      (c) => c.transportConfig.host === "smtp.outlook.com",
    )!;
    expect((outlookSend.mailOptions.envelope as { to: string[] }).to).toEqual([
      "hidden@outlook.com",
    ]);
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
      messageId: MID,
    });

    for (const c of captured) {
      expect(c.mailOptions.messageId).toBe(MID);
    }
    expect(result.messageId).toBe(MID);
  });
});

describe("sendMail — per-group outcomes (#97)", () => {
  test("hard 5xx marks the group `failed` (terminal), not `retry`", async () => {
    mxResolver = (domain) =>
      Promise.resolve([{ exchange: `smtp.${domain}`, priority: 10 }]);
    sendBehaviour = () => new Error("550 5.1.1 user unknown");

    const result = await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com",
      subject: "test",
      messageId: MID,
    });

    const group = result.deliveryState["smtp.gmail.com"];
    expect(group).toBeDefined();
    expect(group!.status).toBe("failed");
    expect(group!.attempts).toBe(1);
    expect(group!.lastError).toMatch(/550 5\.1\.1/);
  });

  test("soft 4xx leaves the group in `retry` for the queue to schedule", async () => {
    mxResolver = (domain) =>
      Promise.resolve([{ exchange: `smtp.${domain}`, priority: 10 }]);
    sendBehaviour = () => new Error("421 4.4.5 too many connections");

    const result = await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com",
      subject: "test",
      messageId: MID,
    });

    const group = result.deliveryState["smtp.gmail.com"];
    expect(group!.status).toBe("retry");
    expect(group!.attempts).toBe(1);
    expect(group!.lastError).toMatch(/421/);
  });

  test("mixed outcome: one group sent, the other retry — surfaces both", async () => {
    mxResolver = (domain) =>
      Promise.resolve([{ exchange: `smtp.${domain}`, priority: 10 }]);
    sendBehaviour = (host) =>
      host === "smtp.outlook.com" ? new Error("421 too many") : undefined;

    const result = await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com",
      cc: "bob@outlook.com",
      subject: "test",
      messageId: MID,
    });

    expect(result.deliveryState["smtp.gmail.com"]!.status).toBe("sent");
    expect(result.deliveryState["smtp.outlook.com"]!.status).toBe("retry");
  });
});

describe("sendMail — stateful retry (#97)", () => {
  test("when existingState contains a `sent` group, the mailer skips it", async () => {
    mxResolver = (domain) =>
      Promise.resolve([{ exchange: `smtp.${domain}`, priority: 10 }]);
    /** First attempt: gmail succeeds, outlook 4xx. */
    sendBehaviour = (host) =>
      host === "smtp.outlook.com" ? new Error("421 too many") : undefined;

    const first = await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com",
      cc: "bob@outlook.com",
      subject: "test",
      messageId: MID,
    });
    expect(captured).toHaveLength(2);
    captured.length = 0;

    /** Retry pass: outlook now accepts. We pass the prior state so
     *  the mailer should skip gmail entirely (no duplicate). */
    sendBehaviour = null;
    const second = await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com",
      cc: "bob@outlook.com",
      subject: "test",
      messageId: MID,
      existingState: first.deliveryState,
    });

    /** Only ONE captured send this attempt — the outlook one. */
    expect(captured).toHaveLength(1);
    expect(captured[0]!.transportConfig.host).toBe("smtp.outlook.com");

    /** Final state: both groups sent, gmail's attempt count unchanged
     *  from attempt 1 because we never re-tried it. */
    expect(second.deliveryState["smtp.gmail.com"]!.status).toBe("sent");
    expect(second.deliveryState["smtp.gmail.com"]!.attempts).toBe(1);
    expect(second.deliveryState["smtp.outlook.com"]!.status).toBe("sent");
    expect(second.deliveryState["smtp.outlook.com"]!.attempts).toBe(2);
  });

  test("a retry pass with all groups already sent is a no-op", async () => {
    mxResolver = (domain) =>
      Promise.resolve([{ exchange: `smtp.${domain}`, priority: 10 }]);
    const first = await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com",
      subject: "test",
      messageId: MID,
    });
    captured.length = 0;

    /** Pass back the all-sent state; mailer should send nothing. */
    const second = await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com",
      subject: "test",
      messageId: MID,
      existingState: first.deliveryState,
    });

    expect(captured).toHaveLength(0);
    expect(second.deliveryState).toEqual(first.deliveryState);
  });

  test("synthetic `<dns:...>` entries from prior state are not retried", async () => {
    /** First attempt: DNS fails for the only recipient. */
    mxResult = [];
    const first = await sendMail({
      from: "hello@example.com",
      to: "user@nomx.test",
      subject: "test",
      messageId: MID,
    });
    expect(first.deliveryState["<dns:nomx.test>"]!.status).toBe("failed");
    captured.length = 0;

    /** Even if DNS magically starts working, the failed entry stays
     *  failed — we don't re-resolve from a DNS-failed key. */
    mxResult = [{ exchange: "now-resolves.test", priority: 10 }];
    const second = await sendMail({
      from: "hello@example.com",
      to: "user@nomx.test",
      subject: "test",
      messageId: MID,
      existingState: first.deliveryState,
    });
    expect(captured).toHaveLength(0);
    expect(second.deliveryState["<dns:nomx.test>"]!.status).toBe("failed");
  });
});
