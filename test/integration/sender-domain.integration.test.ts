/**
 * Sender-domain gate of `createEmail` (#245) against a real Postgres:
 * typed rejections (`SENDER_DOMAIN_NOT_REGISTERED`, `SENDER_DOMAIN_UNVERIFIED`,
 * `SUBJECT_REQUIRED`) instead of masked 500s, the `warnings` array of
 * `POST /api/v1/emails/send`, and the opt-in `REQUIRE_VERIFIED_DOMAIN`
 * inline re-verification with its negative cache.
 *
 * The REST cases go through the real emails plugin and auth middleware;
 * the error mapping mirrors the `EmailSendRejectedError` branch of the
 * global `onError` in `src/index.ts`, which reads status and code from
 * the error class. DNS is never queried: the verifier is injected or
 * spied on.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { emailsPlugin } from "../../src/modules/emails/emails.plugin.ts";
import { createEmail } from "../../src/modules/emails/services/email.service.ts";
import {
  checkSenderDomain,
  UNVERIFIED_RECHECK_MS,
  type SenderDomainDeps,
} from "../../src/modules/emails/services/sender-domain.service.ts";
import {
  EmailSendRejectedError,
  SenderDomainNotRegisteredError,
  SenderDomainUnverifiedError,
} from "../../src/modules/emails/errors.ts";
import * as dnsVerification from "../../src/modules/domains/services/dns-verification.service.ts";
import type { VerificationResult } from "../../src/modules/domains/services/dns-verification.service.ts";
import type { Domain } from "../../src/modules/domains/types/domain.types.ts";
import type { SendWarning } from "../../src/modules/emails/types/email.types.ts";
import { config } from "../../src/config.ts";
import { truncateAll, seed, db, domains, emails } from "./_helpers.ts";
import { readJson } from "../read-json.ts";

/** Mutable views of the read-only config, restored after each test. */
const runtime = config as { env: "development" | "production" };
const mailFlags = config.mail as { requireVerifiedDomain: boolean };
const originalEnv = config.env;
const originalRequire = config.mail.requireVerifiedDomain;

/** Mirrors the `EmailSendRejectedError` branch of the global onError. */
const app = new Elysia()
  .onError(({ error, set }) => {
    if (error instanceof EmailSendRejectedError) {
      set.status = error.status;
      return { success: false, error: error.message, code: error.code };
    }
  })
  .use(emailsPlugin);

interface SendBody {
  success: boolean;
  data?: { id: string; status: string };
  warnings?: SendWarning[];
  error?: string;
  code?: string;
}

function send(key: string, from: string, extra: Record<string, unknown> = {}) {
  return app.handle(
    new Request("http://localhost/api/v1/emails/send", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: "user@example.org",
        subject: "s",
        text: "x",
        ...extra,
      }),
    }),
  );
}

/** Sets a seeded domain's stored verification flags. */
async function setFlags(
  domainId: string,
  flags: { spf: boolean; dkim: boolean; dmarc: boolean },
): Promise<void> {
  await db
    .update(domains)
    .set({ spfVerified: flags.spf, dkimVerified: flags.dkim, dmarcVerified: flags.dmarc })
    .where(eq(domains.id, domainId));
}

/** Injectable deps: a counting verifier, a settable clock, a private cache. */
function fakeDeps(result: VerificationResult): {
  deps: SenderDomainDeps;
  calls: Domain[];
  advance: (ms: number) => void;
} {
  const calls: Domain[] = [];
  let now = 1_000_000;
  const deps: SenderDomainDeps = {
    verify: (domain) => {
      calls.push(domain);
      return Promise.resolve(result);
    },
    now: () => now,
    cache: { unverifiedUntil: new Map(), inFlight: new Map() },
  };
  return {
    deps,
    calls,
    advance: (ms) => {
      now += ms;
    },
  };
}

const IDS = { id: "msg_test", apiKeyId: "key_test" };

/** Awaits a promise that must reject and returns what it rejected with. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  runtime.env = originalEnv;
  mailFlags.requireVerifiedDomain = originalRequire;
});

describe("unregistered sender domain", () => {
  test("production: 422 SENDER_DOMAIN_NOT_REGISTERED, nothing queued", async () => {
    runtime.env = "production";
    const { rawKey } = await seed.apiKey();

    const response = await send(rawKey, "hello@unregistered.test");

    expect(response.status).toBe(422);
    const body = await readJson<SendBody>(response);
    expect(body.code).toBe("SENDER_DOMAIN_NOT_REGISTERED");
    expect(body.error).toContain('"unregistered.test"');
    expect(await db.select().from(emails)).toHaveLength(0);
  });

  test("development: queued with a domain_unregistered warning", async () => {
    runtime.env = "development";
    const { rawKey } = await seed.apiKey();

    const response = await send(rawKey, "hello@unregistered.test");

    expect(response.status).toBe(200);
    const body = await readJson<SendBody>(response);
    expect(body.data?.status).toBe("queued");
    expect(body.warnings).toEqual(["domain_unregistered"]);
  });

  test("REQUIRE_VERIFIED_DOMAIN=true rejects it in development too", async () => {
    runtime.env = "development";
    mailFlags.requireVerifiedDomain = true;
    const { id: apiKeyId } = await seed.apiKey();

    const thrown = await rejectionOf(
      createEmail(
        { from: "hello@unregistered.test", to: "u@example.org", subject: "s", text: "x" },
        apiKeyId,
      ),
    );
    expect(thrown).toBeInstanceOf(SenderDomainNotRegisteredError);
  });
});

describe("warnings for a registered domain", () => {
  test.each<[string, { spf: boolean; dkim: boolean; dmarc: boolean }, SendWarning[]]>([
    [
      "nothing verified",
      { spf: false, dkim: false, dmarc: false },
      ["dkim_unverified", "spf_unverified", "dmarc_unverified"],
    ],
    ["DKIM only missing", { spf: true, dkim: false, dmarc: true }, ["dkim_unverified"]],
    ["SPF only missing", { spf: false, dkim: true, dmarc: true }, ["spf_unverified"]],
    ["DMARC only missing", { spf: true, dkim: true, dmarc: false }, ["dmarc_unverified"]],
    ["all verified", { spf: true, dkim: true, dmarc: true }, []],
  ])("%s", async (_label, flags, expected) => {
    runtime.env = "production";
    const { rawKey } = await seed.apiKey();
    const { id: domainId, name } = await seed.domain();
    await setFlags(domainId, flags);

    const response = await send(rawKey, `hello@${name}`);

    expect(response.status).toBe(200);
    const body = await readJson<SendBody>(response);
    expect(body.data?.status).toBe("queued");
    expect(body.warnings).toEqual(expected);
  });
});

describe("subject required", () => {
  test("a send with no subject is a 422 SUBJECT_REQUIRED, not a 500", async () => {
    const { rawKey } = await seed.apiKey();

    const response = await send(rawKey, "hello@unregistered.test", {
      subject: undefined,
    });

    expect(response.status).toBe(422);
    const body = await readJson<SendBody>(response);
    expect(body.code).toBe("SUBJECT_REQUIRED");
  });
});

describe("REQUIRE_VERIFIED_DOMAIN=true", () => {
  test("DKIM unverified: re-verified once, then rejected, and the failure is cached", async () => {
    mailFlags.requireVerifiedDomain = true;
    const { id: domainId, name } = await seed.domain();
    const { deps, calls, advance } = fakeDeps({ spf: true, dkim: false, dmarc: true });

    expect(await rejectionOf(checkSenderDomain(name, IDS, deps))).toBeInstanceOf(
      SenderDomainUnverifiedError,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe(domainId);

    /** Within the window: refused again with no second DNS check. */
    advance(UNVERIFIED_RECHECK_MS - 1);
    expect(await rejectionOf(checkSenderDomain(name, IDS, deps))).toBeInstanceOf(
      SenderDomainUnverifiedError,
    );
    expect(calls).toHaveLength(1);

    /** Window over: checked again. */
    advance(1);
    expect(await rejectionOf(checkSenderDomain(name, IDS, deps))).toBeInstanceOf(
      SenderDomainUnverifiedError,
    );
    expect(calls).toHaveLength(2);
  });

  test("concurrent sends share one re-verification", async () => {
    mailFlags.requireVerifiedDomain = true;
    const { name } = await seed.domain();
    const { deps, calls } = fakeDeps({ spf: false, dkim: false, dmarc: false });

    const results = await Promise.allSettled([
      checkSenderDomain(name, IDS, deps),
      checkSenderDomain(name, IDS, deps),
      checkSenderDomain(name, IDS, deps),
    ]);

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("re-verification passes: allowed, warnings from the fresh flags", async () => {
    mailFlags.requireVerifiedDomain = true;
    const { id: domainId, name } = await seed.domain();
    const { deps, calls } = fakeDeps({ spf: false, dkim: true, dmarc: true });

    const result = await checkSenderDomain(name, IDS, deps);

    expect(calls).toHaveLength(1);
    expect(result).toEqual({ domainId, warnings: ["spf_unverified"] });
  });

  test("a verifier that throws counts as unverified and is cached", async () => {
    mailFlags.requireVerifiedDomain = true;
    const { name } = await seed.domain();
    const { deps } = fakeDeps({ spf: true, dkim: true, dmarc: true });
    let attempts = 0;
    deps.verify = () => {
      attempts++;
      return Promise.reject(new Error("dns down"));
    };

    expect(await rejectionOf(checkSenderDomain(name, IDS, deps))).toBeInstanceOf(
      SenderDomainUnverifiedError,
    );
    expect(await rejectionOf(checkSenderDomain(name, IDS, deps))).toBeInstanceOf(
      SenderDomainUnverifiedError,
    );
    expect(attempts).toBe(1);
  });

  test("DKIM already verified: no DNS check, queued with empty warnings", async () => {
    mailFlags.requireVerifiedDomain = true;
    runtime.env = "production";
    const { rawKey } = await seed.apiKey();
    const { id: domainId, name } = await seed.domain();
    await setFlags(domainId, { spf: true, dkim: true, dmarc: true });
    const spy = spyOn(dnsVerification, "verifyDomain");

    try {
      const response = await send(rawKey, `hello@${name}`);

      expect(response.status).toBe(200);
      const body = await readJson<SendBody>(response);
      expect(body.data?.status).toBe("queued");
      expect(body.warnings).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("over REST: 422 SENDER_DOMAIN_UNVERIFIED after one DNS check, then cached", async () => {
    mailFlags.requireVerifiedDomain = true;
    const { rawKey } = await seed.apiKey();
    const { name } = await seed.domain();
    const spy = spyOn(dnsVerification, "verifyDomain").mockResolvedValue({
      spf: true,
      dkim: false,
      dmarc: true,
    });

    try {
      const first = await send(rawKey, `hello@${name}`);
      expect(first.status).toBe(422);
      const body = await readJson<SendBody>(first);
      expect(body.code).toBe("SENDER_DOMAIN_UNVERIFIED");
      expect(body.error).toContain(`"${name}"`);
      expect(body.error).toContain("DKIM");

      const second = await send(rawKey, `hello@${name}`);
      expect(second.status).toBe(422);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await db.select().from(emails)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("off (the default): DKIM unverified is queued with warnings, no DNS check", async () => {
    runtime.env = "production";
    const { rawKey } = await seed.apiKey();
    const { name } = await seed.domain();
    const spy = spyOn(dnsVerification, "verifyDomain");

    try {
      const response = await send(rawKey, `hello@${name}`);

      expect(response.status).toBe(200);
      const body = await readJson<SendBody>(response);
      expect(body.warnings).toContain("dkim_unverified");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
