import { describe, test, expect } from "bun:test";
import {
  resolveDomainForEmail,
  type DomainLookupRow,
} from "../../src/modules/emails/services/queue.service.ts";

/**
 * Unit tests for the queue's domain resolver. Covers both the canonical
 * FK path (`email.domainId`) and the legacy fallback (sender-domain name)
 * documented in #32. Queries are injected so the test can assert which
 * lookup ran without standing up a database.
 */

const sampleRow: DomainLookupRow = {
  name: "example.com",
  dkimSelector: "bunmail",
  dkimPrivateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  unsubscribeEmail: null,
  unsubscribeUrl: null,
};

/**
 * Builds a `queries` pair whose calls are recorded so each test can
 * assert which path was taken (FK vs name fallback).
 */
function makeQueries(opts: {
  byIdResult?: DomainLookupRow;
  byNameResult?: DomainLookupRow;
}): {
  queries: Parameters<typeof resolveDomainForEmail>[1];
  calls: { byId: string[]; byName: string[] };
} {
  const calls = { byId: [] as string[], byName: [] as string[] };
  return {
    calls,
    queries: {
      byId: async (id) => {
        calls.byId.push(id);
        return opts.byIdResult;
      },
      byName: async (name) => {
        calls.byName.push(name);
        return opts.byNameResult;
      },
    },
  };
}

describe("resolveDomainForEmail — FK path", () => {
  test("looks up by domainId when set, never falls back to name", async () => {
    const { queries, calls } = makeQueries({ byIdResult: sampleRow });

    const result = await resolveDomainForEmail(
      { domainId: "dom_123", fromAddress: "hello@example.com" },
      queries,
    );

    expect(result).toBe(sampleRow);
    expect(calls.byId).toEqual(["dom_123"]);
    expect(calls.byName).toEqual([]);
  });

  test("returns undefined and does NOT fall back when byId misses", async () => {
    /**
     * `ON DELETE SET NULL` means a missing domainId becomes null on the
     * email row, not an orphan FK. So if byId returns undefined, the
     * domain genuinely no longer exists — falling back to a name lookup
     * would re-attach a different (potentially stale) domain row, which
     * is the bug the strict-FK path is meant to prevent.
     */
    const { queries, calls } = makeQueries({ byIdResult: undefined });

    const result = await resolveDomainForEmail(
      { domainId: "dom_deleted", fromAddress: "hello@example.com" },
      queries,
    );

    expect(result).toBeUndefined();
    expect(calls.byId).toEqual(["dom_deleted"]);
    expect(calls.byName).toEqual([]);
  });
});

describe("resolveDomainForEmail — legacy name fallback", () => {
  test("looks up by sender domain when domainId is null", async () => {
    const { queries, calls } = makeQueries({ byNameResult: sampleRow });

    const result = await resolveDomainForEmail(
      { domainId: null, fromAddress: "hello@example.com" },
      queries,
    );

    expect(result).toBe(sampleRow);
    expect(calls.byId).toEqual([]);
    expect(calls.byName).toEqual(["example.com"]);
  });

  test("returns undefined when fromAddress has no @ (malformed legacy row)", async () => {
    const { queries, calls } = makeQueries({});

    const result = await resolveDomainForEmail(
      { domainId: null, fromAddress: "not-an-email" },
      queries,
    );

    expect(result).toBeUndefined();
    expect(calls.byId).toEqual([]);
    expect(calls.byName).toEqual([]);
  });

  test("returns undefined when fallback name lookup misses", async () => {
    const { queries } = makeQueries({ byNameResult: undefined });

    const result = await resolveDomainForEmail(
      { domainId: null, fromAddress: "hello@unregistered.com" },
      queries,
    );

    expect(result).toBeUndefined();
  });
});
