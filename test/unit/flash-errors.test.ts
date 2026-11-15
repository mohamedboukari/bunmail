import { describe, test, expect } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import {
  dkimRotationErrorFlash,
  domainAddErrorFlash,
  sendErrorFlash,
  webhookCreateErrorFlash,
} from "../../src/pages/flash-errors.ts";
import { flashUrl, type Flash } from "../../src/pages/lib/flash.ts";
import {
  DkimRotationError,
  DomainAlreadyRegisteredError,
  InvalidDkimSelectorError,
  InvalidDomainNameError,
} from "../../src/modules/domains/errors.ts";
import {
  BodyRequiredError,
  IdempotencyKeyReusedError,
  InvalidCustomHeaderError,
  InvalidFromAddressError,
  InvalidFromNameError,
  SenderDomainNotRegisteredError,
  SenderDomainUnverifiedError,
  SubjectRequiredError,
  TooManyRecipientsError,
} from "../../src/modules/emails/errors.ts";
import {
  InactiveApiKeyError,
  UnauthorizedSenderError,
} from "../../src/modules/api-keys/errors.ts";
import { SuppressedRecipientError } from "../../src/modules/suppressions/errors.ts";
import {
  InboundEventsRequireAdminError,
  WebhookLimitReachedError,
} from "../../src/modules/webhooks/errors.ts";
import { BlockedUrlError } from "../../src/utils/ssrf-guard.ts";
import { flashOfLocation } from "../flash-of.ts";

/**
 * Error flashes (#421): a redirect carries a code chosen from the error's
 * class, never the error's message, so neither a database error (whose
 * message carries the query and its values) nor a typed error's echo of
 * user input (a domain name, a header) reaches the URL.
 */

/** A database error whose message embeds a bound value. */
const DB_ERROR = new DrizzleQueryError(
  'insert into "templates" ("html") values ($1)',
  ["<p>secret body</p>"],
  new Error("duplicate key value"),
);

/** Each send error and the code it maps to. */
const SEND_CASES: Array<[unknown, Flash]> = [
  [new SenderDomainNotRegisteredError("example.com"), "send_domain_unregistered"],
  [new SenderDomainUnverifiedError("example.com"), "send_domain_unverified"],
  [new SubjectRequiredError(), "send_subject_required"],
  [new BodyRequiredError(), "send_body_required"],
  [new InvalidFromAddressError(), "send_invalid_from"],
  [new InvalidFromNameError("too_long", "x"), "send_invalid_from_name"],
  [new InvalidCustomHeaderError("invalid_name", null, "x"), "send_invalid_header"],
  [
    new SuppressedRecipientError({ suppressionId: null, recipient: "a@example.com" }),
    "send_recipient_suppressed",
  ],
  [new UnauthorizedSenderError("a@example.com"), "send_sender_not_allowed"],
  [new InactiveApiKeyError(), "send_key_revoked"],
  [new IdempotencyKeyReusedError(), "send_rejected"],
  [DB_ERROR, "send_failed"],
  [new TypeError("x is undefined"), "send_failed"],
  ["boom", "send_failed"],
];

describe("sendErrorFlash", () => {
  test.each(SEND_CASES)("%p maps to %p", (error, code) => {
    expect(sendErrorFlash(error)).toBe(code);
  });

  test("a recipient limit travels as the code's number, not as text", () => {
    expect(sendErrorFlash(new TooManyRecipientsError("to", 50))).toEqual({
      code: "send_too_many_to",
      n: 50,
    });
    const url = flashUrl(
      "/dashboard/send",
      sendErrorFlash(new TooManyRecipientsError("recipients", 100)),
    );
    expect(url).toBe("/dashboard/send?flash=send_too_many_recipients&flashN=100");
    expect(flashOfLocation(url)).toEqual({
      message: "At most 100 unique recipients across to, cc and bcc.",
      type: "error",
    });
  });

  test("the sender domain named by the error never reaches the URL", () => {
    const url = flashUrl(
      "/dashboard/send",
      sendErrorFlash(new SenderDomainNotRegisteredError("evil.example")),
    );
    expect(url).not.toContain("evil");
  });
});

describe("webhookCreateErrorFlash", () => {
  test("typed refusals have their own code, anything else the fallback", () => {
    expect(webhookCreateErrorFlash(new InboundEventsRequireAdminError())).toBe(
      "webhook_admin_events",
    );
    expect(webhookCreateErrorFlash(new WebhookLimitReachedError(25))).toEqual({
      code: "webhook_limit_reached",
      n: 25,
    });
    expect(webhookCreateErrorFlash(DB_ERROR)).toBe("webhook_create_failed");
    expect(webhookCreateErrorFlash(new Error("anything"))).toBe("webhook_create_failed");
  });
});

describe("webhookCreateErrorFlash: a URL the SSRF guard refuses", () => {
  test.each([
    "Webhook URL must use https (set WEBHOOK_ALLOW_INSECURE_HTTP=true to allow http).",
    "Webhook URL must use http or https.",
    "Webhook URL host 10.0.0.1 is a private/reserved address.",
    'Webhook URL host "internal.example" could not be resolved.',
  ])("%p maps to webhook_url_blocked, never naming the host", (message) => {
    const flash = webhookCreateErrorFlash(new BlockedUrlError(message));
    expect(flash).toBe("webhook_url_blocked");
    const url = flashUrl("/dashboard/webhooks", flash);
    expect(url).toBe("/dashboard/webhooks?flash=webhook_url_blocked");
    expect(flashOfLocation(url)).toEqual({
      message:
        "The webhook URL was refused: it must be a valid https:// URL (http:// only where this server allows it) whose host resolves to a public address.",
      type: "error",
    });
  });
});

describe("domainAddErrorFlash", () => {
  test("typed refusals have their own code, anything else the fallback", () => {
    expect(domainAddErrorFlash(new DomainAlreadyRegisteredError("example.com"))).toBe(
      "domain_already_registered",
    );
    expect(domainAddErrorFlash(new InvalidDomainNameError())).toBe("domain_invalid_name");
    expect(domainAddErrorFlash(new InvalidDkimSelectorError())).toBe(
      "domain_invalid_selector",
    );
    expect(domainAddErrorFlash(DB_ERROR)).toBe("domain_add_failed");
  });

  test("the fixed texts match the errors' own messages where those carry no input", () => {
    expect(flashOfLocation(flashUrl("/d", "domain_invalid_name"))?.message).toBe(
      new InvalidDomainNameError().message,
    );
    expect(flashOfLocation(flashUrl("/d", "domain_invalid_selector"))?.message).toBe(
      new InvalidDkimSelectorError().message,
    );
  });
});

describe("dkimRotationErrorFlash", () => {
  test.each([
    ["DKIM_ROTATION_PENDING", "dkim_rotation_pending"],
    ["DKIM_NO_PENDING_ROTATION", "dkim_no_pending_rotation"],
    ["DKIM_PENDING_NOT_PUBLISHED", "dkim_pending_not_published"],
    ["DKIM_PENDING_KEY_UNREADABLE", "dkim_pending_key_unreadable"],
  ] as const)("%p maps to %p", (errorCode, code) => {
    expect(
      dkimRotationErrorFlash(
        new DkimRotationError(errorCode, "detail with bunmail._domainkey"),
        "dkim_rotation_start_failed",
      ),
    ).toBe(code);
  });

  test("any other error is the step's fallback", () => {
    expect(dkimRotationErrorFlash(DB_ERROR, "dkim_rotation_complete_failed")).toBe(
      "dkim_rotation_complete_failed",
    );
  });
});
