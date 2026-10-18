/**
 * Domain names are case-insensitive (DNS names are): stored lowercase,
 * registered once whatever the case, and found by any spelling, including
 * rows created before names were stored lowercase. Real Postgres.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  createDomain,
  domainExistsByName,
  getDomainByName,
} from "../../src/modules/domains/services/domain.service.ts";
import { checkSenderDomain } from "../../src/modules/emails/services/sender-domain.service.ts";
import { DomainAlreadyRegisteredError } from "../../src/modules/domains/errors.ts";
import { truncateAll, seed } from "./_helpers.ts";

beforeEach(async () => {
  await truncateAll();
});

describe("registering a domain", () => {
  test("stores the name lowercase", async () => {
    const domain = await createDomain({ name: "  Example.COM " });
    expect(domain.name).toBe("example.com");
  }, 30_000);

  test("refuses the same name in another case with a typed error", async () => {
    await createDomain({ name: "example.com" });
    let caught: unknown;
    try {
      await createDomain({ name: "EXAMPLE.com" });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainAlreadyRegisteredError);
  }, 30_000);
});

describe("looking a domain up", () => {
  test("finds a legacy mixed-case row by any spelling", async () => {
    const { id } = await seed.domain({ name: "Legacy.Example.com" });

    expect((await getDomainByName("legacy.example.com"))?.id).toBe(id);
    expect(await domainExistsByName("LEGACY.EXAMPLE.COM")).toBe(true);
    const check = await checkSenderDomain("legacy.EXAMPLE.com", {
      id: "eml_test",
      apiKeyId: "key_test",
    });
    expect(check.domainId).toBe(id);
  });

  test("an unknown name is still unknown", async () => {
    await seed.domain({ name: "example.com" });
    expect(await domainExistsByName("example.org")).toBe(false);
  });
});
