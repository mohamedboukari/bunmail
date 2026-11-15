import { describe, test, expect, beforeEach } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import {
  app,
  createApiKey,
  createEmail,
  deleteTemplateAs,
  errorLog,
  fakeKey,
  infoLog,
  listApiKeys,
  seedSession,
  useDashboardMocks,
  warnLog,
} from "./dashboard-setup.ts";
import { UnauthorizedSenderError } from "../../src/modules/api-keys/errors.ts";
import { SuppressedRecipientError } from "../../src/modules/suppressions/errors.ts";

/**
 * Dashboard E2E: what a failed form action logs (#448). A drizzle query
 * error's message embeds the query and its bound values (recipients,
 * subject, allowed senders), so a catch block logs it through
 * `loggableError`, never raw; a typed refusal logs at `warn` with its code,
 * never the address it carries. The logger is the fake from
 * `dashboard-setup.ts`, which records the raw arguments of each call, so
 * this checks the call sites themselves, not the logger's redaction.
 */
useDashboardMocks();

const SENDER = "ceo@example.com";
const RECIPIENT = "reader@example.org";
const SUBJECT = "Quarterly numbers for the board";

/** A failed insert as drizzle raises it: the message carries every parameter. */
function drizzleError(params: unknown[]): DrizzleQueryError {
  const cause = Object.assign(new Error("injected failure"), { errno: "23514" });
  return new DrizzleQueryError(
    "insert into emails (from_address, to_address, subject) values ($1, $2, $3)",
    params,
    cause,
  );
}

/** Every call the fake logger received, as one string. */
function everythingLogged(): string {
  return JSON.stringify([infoLog.mock.calls, warnLog.mock.calls, errorLog.mock.calls]);
}

/** Same-origin form POST with a session cookie. */
function post(
  path: string,
  token: string,
  fields: Record<string, string> = {},
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        cookie: `bm_session=${token}`,
        origin: "http://localhost",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

/** A send from the Send page with the one active key the fake lists. */
function send(token: string): Promise<Response> {
  listApiKeys.mockImplementationOnce(() => Promise.resolve([fakeKey()]));
  return post("/dashboard/send", token, {
    apiKeyId: "key_test123",
    from: SENDER,
    to: RECIPIENT,
    subject: SUBJECT,
    text: "Hello",
  });
}

/** The data of the one call to `log` whose message is `message`. */
function callData(
  log: typeof errorLog,
  message: string,
): Record<string, unknown> | undefined {
  const calls = log.mock.calls.filter((call) => call[0] === message);
  expect(calls).toHaveLength(1);
  return calls[0]?.[1];
}

describe("Dashboard E2E: failed actions log no query parameters (#448)", () => {
  beforeEach(() => {
    infoLog.mockClear();
    warnLog.mockClear();
    errorLog.mockClear();
  });

  test("a send that fails on the database logs the SQLSTATE, never the recipient or subject", async () => {
    createEmail.mockImplementationOnce(() =>
      Promise.reject(drizzleError([SENDER, RECIPIENT, SUBJECT])),
    );
    const response = await send(seedSession());
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard/send?flash=send_failed");

    expect(callData(errorLog, "Failed to send email via dashboard")).toEqual({
      apiKeyId: "key_test123",
      userId: "usr_owner",
      error: "Database query failed (SQLSTATE 23514)",
    });
    const logged = everythingLogged();
    expect(logged).not.toContain(SUBJECT);
    expect(logged).not.toContain(SENDER);
    expect(logged).not.toContain(RECIPIENT);
    expect(logged).not.toContain("Failed query");
  });

  test("a sender off the key's allowlist is a refusal: warn with its code, never the address", async () => {
    createEmail.mockImplementationOnce(() =>
      Promise.reject(new UnauthorizedSenderError(SENDER)),
    );
    const response = await send(seedSession());
    expect(response.headers.get("location")).toBe(
      "/dashboard/send?flash=send_sender_not_allowed",
    );

    expect(callData(warnLog, "Dashboard send refused")).toEqual({
      apiKeyId: "key_test123",
      userId: "usr_owner",
      code: "UNAUTHORIZED_SENDER",
    });
    expect(errorLog).not.toHaveBeenCalled();
    expect(everythingLogged()).not.toContain(SENDER);
  });

  test("a suppressed recipient is a refusal: warn with its code, never the recipient", async () => {
    createEmail.mockImplementationOnce(() =>
      Promise.reject(
        new SuppressedRecipientError({ suppressionId: "sup_1", recipient: RECIPIENT }),
      ),
    );
    await send(seedSession());

    expect(callData(warnLog, "Dashboard send refused")?.["code"]).toBe(
      "RECIPIENT_SUPPRESSED",
    );
    expect(errorLog).not.toHaveBeenCalled();
    expect(everythingLogged()).not.toContain(RECIPIENT);
  });

  test("an API key create that fails on the database never logs the allowed senders", async () => {
    createApiKey.mockImplementationOnce(() =>
      Promise.reject(drizzleError(["Billing", JSON.stringify([SENDER])])),
    );
    const response = await post("/dashboard/api-keys", seedSession(), {
      name: "Billing",
      allowedSenders: SENDER,
    });
    expect(response.headers.get("location")).toBe(
      "/dashboard/api-keys?flash=api_key_create_failed",
    );

    expect(callData(errorLog, "Failed to create API key via dashboard")).toEqual({
      userId: "usr_owner",
      error: "Database query failed (SQLSTATE 23514)",
    });
    expect(everythingLogged()).not.toContain(SENDER);
  });

  test("a template delete that fails is logged, with its id and no query", async () => {
    deleteTemplateAs.mockImplementationOnce(() =>
      Promise.reject(drizzleError(["tpl_1", SUBJECT])),
    );
    const response = await post("/dashboard/templates/tpl_1/delete", seedSession());
    expect(response.headers.get("location")).toBe(
      "/dashboard/templates?flash=template_delete_failed",
    );

    expect(callData(errorLog, "Failed to delete template via dashboard")).toEqual({
      templateId: "tpl_1",
      userId: "usr_owner",
      error: "Database query failed (SQLSTATE 23514)",
    });
    expect(everythingLogged()).not.toContain(SUBJECT);
  });
});
