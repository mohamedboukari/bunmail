import { describe, test, expect } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import {
  DKIM_SELECTOR_PATTERN,
  datedDkimSelector,
  dkimRecordValue,
  dkimRecordsMatchKey,
  isValidDkimSelector,
  publicKeyBase64,
} from "../../src/modules/domains/services/dkim-keys.ts";
import { createDomainDto } from "../../src/modules/domains/dtos/create-domain.dto.ts";
import {
  TXT_STRING_MAX,
  getRequiredDnsRecords,
  pendingDkimDnsRecord,
} from "../../src/modules/domains/services/required-dns-records.ts";

/**
 * DKIM selectors and key rotation helpers (#250): the selector rules, the
 * dated selector of a rotation, the pending record and the comparison of
 * a published record with a key.
 */

function rsaPublicKey(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).publicKey;
}

const activeKey = rsaPublicKey();
const pendingKey = rsaPublicKey();
const settings = { mailHostname: "mail.bunmail.test", publicIps: ["203.0.113.10"] };

describe("isValidDkimSelector", () => {
  test.each(["bunmail", "a", "0", "s1", "bm20261019-2", "mail-2026-q4", "a".repeat(63)])(
    "accepts %p",
    (selector) => {
      expect(isValidDkimSelector(selector)).toBe(true);
    },
  );

  test.each([
    "",
    "-a",
    "a-",
    "Bunmail",
    "BUNMAIL",
    "a.b",
    "a_b",
    "a b",
    " bunmail",
    "bunmail\n",
    "sélecteur",
    "a".repeat(64),
  ])("refuses %p", (selector) => {
    expect(isValidDkimSelector(selector)).toBe(false);
  });

  test("the create DTO applies the same rule", () => {
    const dto = TypeCompiler.Compile(createDomainDto);
    expect(dto.Check({ name: "acme.io", dkimSelector: "s1" })).toBe(true);
    expect(dto.Check({ name: "acme.io" })).toBe(true);
    for (const bad of ["", "Bad", "-x", "a.b", "a".repeat(64)]) {
      expect(dto.Check({ name: "acme.io", dkimSelector: bad })).toBe(false);
    }
    expect(DKIM_SELECTOR_PATTERN.startsWith("^")).toBe(true);
    expect(DKIM_SELECTOR_PATTERN.endsWith("$")).toBe(true);
  });
});

describe("datedDkimSelector", () => {
  const now = new Date("2026-10-19T12:00:00Z");

  test("is bm<YYYYMMDD> of the UTC date", () => {
    expect(datedDkimSelector(now, ["bunmail", null])).toBe("bm20261019");
    expect(datedDkimSelector(new Date("2026-01-02T23:59:59Z"), [])).toBe("bm20260102");
    expect(datedDkimSelector(new Date("2026-01-02T23:30:00-05:00"), [])).toBe(
      "bm20260103",
    );
  });

  test("appends -2 when the day's selector is the current one", () => {
    expect(datedDkimSelector(now, ["bm20261019", null])).toBe("bm20261019-2");
  });

  test("skips every selector still in use, current or previous", () => {
    expect(datedDkimSelector(now, ["bm20261019-2", "bm20261019"])).toBe("bm20261019-3");
    expect(datedDkimSelector(now, ["bm20261019", "bm20261019-2"])).toBe("bm20261019-3");
  });

  test("never returns the current selector and is always a valid selector", () => {
    for (const current of ["bm20261019", "bm20261019-2", "bunmail", "bm20261018"]) {
      const selector = datedDkimSelector(now, [current, "bm20261019"]);
      expect(selector).not.toBe(current);
      expect(isValidDkimSelector(selector)).toBe(true);
    }
  });
});

describe("pending DKIM record", () => {
  const domain = {
    name: "acme.io",
    dkimSelector: "bunmail",
    dkimPublicKey: activeKey,
    dkimPendingSelector: "bm20261019",
    dkimPendingPublicKey: pendingKey,
  };

  test("follows the active DKIM record, flagged pending, split into 255-character strings", () => {
    const records = getRequiredDnsRecords(domain, settings);
    const activeIndex = records.findIndex((r) => r.host === "bunmail._domainkey.acme.io");
    const pending = records[activeIndex + 1];
    expect(pending).toMatchObject({
      type: "TXT",
      host: "bm20261019._domainkey.acme.io",
      optional: false,
      pending: true,
    });
    const parts = [...(pending?.value ?? "").matchAll(/"([^"]*)"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(TXT_STRING_MAX);
    expect(parts.join("")).toBe(dkimRecordValue(pendingKey));
    expect(records[activeIndex]?.pending).toBeUndefined();
  });

  test("is absent when no rotation is pending", () => {
    const none = { ...domain, dkimPendingSelector: null, dkimPendingPublicKey: null };
    expect(pendingDkimDnsRecord(none)).toBeNull();
    expect(getRequiredDnsRecords(none, settings).some((r) => r.pending)).toBe(false);
    /** Callers that only know the active columns still work. */
    expect(
      getRequiredDnsRecords(
        { name: "acme.io", dkimSelector: "bunmail", dkimPublicKey: activeKey },
        settings,
      ).some((r) => r.pending),
    ).toBe(false);
  });
});

describe("dkimRecordsMatchKey", () => {
  const record = dkimRecordValue(pendingKey);

  test("matches the record, whitespace and string splits ignored", () => {
    expect(dkimRecordsMatchKey([record], pendingKey)).toBe(true);
    expect(dkimRecordsMatchKey([record.replaceAll("; ", ";  ")], pendingKey)).toBe(true);
    /** Split across records, as some providers publish a long value. */
    expect(
      dkimRecordsMatchKey([record.slice(0, 200), record.slice(200)], pendingKey),
    ).toBe(true);
    /** Next to unrelated TXT records. */
    expect(dkimRecordsMatchKey(["google-site-verification=x", record], pendingKey)).toBe(
      true,
    );
  });

  test("refuses another key, a missing version tag, or nothing", () => {
    expect(dkimRecordsMatchKey([dkimRecordValue(activeKey)], pendingKey)).toBe(false);
    expect(
      dkimRecordsMatchKey([`k=rsa; p=${publicKeyBase64(pendingKey)}`], pendingKey),
    ).toBe(false);
    expect(dkimRecordsMatchKey([], pendingKey)).toBe(false);
    /** A truncated key is not the key. */
    expect(dkimRecordsMatchKey([record.slice(0, -20)], pendingKey)).toBe(false);
  });
});
