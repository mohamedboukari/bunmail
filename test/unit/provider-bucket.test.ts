import { describe, test, expect } from "bun:test";
import { providerBucket } from "../../src/modules/emails/services/provider-bucket.ts";

/**
 * Provider buckets of the outbound throttle and rate budget (#250): the
 * lock key derived from the MX host actually connected to.
 */
describe("providerBucket", () => {
  test.each([
    ["example-com.mail.protection.outlook.com", "microsoft"],
    ["example-com.olc.protection.outlook.com", "microsoft"],
    ["outlook.com", "microsoft"],
    ["mx1.hotmail.outlook.com", "microsoft"],
    ["aspmx.l.google.com", "google"],
    ["alt1.aspmx.l.google.com", "google"],
    ["gmail-smtp-in.l.google.com", "google"],
    ["alt2.gmail-smtp-in.l.googlemail.com", "google"],
    ["mta5.am0.yahoodns.net", "yahoo"],
    ["mx-aol.mail.gm0.yahoodns.net", "yahoo"],
    ["mx01.mail.icloud.com", "apple"],
    ["mx02.icloud.com", "apple"],
  ])("%p is %p", (host, bucket) => {
    expect(providerBucket(host)).toBe(bucket);
  });

  test("case, surrounding space and the trailing dot are ignored", () => {
    expect(providerBucket(" ASPMX.L.Google.COM. ")).toBe("google");
    expect(providerBucket("MX.Example.COM.")).toBe("example.com");
  });

  test.each([
    ["evilgoogle.com", "evilgoogle.com"],
    ["mx.evilgoogle.com", "evilgoogle.com"],
    ["google.com.evil.net", "evil.net"],
    ["aspmx.l.google.com.evil.net", "evil.net"],
    ["notoutlook.com", "notoutlook.com"],
    ["outlook.com.example.org", "example.org"],
    ["fakeicloud.com", "fakeicloud.com"],
    ["yahoodns.net.example.com", "example.com"],
  ])("a lookalike is not a provider: %p is %p", (host, bucket) => {
    expect(providerBucket(host)).toBe(bucket);
  });

  test("any other host: its registrable domain", () => {
    expect(providerBucket("mx1.example.org")).toBe("example.org");
    expect(providerBucket("mx2.example.org")).toBe("example.org");
    expect(providerBucket("mx.a.b.example.net")).toBe("example.net");
    expect(providerBucket("mx1.example.co.uk")).toBe("example.co.uk");
    expect(providerBucket("mail.shop.com.au")).toBe("shop.com.au");
  });

  test("an address literal is its own bucket", () => {
    expect(providerBucket("203.0.113.10")).toBe("203.0.113.10");
    expect(providerBucket("[203.0.113.10]")).toBe("203.0.113.10");
    expect(providerBucket("2001:db8::25")).toBe("2001:db8::25");
    expect(providerBucket("[2001:DB8::25]")).toBe("2001:db8::25");
  });

  test("a single-label host never joins a provider's bucket", () => {
    expect(providerBucket("google")).toBe("google.");
    expect(providerBucket("microsoft")).toBe("microsoft.");
  });
});
