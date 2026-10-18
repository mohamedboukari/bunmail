import { describe, test, expect } from "bun:test";
import { sendSuccessFlash } from "../../src/pages/send-warnings.ts";
import {
  SenderDomainNotRegisteredError,
  SenderDomainUnverifiedError,
  SubjectRequiredError,
  TemplateNotFoundError,
} from "../../src/modules/emails/errors.ts";

/** Dashboard send flash (#245): sender-domain warnings in plain words. */
describe("sendSuccessFlash", () => {
  test("no warnings: just queued", () => {
    expect(sendSuccessFlash([])).toBe("Email queued for delivery.");
  });

  test("one unverified record", () => {
    expect(sendSuccessFlash(["dkim_unverified"])).toBe(
      "Email queued for delivery. Warning: the sender domain's DKIM record is not verified, so the email may be rejected or land in spam. Publish the DNS records and run Verify on the Domains page.",
    );
  });

  test("several records are listed in DKIM, SPF, DMARC order", () => {
    expect(sendSuccessFlash(["dmarc_unverified", "spf_unverified"])).toContain(
      "SPF and DMARC records are not verified",
    );
    expect(
      sendSuccessFlash(["dmarc_unverified", "dkim_unverified", "spf_unverified"]),
    ).toContain("DKIM, SPF and DMARC records are not verified");
  });

  test("unregistered domain (development)", () => {
    expect(sendSuccessFlash(["domain_unregistered"])).toContain(
      "the sender domain is not registered in BunMail",
    );
  });
});

/** Typed send rejections carry their REST status and stable code. */
describe("EmailSendRejectedError subclasses", () => {
  test.each([
    [
      new SenderDomainNotRegisteredError("example.com"),
      422,
      "SENDER_DOMAIN_NOT_REGISTERED",
    ],
    [new SenderDomainUnverifiedError("example.com"), 422, "SENDER_DOMAIN_UNVERIFIED"],
    [new TemplateNotFoundError(), 404, "TEMPLATE_NOT_FOUND"],
    [new SubjectRequiredError(), 422, "SUBJECT_REQUIRED"],
  ])("%p", (error, status, code) => {
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
  });
});
