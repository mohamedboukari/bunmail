/**
 * Sending IPs and forward-confirmed reverse DNS (#247, #248). Pure DNS
 * logic with injected resolvers (no database); in the integration tier
 * because it reads the real `config`, which unit tests stub.
 */
import { describe, test, expect } from "bun:test";
import {
  checkReverseDns,
  resolveSendingIps,
  type ReverseDnsDeps,
} from "../../src/modules/domains/services/sending-ips.service.ts";
import { config } from "../../src/config.ts";

const hostname = config.mail.hostname.toLowerCase();

/** A resolver set answering from tables; anything else is "no record". */
function dns(tables: {
  a?: Record<string, string[]>;
  aaaa?: Record<string, string[]>;
  ptr?: Record<string, string[]>;
}): ReverseDnsDeps {
  const from =
    (table: Record<string, string[]> | undefined) =>
    async (key: string): Promise<string[]> => {
      const hit = table?.[key];
      if (hit) return hit;
      throw Object.assign(new Error(`ENOTFOUND ${key}`), { code: "ENOTFOUND" });
    };
  return {
    resolve4: from(tables.a),
    resolve6: from(tables.aaaa),
    reverse: from(tables.ptr),
  };
}

describe("resolveSendingIps", () => {
  test("uses the A and AAAA records of MAIL_HOSTNAME when MAIL_PUBLIC_IP is unset", async () => {
    if (config.mail.publicIps.length > 0) return;
    const result = await resolveSendingIps(
      dns({
        a: { [hostname]: ["203.0.113.10"] },
        aaaa: { [hostname]: ["2001:db8::10"] },
      }),
    );
    expect(result).toEqual({
      ips: ["203.0.113.10", "2001:db8::10"],
      source: "MAIL_HOSTNAME",
    });
  });

  test("no records: an empty list, not an error", async () => {
    if (config.mail.publicIps.length > 0) return;
    expect((await resolveSendingIps(dns({}))).ips).toEqual([]);
  });
});

describe("checkReverseDns (#248)", () => {
  test("passes when the PTR names MAIL_HOSTNAME and it resolves back", async () => {
    if (config.mail.publicIps.length > 0) return;
    const { checks } = await checkReverseDns(
      dns({
        a: { [hostname]: ["203.0.113.10"] },
        ptr: { "203.0.113.10": [`${hostname}.`] },
      }),
    );
    expect(checks).toEqual([expect.objectContaining({ ip: "203.0.113.10", ok: true })]);
  });

  test("fails with the found name when the PTR names another host", async () => {
    if (config.mail.publicIps.length > 0) return;
    const { checks } = await checkReverseDns(
      dns({
        a: { [hostname]: ["203.0.113.10"] },
        ptr: { "203.0.113.10": ["vps-123.provider.example"] },
      }),
    );
    expect(checks[0]?.ok).toBe(false);
    expect(checks[0]?.reason).toContain("vps-123.provider.example");
  });

  test("fails when the PTR is missing", async () => {
    if (config.mail.publicIps.length > 0) return;
    const { checks } = await checkReverseDns(
      dns({ a: { [hostname]: ["203.0.113.10"] } }),
    );
    expect(checks[0]?.ok).toBe(false);
    expect(checks[0]?.reason).toContain("missing");
  });

  test("fails when the PTR names MAIL_HOSTNAME but it does not resolve back", async () => {
    if (config.mail.publicIps.length > 0) return;
    const deps = dns({
      a: { [hostname]: ["203.0.113.10"] },
      ptr: { "203.0.113.10": [hostname] },
    });
    /** The hostname now resolves elsewhere: the PTR alone proves nothing. */
    let calls = 0;
    const resolve4 = deps.resolve4;
    deps.resolve4 = async (name) => (++calls === 1 ? resolve4(name) : ["198.51.100.1"]);
    const { checks } = await checkReverseDns(deps);
    expect(checks[0]?.ok).toBe(false);
    expect(checks[0]?.reason).toContain("does not resolve back");
  });
});
