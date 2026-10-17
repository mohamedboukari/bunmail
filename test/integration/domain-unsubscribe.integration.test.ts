/**
 * Domain `List-Unsubscribe` overrides over the real API (#243): they were
 * validated on create but never stored, and could not be edited.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { domainsPlugin } from "../../src/modules/domains/domains.plugin.ts";
import { truncateAll, seed } from "./_helpers.ts";
import { readJson } from "../read-json.ts";

interface DomainBody {
  data?: { id: string; unsubscribeEmail: string | null; unsubscribeUrl: string | null };
}

let key = "";

function call(method: string, path: string, body?: unknown): Promise<Response> {
  return domainsPlugin.handle(
    new Request(`http://localhost/api/v1/domains${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

beforeEach(async () => {
  await truncateAll();
  key = (await seed.apiKey({ isAdmin: true })).rawKey;
});

describe("domain unsubscribe settings", () => {
  test("create stores the unsubscribe mailbox and URL", async () => {
    const res = await call("POST", "", {
      name: "acme.io",
      unsubscribeEmail: "leave@acme.io",
      unsubscribeUrl: "https://acme.io/u",
    });
    expect(res.status).toBe(200);
    const { data } = await readJson<DomainBody>(res);
    expect(data?.unsubscribeEmail).toBe("leave@acme.io");
    expect(data?.unsubscribeUrl).toBe("https://acme.io/u");
  });

  test("a non-https unsubscribe URL is rejected", async () => {
    const res = await call("POST", "", {
      name: "acme.io",
      unsubscribeUrl: "http://acme.io/u",
    });
    expect(res.status).toBe(422);
  });

  test("PATCH sets, keeps and clears fields", async () => {
    const created = await readJson<DomainBody>(
      await call("POST", "", { name: "acme.io" }),
    );
    const id = created.data!.id;

    let { data } = await readJson<DomainBody>(
      await call("PATCH", `/${id}`, {
        unsubscribeEmail: "leave@acme.io",
        unsubscribeUrl: "https://acme.io/u",
      }),
    );
    expect(data?.unsubscribeEmail).toBe("leave@acme.io");

    /** Omitted field stays; null clears. */
    ({ data } = await readJson<DomainBody>(
      await call("PATCH", `/${id}`, { unsubscribeUrl: null }),
    ));
    expect(data?.unsubscribeEmail).toBe("leave@acme.io");
    expect(data?.unsubscribeUrl).toBeNull();
  });

  test("PATCH on an unknown domain is 404", async () => {
    expect((await call("PATCH", "/dom_missing", { unsubscribeUrl: null })).status).toBe(
      404,
    );
  });
});
