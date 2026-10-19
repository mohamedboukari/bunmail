import { describe, test, expect, mock, beforeEach } from "bun:test";

/** Narrow a captured nodemailer option (typed `unknown`) to a plain record for assertions. */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("expected an object");
  return Object.fromEntries(Object.entries(value));
}

/**
 * Unit tests for the mailer service. Network is fully mocked:
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

void mock.module("../../src/config.ts", () => ({
  config: {
    mail: { hostname: "test.localhost", mxConcurrency: 1, publicIps: [] },
    env: "test" as const,
    database: { url: "" },
    server: { port: 3000, host: "0.0.0.0" },
    dashboard: { ownerEmail: null },
    logLevel: "error" as const,
    /** Master for the return-path key (#236). */
    dkimEncryptionKey: Buffer.alloc(32, 7),
  },
}));

interface CapturedSend {
  transportConfig: Record<string, unknown>;
  mailOptions: Record<string, unknown>;
}

const captured: CapturedSend[] = [];
let mxResult: Array<{ exchange: string; priority: number }> | Error = [];
let mxResolver:
  ((domain: string) => Promise<Array<{ exchange: string; priority: number }>>) | null =
  null;
let sendBehaviour:
  ((mxHost: string, opts: Record<string, unknown>) => Error | void | undefined) | null =
  null;

/** Public test address (TEST-NET-3) every MX host resolves to by default. */
const MX_IP = "203.0.113.10";
let lookupResult: Array<{ address: string; family: number }> = [];

/** The MX name a transport was built for: the host is now the pinned IP,
 *  and the name travels as the TLS servername (SNI). */
function mxOf(cfg: Record<string, unknown>): string {
  const name = asRecord(cfg.tls).servername;
  return typeof name === "string" ? name : "";
}

void mock.module("dns/promises", () => ({
  resolveMx: mock(async (domain: string) => {
    if (mxResolver) return mxResolver(domain);
    if (mxResult instanceof Error) throw mxResult;
    return mxResult;
  }),
  resolveTxt: mock(async () => []),
  resolve4: mock(async () => []),
  resolve6: mock(async () => []),
  reverse: mock(async () => []),
  lookup: mock(async () => lookupResult),
}));

/** How many transports were closed (pooled ones are closed by the mailer, #236). */
let closedTransports = 0;

const createTransportMock = mock((cfg: Record<string, unknown>) => ({
  sendMail: mock(async (opts: Record<string, unknown>) => {
    captured.push({ transportConfig: cfg, mailOptions: opts });
    if (sendBehaviour) {
      const result = sendBehaviour(mxOf(cfg), opts);
      if (result instanceof Error) throw result;
    }
    return { messageId: "<test-msg@mx.test>" };
  }),
  close: mock(() => {
    closedTransports += 1;
  }),
}));

/** nodemailer 10 ships `createTransport` as both a named export and a
 *  member of the default export; mirror both so either import style in
 *  the code under test resolves to the mock. */
void mock.module("nodemailer", () => ({
  createTransport: createTransportMock,
  default: { createTransport: createTransportMock },
}));

const { sendMail } = await import("../../src/modules/emails/services/mailer.service.ts");
const { parseReturnPath, recipientOrder, returnPathMacMatches } =
  await import("../../src/modules/bounces/services/return-path.ts");

/** Canonical Message-ID used across tests. Mirrors the queue's
 *  responsibility of generating + passing it on every call (#97). */
const MID = "<test-mid@local>";

beforeEach(() => {
  captured.length = 0;
  mxResult = [{ exchange: "mx.example.org", priority: 10 }];
  mxResolver = null;
  sendBehaviour = null;
  lookupResult = [{ address: MX_IP, family: 4 }];
  createTransportMock.mockClear();
  closedTransports = 0;
});

describe("sendMail: transport configuration", () => {
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
    /** Pinned to the checked address; the MX name is the TLS servername. */
    expect(cfg.host).toBe(MX_IP);
    expect(mxOf(cfg)).toBe("mx1.example.org");
    expect(cfg.port).toBe(25);
    expect(cfg.secure).toBe(false);
    expect(cfg.opportunisticTLS).toBe(true);
    expect(asRecord(cfg.tls).rejectUnauthorized).toBe(false);
  });
});

describe("sendMail: List-Unsubscribe header", () => {
  test("emits default mailto form when no override is configured", async () => {
    await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
      messageId: MID,
    });
    const headers = asRecord(captured[0]!.mailOptions.headers);
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
    const headers = asRecord(captured[0]!.mailOptions.headers);
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
    const headers = asRecord(captured[0]!.mailOptions.headers);
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
    const headers = asRecord(captured[0]!.mailOptions.headers);
    expect(headers["List-Unsubscribe"]).toBe(
      "<mailto:no-reply@example.com>, <https://example.com/unsub>",
    );
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});

describe("sendMail: custom headers (#177)", () => {
  test("passes stored custom headers to nodemailer next to List-Unsubscribe", async () => {
    await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
      messageId: MID,
      headers: { "X-Correlation-Id": "abc", "In-Reply-To": "<p@example.com>" },
    });
    expect(asRecord(captured[0]!.mailOptions.headers)).toEqual({
      "X-Correlation-Id": "abc",
      "In-Reply-To": "<p@example.com>",
      "List-Unsubscribe": "<mailto:unsubscribe@example.com>",
    });
  });

  test("drops stored headers that break the rules, so they never override BunMail's", async () => {
    /** A row written without createEmail (manual insert, future bug). */
    await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
      messageId: MID,
      headers: {
        "X-Ok": "1",
        "X-Inj": "v\r\nBcc: victim@example.com",
        "list-unsubscribe": "<mailto:evil@example.com>",
        "message-id": "<evil@example.com>",
        "X-BunMail-Internal": "x",
      },
    });
    expect(asRecord(captured[0]!.mailOptions.headers)).toEqual({
      "X-Ok": "1",
      "List-Unsubscribe": "<mailto:unsubscribe@example.com>",
    });
    expect(captured[0]!.mailOptions.messageId).toBe(MID);
  });

  test("every MX group gets the same custom headers", async () => {
    mxResolver = async (domain) => [{ exchange: `mx.${domain}`, priority: 10 }];
    await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      cc: "other@example.net",
      subject: "test",
      messageId: MID,
      headers: { "X-Correlation-Id": "abc" },
    });
    expect(captured).toHaveLength(2);
    for (const send of captured) {
      expect(asRecord(send.mailOptions.headers)["X-Correlation-Id"]).toBe("abc");
    }
  });
});

describe("sendMail: DKIM passthrough", () => {
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
    const dkim = asRecord(captured[0]!.mailOptions.dkim);
    expect(dkim.domainName).toBe("example.com");
    expect(dkim.keySelector).toBe("bunmail");
    expect(dkim.privateKey).toContain("BEGIN PRIVATE KEY");
    /** One-click unsubscribe (RFC 8058) needs the Post header signed. */
    expect(String(dkim.headerFieldNames).split(":")).toContain("List-Unsubscribe-Post");
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

describe("sendMail: fundamental error paths", () => {
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
    expect(thrown).toHaveProperty(
      "message",
      expect.stringMatching(/No valid recipients/),
    );
  });

  test("DNS resolution failure becomes a terminal `failed` group instead of throwing", async () => {
    /** Post-#97 a domain with no MX records doesn't crash the send:
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

describe("sendMail: return value", () => {
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

describe("sendMail: multi-MX (#87)", () => {
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
    const hosts = captured
      .map((c) => mxOf(c.transportConfig))
      .toSorted((a, b) => a.localeCompare(b));
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

    const gmailSend = captured.find((c) => mxOf(c.transportConfig) === "smtp.gmail.com")!;
    const outlookSend = captured.find(
      (c) => mxOf(c.transportConfig) === "smtp.outlook.com",
    )!;
    expect(asRecord(gmailSend.mailOptions.envelope).to).toEqual(["alice@gmail.com"]);
    expect(asRecord(outlookSend.mailOptions.envelope).to).toEqual(["bob@outlook.com"]);
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
      (c) => mxOf(c.transportConfig) === "smtp.outlook.com",
    )!;
    expect(asRecord(outlookSend.mailOptions.envelope).to).toEqual(["hidden@outlook.com"]);
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

describe("sendMail: Reply-To (#169)", () => {
  test("sets the Reply-To header on every MX group's message", async () => {
    mxResolver = (domain) =>
      Promise.resolve([{ exchange: `smtp.${domain}`, priority: 10 }]);

    await sendMail({
      from: "no-reply@example.com",
      to: "alice@gmail.com, bob@outlook.com",
      replyTo: "support@example.com, sales@example.com",
      subject: "test",
      messageId: MID,
    });

    expect(captured).toHaveLength(2);
    for (const c of captured) {
      expect(c.mailOptions.replyTo).toBe("support@example.com, sales@example.com");
    }
  });

  test("is a header only: the envelope sender and recipients are unchanged", async () => {
    await sendMail({
      from: "no-reply@example.com",
      to: "alice@gmail.com",
      replyTo: "support@example.com",
      subject: "test",
      messageId: MID,
    });

    const envelope = asRecord(captured[0]!.mailOptions.envelope);
    expect(envelope.from).toBe("no-reply@example.com");
    expect(envelope.to).toEqual(["alice@gmail.com"]);
    expect(captured[0]!.mailOptions.from).toBe("no-reply@example.com");
  });

  test("omits Reply-To when not provided", async () => {
    await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com",
      subject: "test",
      messageId: MID,
    });

    expect(captured[0]!.mailOptions.replyTo).toBeUndefined();
  });
});

describe("sendMail: per-group outcomes (#97)", () => {
  test("a sender block (5.7.1 blocklist) fails the group and flags it blocked (#246)", async () => {
    mxResolver = (domain) =>
      Promise.resolve([{ exchange: `smtp.${domain}`, priority: 10 }]);
    sendBehaviour = () =>
      new Error("550 5.7.1 Service unavailable; Client host blocked using Spamhaus");

    const result = await sendMail({
      from: "hello@example.com",
      to: "alice@outlook.com",
      subject: "test",
      messageId: MID,
    });

    const group = result.deliveryState["smtp.outlook.com"];
    expect(group?.status).toBe("failed");
    expect(group?.blocked).toBe(true);
  });

  test("a network error to an MX on a 5.x.x.x address is retried, not a bounce", async () => {
    mxResolver = (domain) =>
      Promise.resolve([{ exchange: `smtp.${domain}`, priority: 10 }]);
    sendBehaviour = () => new Error("connect ECONNREFUSED 5.6.7.8:25");

    const result = await sendMail({
      from: "hello@example.com",
      to: "alice@outlook.com",
      subject: "test",
      messageId: MID,
    });

    expect(result.deliveryState["smtp.outlook.com"]?.status).toBe("retry");
  });

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

  test("mixed outcome: one group sent, the other retry, surfaces both", async () => {
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

describe("sendMail: stateful retry (#97)", () => {
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

    /** Only ONE captured send this attempt: the outlook one. */
    expect(captured).toHaveLength(1);
    expect(mxOf(captured[0]!.transportConfig)).toBe("smtp.outlook.com");

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
     *  failed: we don't re-resolve from a DNS-failed key. */
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

describe("sendMail: outbound SSRF guard on MX hosts", () => {
  test("never connects to an MX host that resolves to a private address", async () => {
    lookupResult = [{ address: "10.0.0.5", family: 4 }];

    const result = await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
      messageId: MID,
    });

    expect(createTransportMock).not.toHaveBeenCalled();
    const group = result.deliveryState["mx.example.org"]!;
    expect(group.status).toBe("retry");
    expect(group.lastError).toContain("non-public address");
    /** The internal address is not echoed back to the API caller. */
    expect(group.lastError).not.toContain("10.0.0.5");
  });

  test("refuses when any of several addresses is private", async () => {
    lookupResult = [
      { address: "198.51.100.7", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];

    await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
      messageId: MID,
    });

    expect(createTransportMock).not.toHaveBeenCalled();
  });

  test("prefers an IPv4 address when the host has both families", async () => {
    lookupResult = [
      { address: "2001:db8::25", family: 6 },
      { address: MX_IP, family: 4 },
    ];

    await sendMail({
      from: "hello@example.com",
      to: "user@example.org",
      subject: "test",
      messageId: MID,
    });

    expect(captured[0]!.transportConfig.host).toBe(MX_IP);
  });
});

describe("sendMail: signed per-recipient return paths (#236)", () => {
  const EMAIL_ID = "msg_0123456789abcdef01234567";
  const TO = "alice@example.org, bob@example.org";
  const CC = "carol@example.org";
  const BCC = "dave@example.org";

  /** The envelope of a captured send. */
  function envelopeOf(c: CapturedSend): { from: unknown; to: unknown } {
    const envelope = asRecord(c.mailOptions.envelope);
    return { from: envelope.from, to: envelope.to };
  }

  /** The recipient a return path verifies for against this email, or null. */
  function verifiedRecipient(address: unknown): string | null {
    if (typeof address !== "string") return null;
    const parsed = parseReturnPath(address);
    if (!parsed || parsed.emailId !== EMAIL_ID || parsed.domain !== "example.com")
      return null;
    const recipient = recipientOrder(TO, CC, BCC)[parsed.index];
    if (recipient === undefined) return null;
    return returnPathMacMatches(
      { emailId: EMAIL_ID, index: parsed.index, recipient },
      parsed.mac,
    )
      ? recipient
      : null;
  }

  test("each recipient is its own transaction with its own verified return path", async () => {
    const result = await sendMail({
      from: "hello@example.com",
      to: TO,
      cc: CC,
      bcc: BCC,
      subject: "test",
      messageId: MID,
      dkim: { domainName: "example.com", keySelector: "bunmail", privateKey: "PEM" },
      returnPath: { emailId: EMAIL_ID },
    });

    expect(captured).toHaveLength(4);
    const froms = new Set<unknown>();
    for (const c of captured) {
      const { from, to } = envelopeOf(c);
      /** Only its own recipient, and a return path naming exactly that recipient. */
      expect(Array.isArray(to) && to.length === 1).toBe(true);
      expect(verifiedRecipient(from)).toBe(Array.isArray(to) ? String(to[0]) : "");
      froms.add(from);
      /** Headers unchanged: From is the sender, To/Cc are the full lists, no Bcc. */
      expect(c.mailOptions.from).toBe("hello@example.com");
      expect(c.mailOptions.to).toBe(TO);
      expect(c.mailOptions.cc).toBe(CC);
      expect(c.mailOptions.bcc).toBeUndefined();
      /** Every transaction is DKIM-signed and keeps List-Unsubscribe. */
      expect(asRecord(c.mailOptions.dkim).domainName).toBe("example.com");
      expect(asRecord(c.mailOptions.headers)["List-Unsubscribe"]).toBe(
        "<mailto:unsubscribe@example.com>",
      );
    }
    expect(froms.size).toBe(4);

    /** One pooled single-connection transport for the MX, closed afterwards. */
    expect(createTransportMock).toHaveBeenCalledTimes(1);
    const cfg = captured[0]!.transportConfig;
    expect(cfg.pool).toBe(true);
    expect(cfg.maxConnections).toBe(1);
    expect(cfg.maxRequeues).toBe(0);
    expect(closedTransports).toBe(1);

    /** One state entry per recipient, keyed by MX and recipient index. */
    expect(Object.keys(result.deliveryState)).toEqual([
      "mx.example.org#0",
      "mx.example.org#1",
      "mx.example.org#2",
      "mx.example.org#3",
    ]);
    for (const group of Object.values(result.deliveryState)) {
      expect(group.status).toBe("sent");
      expect(group.mxHost).toBe("mx.example.org");
      expect(group.recipients).toHaveLength(1);
    }
  });

  test("a single-recipient email is one transaction, keyed by its MX as before", async () => {
    const result = await sendMail({
      from: "hello@example.com",
      to: "alice@example.org",
      subject: "test",
      messageId: MID,
      returnPath: { emailId: EMAIL_ID },
    });

    expect(captured).toHaveLength(1);
    expect(verifiedRecipient(envelopeOf(captured[0]!).from)).toBe("alice@example.org");
    expect(captured[0]!.transportConfig.pool).toBeUndefined();
    expect(Object.keys(result.deliveryState)).toEqual(["mx.example.org"]);
  });

  test("without a return path: one transaction per MX, envelope sender is From", async () => {
    const result = await sendMail({
      from: "hello@example.com",
      to: TO,
      cc: CC,
      bcc: BCC,
      subject: "test",
      messageId: MID,
    });

    expect(captured).toHaveLength(1);
    expect(envelopeOf(captured[0]!)).toEqual({
      from: "hello@example.com",
      to: [
        "alice@example.org",
        "bob@example.org",
        "carol@example.org",
        "dave@example.org",
      ],
    });
    expect(captured[0]!.transportConfig.pool).toBeUndefined();
    expect(closedTransports).toBe(0);
    expect(Object.keys(result.deliveryState)).toEqual(["mx.example.org"]);
  });

  test("failures are classified per recipient: hard, soft and sent side by side", async () => {
    sendBehaviour = (_host, opts) => {
      const to = asRecord(opts.envelope).to;
      const rcpt = Array.isArray(to) ? String(to[0]) : "";
      if (rcpt === "bob@example.org") return new Error("550 5.1.1 user unknown");
      if (rcpt === "carol@example.org") return new Error("451 4.7.1 try again later");
      return undefined;
    };

    const result = await sendMail({
      from: "hello@example.com",
      to: TO,
      cc: CC,
      subject: "test",
      messageId: MID,
      returnPath: { emailId: EMAIL_ID },
    });

    const state = result.deliveryState;
    expect(state["mx.example.org#0"]).toMatchObject({
      status: "sent",
      recipients: ["alice@example.org"],
    });
    expect(state["mx.example.org#1"]).toMatchObject({
      status: "failed",
      recipients: ["bob@example.org"],
      failureKind: "hard",
    });
    expect(state["mx.example.org#2"]).toMatchObject({
      status: "retry",
      recipients: ["carol@example.org"],
    });
  });

  test("a retry pass resends only the pending recipient, with its own return path", async () => {
    sendBehaviour = (_host, opts) => {
      const to = asRecord(opts.envelope).to;
      return Array.isArray(to) && to[0] === "bob@example.org"
        ? new Error("421 4.4.5 too many connections")
        : undefined;
    };
    const first = await sendMail({
      from: "hello@example.com",
      to: TO,
      subject: "test",
      messageId: MID,
      returnPath: { emailId: EMAIL_ID },
    });
    expect(first.deliveryState["mx.example.org#1"]!.status).toBe("retry");
    captured.length = 0;
    sendBehaviour = null;

    const second = await sendMail({
      from: "hello@example.com",
      to: TO,
      subject: "test",
      messageId: MID,
      existingState: first.deliveryState,
      returnPath: { emailId: EMAIL_ID },
    });

    expect(captured).toHaveLength(1);
    expect(envelopeOf(captured[0]!).to).toEqual(["bob@example.org"]);
    expect(verifiedRecipient(envelopeOf(captured[0]!).from)).toBe("bob@example.org");
    /** A lone transaction needs no pool. */
    expect(captured[0]!.transportConfig.pool).toBeUndefined();
    expect(second.deliveryState["mx.example.org#1"]).toMatchObject({
      status: "sent",
      attempts: 2,
    });
  });

  test("a pending group from before return paths were on is split per recipient", async () => {
    const result = await sendMail({
      from: "hello@example.com",
      to: TO,
      subject: "test",
      messageId: MID,
      existingState: {
        "mx.example.org": {
          status: "retry",
          recipients: ["alice@example.org", "bob@example.org"],
          attempts: 1,
        },
      },
      returnPath: { emailId: EMAIL_ID },
    });

    expect(captured).toHaveLength(2);
    expect(captured.map((c) => verifiedRecipient(envelopeOf(c).from))).toEqual([
      "alice@example.org",
      "bob@example.org",
    ]);
    expect(Object.keys(result.deliveryState)).toEqual([
      "mx.example.org#0",
      "mx.example.org#1",
    ]);
    expect(result.deliveryState["mx.example.org#1"]!.attempts).toBe(2);
  });

  test("per-recipient entries from an earlier pass still go to their MX without return paths", async () => {
    await sendMail({
      from: "hello@example.com",
      to: TO,
      subject: "test",
      messageId: MID,
      existingState: {
        "mx.example.org#1": {
          status: "retry",
          recipients: ["bob@example.org"],
          attempts: 1,
          mxHost: "mx.example.org",
        },
      },
    });

    expect(captured).toHaveLength(1);
    expect(mxOf(captured[0]!.transportConfig)).toBe("mx.example.org");
    expect(envelopeOf(captured[0]!)).toEqual({
      from: "hello@example.com",
      to: ["bob@example.org"],
    });
  });

  test("recipients on different MXs each get their own transport and return path", async () => {
    mxResolver = (domain) =>
      Promise.resolve([{ exchange: `smtp.${domain}`, priority: 10 }]);

    await sendMail({
      from: "hello@example.com",
      to: "alice@gmail.com",
      cc: "bob@outlook.com",
      subject: "test",
      messageId: MID,
      returnPath: { emailId: EMAIL_ID },
    });

    expect(captured).toHaveLength(2);
    const fromsByHost = new Map(
      captured.map((c) => [mxOf(c.transportConfig), envelopeOf(c).from]),
    );
    expect(parseReturnPath(String(fromsByHost.get("smtp.gmail.com")))?.index).toBe(0);
    expect(parseReturnPath(String(fromsByHost.get("smtp.outlook.com")))?.index).toBe(1);
  });
});
