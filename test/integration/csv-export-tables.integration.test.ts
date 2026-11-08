/**
 * CSV exports per table (#430) through the real `pagesPlugin` against
 * real Postgres: for each of the fifteen dashboard tables, the exact
 * header row, a seeded row in the file, and none of the secrets or bodies
 * the table holds (message bodies, raw messages, attachments, key hashes,
 * DKIM private keys, webhook secrets, token hashes, password hashes,
 * delivery payloads, report XML). Then that each export follows its
 * page's filters.
 */
import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, seed, truncateAll, emails, domains, webhooks } from "./_helpers.ts";
import { app, bodyText, get, parseCsv, rowObjects } from "./_csv.ts";
import { emailTombstones } from "../../src/modules/emails/models/email-tombstone.schema.ts";
import { inboundEmails } from "../../src/modules/inbound/models/inbound-email.schema.ts";
import { dmarcReports } from "../../src/modules/dmarc-reports/models/dmarc-report.schema.ts";
import { dmarcRecords } from "../../src/modules/dmarc-reports/models/dmarc-record.schema.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import { userTokens } from "../../src/modules/users/models/user-token.schema.ts";
import { userCredentials } from "../../src/modules/users/models/user-credential.schema.ts";
import { apiKeys } from "../../src/modules/api-keys/models/api-key.schema.ts";
import { recordAuditEvent } from "../../src/modules/audit/services/audit.service.ts";
import { exportBudgetMap, resetExportSlots } from "../../src/pages/lib/export-limiter.ts";
import { mintToken } from "../../src/modules/users/services/token.service.ts";
import { generateId } from "../../src/utils/id.ts";

/** Markers planted in every secret or body column: none may reach a file. */
const SECRET = {
  body: "SECRET_BODY_MARKER",
  text: "SECRET_TEXT_MARKER",
  raw: "SECRET_RAW_MARKER",
  attachment: "SECRET_ATTACHMENT_MARKER",
  dkim: "SECRET_DKIM_PRIVATE_MARKER",
  webhookSecret: "SECRET_WEBHOOK_SECRET_MARKER_0123456789",
  urlToken: "SECRET_URL_TOKEN_MARKER",
  urlPassword: "SECRET_URL_PASSWORD_MARKER",
  payload: "SECRET_PAYLOAD_MARKER",
  xml: "SECRET_XML_MARKER",
  templateBody: "SECRET_TEMPLATE_BODY_MARKER",
  headers: "SECRET_HEADER_MARKER",
} as const;

/** Secrets only known once seeded (hashes, ciphertexts, raw tokens). */
const runtimeSecrets: string[] = [];

const ctx = {
  adminToken: "",
  adminId: "",
  keyA: "",
  keyB: "",
  webhookId: "",
  domainName: "",
};

beforeAll(async () => {
  await truncateAll();
  /** `truncateAll` leaves the DMARC tables alone: clear them here. */
  await db.delete(dmarcRecords);
  await db.delete(dmarcReports);
  ctx.adminId = (
    await seed.user({
      email: "admin@example.com",
      role: "admin",
      password: "an admin password, long",
    })
  ).id;
  const session = await seed.session({ userId: ctx.adminId });
  ctx.adminToken = session.token;
  runtimeSecrets.push(session.token);
  const [credential] = await db
    .select({ hash: userCredentials.secretHash })
    .from(userCredentials)
    .where(eq(userCredentials.userId, ctx.adminId));
  if (credential?.hash) runtimeSecrets.push(credential.hash);

  const a = await seed.apiKey({ name: "key-a" });
  const b = await seed.apiKey({ name: "key-b", isAdmin: true });
  ctx.keyA = a.id;
  ctx.keyB = b.id;
  runtimeSecrets.push(a.rawKey, b.rawKey);
  for (const row of await db.select({ hash: apiKeys.keyHash }).from(apiKeys)) {
    runtimeSecrets.push(row.hash);
  }

  const domain = await seed.domain({
    name: "export.example.com",
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${SECRET.dkim}\n-----END PRIVATE KEY-----`,
  });
  ctx.domainName = domain.name;
  const [stored] = await db
    .select({ key: domains.dkimPrivateKey })
    .from(domains)
    .where(eq(domains.id, domain.id));
  if (stored?.key) runtimeSecrets.push(stored.key);

  const sent = await seed.email({
    apiKeyId: a.id,
    status: "sent",
    subject: 'Café crème, "quoted"',
    toAddress: "zoë@example.org",
    tags: { campaign: "spring" },
  });
  const failed = await seed.email({
    apiKeyId: b.id,
    status: "failed",
    subject: "=cmd|' /C calc'!A0",
  });
  const trashed = await seed.email({ apiKeyId: a.id, subject: "in the trash" });
  for (const id of [sent.id, failed.id, trashed.id]) {
    await db
      .update(emails)
      .set({
        html: `<p>${SECRET.body}</p>`,
        textContent: SECRET.text,
        headers: { "X-Secret": SECRET.headers },
      })
      .where(eq(emails.id, id));
  }
  await db.update(emails).set({ deletedAt: new Date() }).where(eq(emails.id, trashed.id));

  await db.insert(emailTombstones).values({
    id: generateId("msg"),
    apiKeyId: a.id,
    messageId: "<gone@example.com>",
    fromAddress: "hello@example.com",
    toAddress: "user@example.org",
    subject: "purged",
    status: "sent",
    attachments: [
      { filename: `${SECRET.attachment}.pdf`, contentType: "application/pdf", size: 10 },
    ],
  });

  for (const deleted of [false, true]) {
    await db.insert(inboundEmails).values({
      id: generateId("inb"),
      fromAddress: "customer@example.org",
      toAddress: "support@example.com",
      subject: deleted ? "trashed inbound" : "live inbound",
      html: `<p>${SECRET.body}</p>`,
      textContent: SECRET.text,
      rawMessage: `Subject: x\r\n\r\n${SECRET.raw}`,
      messageId: "<in@example.org>",
      deletedAt: deleted ? new Date() : null,
    });
  }

  await seed.suppression({
    apiKeyId: a.id,
    email: "bounced@gmail.com",
    reason: "bounce",
  });
  await seed.suppression({
    apiKeyId: b.id,
    email: "other@example.net",
    reason: "manual",
  });

  await db.insert(dmarcReports).values([
    {
      id: generateId("dmr"),
      orgName: "google.com",
      orgEmail: "noreply-dmarc@google.com",
      reportId: "r-1",
      domain: "export.example.com",
      dateBegin: new Date("2026-11-01T00:00:00Z"),
      dateEnd: new Date("2026-11-02T00:00:00Z"),
      policyP: "none",
      rawXml: `<feedback>${SECRET.xml}</feedback>`,
    },
    {
      id: generateId("dmr"),
      orgName: "yahoo.com",
      orgEmail: "dmarc@yahoo.com",
      reportId: "r-2",
      domain: "other.example.com",
      dateBegin: new Date("2026-11-02T00:00:00Z"),
      dateEnd: new Date("2026-11-03T00:00:00Z"),
      policyP: "reject",
      rawXml: `<feedback>${SECRET.xml}</feedback>`,
    },
  ]);

  const hook = await seed.webhook({
    apiKeyId: a.id,
    url: `https://bot:${SECRET.urlPassword}@hooks.example.com/in?token=${SECRET.urlToken}`,
    events: ["email.sent", "email.bounced"],
    secret: SECRET.webhookSecret,
  });
  ctx.webhookId = hook.id;
  const [storedHook] = await db
    .select({ secret: webhooks.secret })
    .from(webhooks)
    .where(eq(webhooks.id, hook.id));
  if (storedHook) runtimeSecrets.push(storedHook.secret);
  for (const status of ["delivered", "failed"]) {
    await db.insert(webhookDeliveries).values({
      id: generateId("wdl"),
      webhookId: hook.id,
      event: "email.sent",
      payload: JSON.stringify({ secret: SECRET.payload }),
      status,
    });
  }

  await seed.template({
    apiKeyId: a.id,
    html: `<p>${SECRET.templateBody}</p>`,
    text: SECRET.templateBody,
  });

  const invite = mintToken();
  runtimeSecrets.push(invite.token, invite.hash);
  await db.insert(userTokens).values({
    id: generateId("utk"),
    email: "invitee@example.com",
    purpose: "invite",
    role: "member",
    invitedBy: ctx.adminId,
    tokenHash: invite.hash,
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  await recordAuditEvent({
    action: "api_key.created",
    actor: { type: "user", id: ctx.adminId },
    target: { type: "api_key", id: a.id },
    ip: "203.0.113.7",
    userAgent: "test-agent",
    metadata: { isAdmin: false, allowedSenders: 0 },
  });
});

beforeEach(() => {
  /** Every test exports several tables: the per-user budget is tested in the stream file. */
  exportBudgetMap.clear();
  resetExportSlots();
});

/** Exports `path` as the admin and returns the parsed file and the raw text. */
async function exportAs(
  path: string,
): Promise<{ text: string; csv: ReturnType<typeof parseCsv> }> {
  const response = await get(path, ctx.adminToken);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  const text = await bodyText(response);
  return { text, csv: parseCsv(text) };
}

/** Fails when any planted marker or runtime secret appears in `text`. */
function expectNoSecrets(text: string): void {
  const leaked = [...Object.values(SECRET), ...runtimeSecrets].filter((s) =>
    text.includes(s),
  );
  expect(leaked).toEqual([]);
}

/** Header names that must never appear in any export. */
const FORBIDDEN_HEADERS = new Set([
  "html",
  "text_content",
  "raw_message",
  "headers",
  "attachments",
  "key_hash",
  "dkim_private_key",
  "dkim_pending_private_key",
  "secret",
  "token_hash",
  "secret_hash",
  "payload",
  "raw_xml",
  "delivery_state",
]);

/** A header row written as space-separated names. */
function cols(names: string): string[] {
  return names.split(" ");
}

/** Every table: its route, exact header row, and how many seeded rows it holds. */
const TABLES: Array<{ path: () => string; header: string[]; rows: number }> = [
  {
    path: () => "/dashboard/emails/export.csv",
    header: cols(
      "id created_at status source category api_key_id domain_id from_address from_name to_address cc bcc reply_to subject tags message_id attempts last_error sent_at first_opened_at first_clicked_at",
    ),
    rows: 2,
  },
  {
    path: () => "/dashboard/emails/trash/export.csv",
    header: cols(
      "id created_at status source category api_key_id domain_id from_address from_name to_address cc bcc reply_to subject tags message_id attempts last_error sent_at first_opened_at first_clicked_at deleted_at",
    ),
    rows: 1,
  },
  {
    path: () => "/dashboard/emails/tombstones/export.csv",
    header: cols(
      "id purged_at api_key_id message_id from_address to_address subject status sent_at deleted_at",
    ),
    rows: 1,
  },
  {
    path: () => "/dashboard/inbound/export.csv",
    header: cols(
      "id received_at from_address to_address subject message_id in_reply_to in_reply_to_email_id",
    ),
    rows: 1,
  },
  {
    path: () => "/dashboard/inbound/trash/export.csv",
    header: cols(
      "id received_at from_address to_address subject message_id in_reply_to in_reply_to_email_id deleted_at",
    ),
    rows: 1,
  },
  {
    path: () => "/dashboard/suppressions/export.csv",
    header: cols(
      "id created_at api_key_id email reason bounce_type diagnostic_code source_email_id expires_at",
    ),
    rows: 2,
  },
  {
    path: () => "/dashboard/audit-log/export.csv?action=api_key.created",
    header: cols(
      "id occurred_at actor_type actor_id actor_label action outcome target_type target_id target_label ip user_agent metadata",
    ),
    rows: 1,
  },
  {
    path: () => "/dashboard/dmarc-reports/export.csv",
    header: cols(
      "id domain org_name org_email report_id date_begin date_end policy_p policy_pct received_at",
    ),
    rows: 2,
  },
  {
    path: () => `/dashboard/webhooks/${ctx.webhookId}/deliveries/export.csv`,
    header: cols(
      "id created_at webhook_id event status attempts last_response_status last_error next_attempt_at delivered_at",
    ),
    rows: 2,
  },
  {
    path: () => "/dashboard/api-keys/export.csv",
    header: cols(
      "id name key_prefix is_active is_admin allowed_senders disabled_reason last_used_at created_at created_by_user_id",
    ),
    rows: 2,
  },
  {
    path: () => "/dashboard/domains/export.csv",
    header: cols(
      "id name spf_verified dkim_verified dmarc_verified verified_at last_checked_at consecutive_failures dkim_selector dkim_pending_selector dkim_rotated_at notify_email unsubscribe_email track_opens track_clicks created_at created_by_user_id",
    ),
    rows: 1,
  },
  {
    path: () => "/dashboard/templates/export.csv",
    header: cols(
      "id name subject variables api_key_id created_at updated_at created_by_user_id",
    ),
    rows: 1,
  },
  {
    path: () => "/dashboard/webhooks/export.csv",
    header: cols(
      "id url_origin events is_active api_key_id created_at updated_at created_by_user_id",
    ),
    rows: 1,
  },
  {
    path: () => "/dashboard/users/export.csv",
    header: cols("id email name role disabled disabled_at email_verified_at created_at"),
    rows: 1,
  },
  {
    path: () => "/dashboard/invitations/export.csv",
    header: cols(
      "id email role invited_by_user_id invited_by_email created_at expires_at",
    ),
    rows: 1,
  },
];

describe("CSV export columns per table (#430)", () => {
  for (const table of TABLES) {
    test(`${table.path().split("?")[0]}: exact header, seeded rows, no secret`, async () => {
      const { text, csv } = await exportAs(table.path());
      expect(csv.bom).toBe(true);
      expect(csv.header).toEqual(table.header);
      expect(csv.header.filter((h) => FORBIDDEN_HEADERS.has(h))).toEqual([]);
      expect(csv.rows).toHaveLength(table.rows);
      for (const row of csv.rows) expect(row).toHaveLength(table.header.length);
      expectNoSecrets(text);
    });
  }

  test("every exportable table is covered above", () => {
    const exportRoutes = app.routes
      .map((r) => r.path)
      .filter((path) => path.endsWith("/export.csv"));
    expect(exportRoutes).toHaveLength(TABLES.length);
  });
});

describe("CSV export cell contents (#430)", () => {
  test("emails: tags as key=value, unicode and quotes kept, a formula neutralised", async () => {
    const rows = rowObjects((await exportAs("/dashboard/emails/export.csv")).csv);
    const cafe = rows.find((r) => r.subject?.startsWith("Café"));
    expect(cafe?.subject).toBe('Café crème, "quoted"');
    expect(cafe?.to_address).toBe("zoë@example.org");
    expect(cafe?.tags).toBe("campaign=spring");
    expect(cafe?.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(rows.find((r) => r.status === "failed")?.subject).toBe("'=cmd|' /C calc'!A0");
  });

  test("webhooks: the URL is reduced to its origin, events are listed (#260 policy)", async () => {
    const [row] = rowObjects((await exportAs("/dashboard/webhooks/export.csv")).csv);
    expect(row?.url_origin).toBe("https://hooks.example.com");
    expect(row?.events).toBe("email.sent; email.bounced");
  });

  test("webhooks: Slack and Discord style URLs keep no part of their path secret", async () => {
    const slackSecret = "T0000SLACK/B0000SLACK/SLACKSECRETXXXXXXXXXXXX";
    const discordSecret = "123456789012345678/DISCORD-SECRET-TOKEN_abcdefghij";
    const slack = await seed.webhook({
      apiKeyId: ctx.keyA,
      url: `https://hooks.slack.com/services/${slackSecret}`,
      events: ["email.sent"],
    });
    const discord = await seed.webhook({
      apiKeyId: ctx.keyA,
      url: `https://discord.com/api/webhooks/${discordSecret}`,
      events: ["email.sent"],
    });
    try {
      const { text, csv } = await exportAs("/dashboard/webhooks/export.csv");
      const origins = rowObjects(csv).map((r) => r.url_origin);
      expect(origins).toContain("https://hooks.slack.com");
      expect(origins).toContain("https://discord.com");
      for (const piece of [
        "services",
        "SLACKSECRET",
        "T0000SLACK",
        "api/webhooks",
        "DISCORD-SECRET",
        "123456789012345678",
      ]) {
        expect(text).not.toContain(piece);
      }
    } finally {
      await db.delete(webhooks).where(eq(webhooks.id, slack.id));
      await db.delete(webhooks).where(eq(webhooks.id, discord.id));
    }
  });

  test("audit log: metadata as JSON, labels resolved", async () => {
    const [row] = rowObjects(
      (await exportAs("/dashboard/audit-log/export.csv?action=api_key.created")).csv,
    );
    expect(row?.actor_label).toBe("admin@example.com");
    expect(row?.target_label).toBe("key-a");
    expect(JSON.parse(row?.metadata ?? "null")).toEqual({
      isAdmin: false,
      allowedSenders: 0,
    });
  });

  test("api keys: the open tab's keys, Active by default (#431)", async () => {
    const revoked = await seed.apiKey({
      name: "key-revoked",
      isActive: false,
      disabledReason: "revoked",
    });
    try {
      const active = rowObjects((await exportAs("/dashboard/api-keys/export.csv")).csv);
      expect(
        active.map((r) => r.name ?? "").toSorted((x, y) => x.localeCompare(y)),
      ).toEqual(["key-a", "key-b"]);
      const gone = rowObjects(
        (await exportAs("/dashboard/api-keys/export.csv?tab=revoked")).csv,
      );
      expect(gone.map((r) => [r.name, r.is_active, r.disabled_reason])).toEqual([
        ["key-revoked", "false", "revoked"],
      ]);
    } finally {
      await db.delete(apiKeys).where(eq(apiKeys.id, revoked.id));
    }
  });

  test("api keys: booleans as true/false, the public prefix kept", async () => {
    const rows = rowObjects((await exportAs("/dashboard/api-keys/export.csv")).csv);
    expect(rows.find((r) => r.name === "key-b")?.is_admin).toBe("true");
    expect(rows.find((r) => r.name === "key-a")?.key_prefix).toMatch(/^bm_live_/);
  });
});

describe("CSV exports follow the page filters (#430)", () => {
  test("emails: status, source, API key and tag", async () => {
    const byStatus = rowObjects(
      (await exportAs("/dashboard/emails/export.csv?status=failed")).csv,
    );
    expect(byStatus.map((r) => r.status)).toEqual(["failed"]);

    const byKey = rowObjects(
      (await exportAs(`/dashboard/emails/export.csv?apiKeyId=${ctx.keyB}`)).csv,
    );
    expect(byKey.map((r) => r.api_key_id)).toEqual([ctx.keyB]);

    const bySource = (await exportAs("/dashboard/emails/export.csv?source=smtp")).csv;
    expect(bySource.rows).toHaveLength(0);

    const byTag = rowObjects(
      (await exportAs("/dashboard/emails/export.csv?tag=campaign:spring")).csv,
    );
    expect(byTag.map((r) => r.tags)).toEqual(["campaign=spring"]);
  });

  test("emails: an invalid tag goes back to the list instead of exporting", async () => {
    const response = await get(
      "/dashboard/emails/export.csv?tag=no-colon",
      ctx.adminToken,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard/emails?tag=no-colon");
  });

  test("suppressions: email substring and API key", async () => {
    const byEmail = rowObjects(
      (await exportAs("/dashboard/suppressions/export.csv?email=GMAIL")).csv,
    );
    expect(byEmail.map((r) => r.email)).toEqual(["bounced@gmail.com"]);
    const byKey = rowObjects(
      (await exportAs(`/dashboard/suppressions/export.csv?apiKeyId=${ctx.keyB}`)).csv,
    );
    expect(byKey.map((r) => r.email)).toEqual(["other@example.net"]);
  });

  test("tombstones: Message-ID with or without brackets", async () => {
    expect(
      (
        await exportAs(
          "/dashboard/emails/tombstones/export.csv?messageId=gone@example.com",
        )
      ).csv.rows,
    ).toHaveLength(1);
    expect(
      (await exportAs("/dashboard/emails/tombstones/export.csv?messageId=nope@x")).csv
        .rows,
    ).toHaveLength(0);
  });

  test("DMARC reports: domain", async () => {
    const rows = rowObjects(
      (await exportAs(`/dashboard/dmarc-reports/export.csv?domain=${ctx.domainName}`))
        .csv,
    );
    expect(rows.map((r) => r.domain)).toEqual([ctx.domainName]);
  });

  test("webhook deliveries: status; an unknown webhook goes back to the list", async () => {
    const rows = rowObjects(
      (
        await exportAs(
          `/dashboard/webhooks/${ctx.webhookId}/deliveries/export.csv?status=failed`,
        )
      ).csv,
    );
    expect(rows.map((r) => r.status)).toEqual(["failed"]);
    const missing = await get(
      "/dashboard/webhooks/whk_missing/deliveries/export.csv",
      ctx.adminToken,
    );
    expect(missing.status).toBe(302);
    expect(missing.headers.get("location")).toContain("/dashboard/webhooks?flash=");
  });

  test("audit log: action, outcome and actor", async () => {
    const byOutcome = rowObjects(
      (await exportAs("/dashboard/audit-log/export.csv?outcome=failure")).csv,
    );
    expect(byOutcome.every((r) => r.outcome === "failure")).toBe(true);
    const byActor = rowObjects(
      (
        await exportAs(
          `/dashboard/audit-log/export.csv?actor=user:${ctx.adminId}&action=api_key.created`,
        )
      ).csv,
    );
    expect(byActor.map((r) => r.actor_id)).toEqual([ctx.adminId]);
  });
});
