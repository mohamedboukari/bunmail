import { describe, test, expect } from "bun:test";
import {
  BodyRequiredError,
  EmailSendRejectedError,
  IdempotencyKeyReusedError,
  InvalidFromAddressError,
  InvalidFromNameError,
  InvalidTagError,
  MarketingRequiresOneClickError,
  SubjectRequiredError,
  TooManyRecipientsError,
} from "../../src/modules/emails/errors.ts";

/**
 * The send refusals' REST contract: `src/app.ts` answers any
 * `EmailSendRejectedError` with its `status` and `code` (and, for the
 * validation-shaped ones, the field or path in `details`), so these
 * values are public API. None of the messages may echo what was sent:
 * tags and display names can hold customer data.
 */

describe("EmailSendRejectedError subclasses", () => {
  test.each([
    [new BodyRequiredError(), 422, "BODY_REQUIRED"],
    [new SubjectRequiredError(), 422, "SUBJECT_REQUIRED"],
    [new IdempotencyKeyReusedError(), 422, "IDEMPOTENCY_KEY_REUSED"],
    [new InvalidFromAddressError(), 422, "VALIDATION_ERROR"],
    [
      new InvalidFromNameError("too_long", "fromName is too long"),
      422,
      "VALIDATION_ERROR",
    ],
    [
      new InvalidTagError("invalid_key", "/tags", "a tag key is invalid"),
      422,
      "VALIDATION_ERROR",
    ],
    [
      new MarketingRequiresOneClickError("recipients"),
      422,
      "MARKETING_REQUIRES_ONE_CLICK",
    ],
  ])("%p answers %p %p", (error, status, code) => {
    expect(error).toBeInstanceOf(EmailSendRejectedError);
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
  });

  test("validation-shaped refusals name the field or path for `details`, never the value", () => {
    const fromName = new InvalidFromNameError(
      "forbidden_character",
      "fromName holds a forbidden character",
    );
    expect(fromName.field).toBe("fromName");
    expect(fromName.problem).toBe("forbidden_character");
    expect(new InvalidFromAddressError().field).toBe("from");
    expect(new InvalidFromAddressError().message).toBe(
      "from must be a single email address",
    );

    const tag = new InvalidTagError(
      "empty_value",
      "/tags/customer",
      "tag customer has an empty value",
    );
    expect(tag.path).toBe("/tags/customer");
    expect(tag.problem).toBe("empty_value");
  });

  test("the idempotency refusal tells the client what to do without echoing the key", () => {
    expect(new IdempotencyKeyReusedError().message).toBe(
      "This Idempotency-Key was already used with a different request body. Use a new key for a new request.",
    );
  });

  test("MarketingRequiresOneClickError explains the cause it was given", () => {
    const recipients = new MarketingRequiresOneClickError("recipients");
    expect(recipients.reason).toBe("recipients");
    expect(recipients.message).toContain("exactly one recipient");
    const baseUrl = new MarketingRequiresOneClickError("app_base_url");
    expect(baseUrl.reason).toBe("app_base_url");
    expect(baseUrl.message).toContain("APP_BASE_URL");
  });

  test("TooManyRecipientsError names the cap of the field that was over it", () => {
    const to = new TooManyRecipientsError("to", 50);
    expect(to.code).toBe("TOO_MANY_RECIPIENTS");
    expect(to.field).toBe("to");
    expect(to.max).toBe(50);
    expect(to.message).toBe("At most 50 addresses in to.");
    expect(new TooManyRecipientsError("recipients", 100).message).toBe(
      "At most 100 unique recipients across to, cc and bcc.",
    );
  });
});
