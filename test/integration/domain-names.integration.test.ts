/**
 * Domain names are case-insensitive (DNS names are): stored lowercase,
 * registered once whatever the case, and found by any spelling, including
 * rows created before names were stored lowercase. Since #406 a name is
 * normalised (no final dot, an IDN as its A-label) and refused unless a
 * host name, over REST (422) and on the dashboard (error flash); rows
 * stored before are reported, never changed. Real Postgres.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import {
  createDomain,
  domainExistsByName,
  findNonCanonicalDomainNames,
  getDomainByName,
} from "../../src/modules/domains/services/domain.service.ts";
import { checkSenderDomain } from "../../src/modules/emails/services/sender-domain.service.ts";
import {
  DomainAlreadyRegisteredError,
  InvalidDomainNameError,
} from "../../src/modules/domains/errors.ts";
import { domainsPlugin } from "../../src/modules/domains/domains.plugin.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { truncateAll, seed, db, domains } from "./_helpers.ts";
import { readJson } from "../read-json.ts";

/** Mirrors the domain name branches of the global onError in `src/app.ts`. */
const api = new Elysia()
  .onError(({ error, set }) => {
    if (error instanceof InvalidDomainNameError) {
      set.status = 422;
      return { success: false, error: error.message, code: error.code };
    }
    if (error instanceof DomainAlreadyRegisteredError) {
      set.status = 409;
      return { success: false, error: error.message, code: error.code };
    }
  })
  .use(domainsPlugin);

const pages = new Elysia().use(pagesPlugin);

interface ApiBody {
  success: boolean;
  data?: { id: string; name: string };
  error?: string;
  code?: string;
}

/** `POST /api/v1/domains` with an admin key. */
async function register(name: string): Promise<ApiBody & { status: number }> {
  const { rawKey } = await seed.apiKey({ name: "domain names", isAdmin: true });
  const res = await api.handle(
    new Request("http://localhost/api/v1/domains", {
      method: "POST",
      headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
  return { status: res.status, ...(await readJson<ApiBody>(res)) };
}

/** The dashboard add form, as an admin. */
async function addOnDashboard(name: string): Promise<Response> {
  const user = await seed.user({ email: "admin@example.org", role: "admin" });
  const { token } = await seed.session({ userId: user.id });
  return pages.handle(
    new Request("http://localhost/dashboard/domains", {
      method: "POST",
      headers: {
        cookie: `bm_session=${token}`,
        origin: "http://localhost",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ name }).toString(),
    }),
  );
}

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

describe("normalising and checking a name on create (#406)", () => {
  test("stores the normalised form: no final dot, an IDN as its A-label", async () => {
    expect((await createDomain({ name: "Example.COM." })).name).toBe("example.com");
    expect((await createDomain({ name: "bücher.example" })).name).toBe(
      "xn--bcher-kva.example",
    );
  }, 30_000);

  test("Example.COM. and example.com are the same domain", async () => {
    await createDomain({ name: "example.com" });
    let caught: unknown;
    try {
      await createDomain({ name: "Example.COM." });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainAlreadyRegisteredError);
    expect(await db.select().from(domains)).toHaveLength(1);
  }, 30_000);

  test("an invalid name is refused and nothing is stored", async () => {
    for (const name of [
      "localhost",
      "https://example.com",
      "example.com:25",
      "-bad.com",
    ]) {
      let caught: unknown;
      try {
        await createDomain({ name });
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InvalidDomainNameError);
    }
    expect(await db.select().from(domains)).toHaveLength(0);
  });

  test("REST: 422 INVALID_DOMAIN_NAME, the value not echoed", async () => {
    const res = await register("https://example.com");
    expect(res.status).toBe(422);
    expect(res.success).toBe(false);
    expect(res.code).toBe("INVALID_DOMAIN_NAME");
    expect(res.error).not.toContain("https://");
    expect(await db.select().from(domains)).toHaveLength(0);
  });

  test("REST: a final dot is dropped, then the same name is a 409", async () => {
    const created = await register("Example.COM.");
    expect(created.status).toBe(200);
    expect(created.data?.name).toBe("example.com");
    const again = await register("example.com");
    expect(again.status).toBe(409);
    expect(again.code).toBe("DOMAIN_ALREADY_REGISTERED");
  }, 30_000);

  test("dashboard: an invalid name is an error flash and nothing is stored", async () => {
    const res = await addOnDashboard("exa mple.com");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("flashType=error");
    expect(decodeURIComponent(location)).toContain("must be a host name");
    expect(await db.select().from(domains)).toHaveLength(0);
  });

  test("dashboard: a valid name is stored normalised", async () => {
    const res = await addOnDashboard("Mail.Example.org.");
    expect(res.headers.get("location")).not.toContain("flashType=error");
    const [row] = await db.select().from(domains);
    expect(row?.name).toBe("mail.example.org");
  }, 30_000);
});

describe("rows stored before #406", () => {
  test("are reported, not changed: a case difference alone is not", async () => {
    const dotted = await seed.domain({ name: "example.org." });
    const single = await seed.domain({ name: "localhost" });
    await seed.domain({ name: "Legacy.Example.com" });
    await seed.domain({ name: "example.com" });

    const reported = await findNonCanonicalDomainNames();
    expect(reported).toHaveLength(2);
    expect(reported).toContainEqual({
      id: dotted.id,
      name: "example.org.",
      normalized: "example.org",
    });
    expect(reported).toContainEqual({
      id: single.id,
      name: "localhost",
      normalized: null,
    });
    expect(await db.select().from(domains)).toHaveLength(4);
  });

  test("a dotted row is still found by the dotted name, as before", async () => {
    const { id } = await seed.domain({ name: "example.org." });
    expect((await getDomainByName("example.org."))?.id).toBe(id);
  });
});
