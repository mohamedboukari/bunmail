import { describe, test, expect } from "bun:test";
import { sendSuccessFlash } from "../../src/pages/send-warnings.ts";
import { flashUrl } from "../../src/pages/lib/flash.ts";
import {
  SenderDomainNotRegisteredError,
  SenderDomainUnverifiedError,
  SubjectRequiredError,
  TemplateNotFoundError,
} from "../../src/modules/emails/errors.ts";
import type { SendWarning } from "../../src/modules/emails/types/email.types.ts";
import { flashOfLocation } from "../flash-of.ts";

/** What the Send page shows after a send with these warnings. */
function bannerFor(warnings: SendWarning[]): string | undefined {
  return flashOfLocation(flashUrl("/dashboard/send", sendSuccessFlash(warnings)))
    ?.message;
}

/**
 * Dashboard send flash (#245): sender-domain warnings in plain words. The
 * URL carries a code and, for unverified records, their bits (#421).
 */
describe("sendSuccessFlash", () => {
  test("no warnings: just queued", () => {
    expect(sendSuccessFlash([])).toBe("email_queued");
    expect(bannerFor([])).toBe("Email queued for delivery.");
  });

  test("one unverified record", () => {
    expect(sendSuccessFlash(["dkim_unverified"])).toEqual({
      code: "email_queued_unverified",
      n: 1,
    });
    expect(bannerFor(["dkim_unverified"])).toBe(
      "Email queued for delivery. Warning: the sender domain's DKIM record is not verified, so the email may be rejected or land in spam. Publish the DNS records and run Verify on the Domains page.",
    );
  });

  test("several records are listed in DKIM, SPF, DMARC order", () => {
    expect(bannerFor(["dmarc_unverified", "spf_unverified"])).toContain(
      "SPF and DMARC records are not verified",
    );
    expect(
      bannerFor(["dmarc_unverified", "dkim_unverified", "spf_unverified"]),
    ).toContain("DKIM, SPF and DMARC records are not verified");
  });

  test("unregistered domain (development)", () => {
    expect(sendSuccessFlash(["domain_unregistered"])).toBe("email_queued_unregistered");
    expect(bannerFor(["domain_unregistered"])).toContain(
      "the sender domain is not registered in BunMail",
    );
  });

  test("bits beyond the three records name nothing more", () => {
    expect(
      flashOfLocation("/dashboard/send?flash=email_queued_unverified&flashN=8"),
    ).toEqual({
      message: "Email queued for delivery.",
      type: "success",
    });
    expect(
      flashOfLocation("/dashboard/send?flash=email_queued_unverified&flashN=12")?.message,
    ).toContain("the sender domain's DMARC record is not verified");
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
