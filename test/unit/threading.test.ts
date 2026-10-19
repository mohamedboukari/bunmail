/**
 * Threading identifiers (#192): msg-id extraction and validation from
 * hostile header values, and the `In-Reply-To` / `References` of a reply
 * (append, cap, 998-character trimming, In-Reply-To fallback).
 */
import { describe, test, expect } from "bun:test";
import {
  MAX_MESSAGE_ID_LENGTH,
  MAX_THREAD_IDS,
  buildReplyHeaders,
  capThreadIds,
  extractMessageIds,
  fitThreadIds,
  isValidMessageId,
  replyCandidates,
  threadingIdsFromHeaderLines,
} from "../../src/modules/inbound/services/threading.ts";
import { filterCustomHeaders } from "../../src/modules/emails/services/custom-headers.ts";

/** A valid id of exactly `length` characters, brackets included. */
function idOfLength(length: number, tag = "a"): string {
  const right = "@example.com>";
  return `<${tag}${"a".repeat(length - 1 - tag.length - right.length)}${right}`;
}

/** `n` distinct valid ids, `<m1@example.com>` ... */
function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `<m${i + 1}@example.com>`);
}

describe("isValidMessageId", () => {
  test("accepts common real-world shapes", () => {
    for (const id of [
      "<CAB1234+xyz=abc@mail.gmail.com>",
      "<DM6PR12MB1234.namprd12.prod.outlook.com@DM6PR12MB1234.namprd12.prod.outlook.com>",
      "<5F0E7C2B-1A2B-4C3D-9E8F-0123456789AB@example.com>",
      "<a1b2@[192.0.2.1]>",
    ]) {
      expect(isValidMessageId(id)).toBe(true);
    }
  });

  test("refuses ids without brackets, without @, with spaces, controls or non-ASCII", () => {
    for (const id of [
      "abc@example.com",
      "<abc>",
      "<@example.com>",
      "<abc@>",
      "<a b@example.com>",
      "<a@b@example.com>",
      "<abc@example.com>\r\nBcc: victim@example.org",
      "<abc\r\n@example.com>",
      "<abc\u0000@example.com>",
      "<abc @example.com>",
      "<abé@example.com>",
      '<"quoted"@example.com>',
      "<<abc@example.com>",
    ]) {
      expect(isValidMessageId(id)).toBe(false);
    }
  });

  test("caps the length at 250 characters, brackets included", () => {
    expect(isValidMessageId(idOfLength(MAX_MESSAGE_ID_LENGTH))).toBe(true);
    expect(isValidMessageId(idOfLength(MAX_MESSAGE_ID_LENGTH + 1))).toBe(false);
  });
});

describe("extractMessageIds", () => {
  test("reads every id in order and unfolds folded lines", () => {
    expect(extractMessageIds(" <a@x.com>\r\n\t<b@x.com>\n <c@x.com> ")).toEqual([
      "<a@x.com>",
      "<b@x.com>",
      "<c@x.com>",
    ]);
  });

  test("skips comments, nested comments and escaped parentheses", () => {
    expect(
      extractMessageIds(
        "(root <fake@x.com>) <a@x.com> (nested (x <no@x.com>) \\) <no2@x.com>) <b@x.com>",
      ),
    ).toEqual(["<a@x.com>", "<b@x.com>"]);
  });

  test("drops junk and keeps the valid ids around it", () => {
    expect(
      extractMessageIds("garbage <bad id@x.com> <a@x.com> <<b@x.com> <unclosed@x.com"),
    ).toEqual(["<a@x.com>", "<b@x.com>"]);
  });

  test("a line break not followed by whitespace never ends up inside an id", () => {
    const value = "<a@x.com>\r\nBcc: victim@example.org <b@x\r\n.com> <c@x.com>";
    const out = extractMessageIds(value);
    expect(out).toEqual(["<a@x.com>", "<c@x.com>"]);
    for (const id of out) expect(id).not.toMatch(/[\r\n]/);
  });

  test("deduplicates, first occurrence wins", () => {
    expect(extractMessageIds("<a@x.com> <b@x.com> <a@x.com>")).toEqual([
      "<a@x.com>",
      "<b@x.com>",
    ]);
  });

  test("drops overlong ids and keeps reading after them", () => {
    const long = idOfLength(MAX_MESSAGE_ID_LENGTH + 50);
    expect(extractMessageIds(`${long} <a@x.com>`)).toEqual(["<a@x.com>"]);
  });

  test("runs in linear time on a hostile value", () => {
    const hostile = "<".repeat(200_000) + "(".repeat(200_000);
    const started = performance.now();
    expect(extractMessageIds(hostile)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("capThreadIds / fitThreadIds", () => {
  test("cap keeps the first id and the newest ones", () => {
    const chain = ids(25);
    const capped = capThreadIds(chain);
    expect(capped).toHaveLength(MAX_THREAD_IDS);
    expect(capped[0]).toBe("<m1@example.com>");
    expect(capped.slice(1)).toEqual(chain.slice(-(MAX_THREAD_IDS - 1)));
  });

  test("fit drops the oldest ids after the first, keeping order, under 998 characters", () => {
    const chain = Array.from({ length: 6 }, (_, i) => idOfLength(200, String(i)));
    const fitted = fitThreadIds(chain);
    expect(fitted.join(" ").length).toBeLessThanOrEqual(998);
    expect(fitted[0]).toBe(chain[0]);
    expect(fitted).toEqual([chain[0]!, ...chain.slice(-3)]);
  });

  test("fit leaves a chain that already fits alone", () => {
    expect(fitThreadIds(ids(5))).toEqual(ids(5));
  });
});

describe("threadingIdsFromHeaderLines", () => {
  test("reads the first Message-ID, In-Reply-To and References, folded or not", () => {
    const result = threadingIdsFromHeaderLines([
      { key: "message-id", line: "Message-ID: <self@x.com>" },
      { key: "message-id", line: "Message-ID: <second@x.com>" },
      { key: "in-reply-to", line: "In-Reply-To: <p@x.com> (the parent)" },
      { key: "references", line: "References: <r1@x.com>\r\n <r2@x.com>\r\n\t<p@x.com>" },
      { key: "subject", line: "Subject: <not@an.id>" },
    ]);
    expect(result).toEqual({
      messageId: "<self@x.com>",
      inReplyTo: ["<p@x.com>"],
      references: ["<r1@x.com>", "<r2@x.com>", "<p@x.com>"],
    });
  });

  test("a message without valid ids yields nothing", () => {
    expect(
      threadingIdsFromHeaderLines([
        { key: "message-id", line: "Message-ID: no-brackets@x.com" },
        { key: "references", line: "References: junk" },
      ]),
    ).toEqual({ messageId: null, inReplyTo: [], references: [] });
  });

  test("caps a long stored References chain to 20, keeping the root", () => {
    const chain = ids(30);
    const { references } = threadingIdsFromHeaderLines([
      { key: "references", line: `References: ${chain.join(" ")}` },
    ]);
    expect(references).toHaveLength(MAX_THREAD_IDS);
    expect(references[0]).toBe(chain[0]);
    expect(references.at(-1)).toBe(chain.at(-1));
  });
});

describe("buildReplyHeaders", () => {
  test("appends the parent's Message-ID to its References chain", () => {
    expect(
      buildReplyHeaders({
        messageId: "<p@x.com>",
        inReplyTo: "<r2@x.com>",
        references: "<r1@x.com> <r2@x.com>",
      }),
    ).toEqual({
      "In-Reply-To": "<p@x.com>",
      References: "<r1@x.com> <r2@x.com> <p@x.com>",
    });
  });

  test("without References, a single In-Reply-To id starts the chain", () => {
    expect(
      buildReplyHeaders({
        messageId: "<p@x.com>",
        inReplyTo: "<r@x.com>",
        references: null,
      }),
    ).toEqual({ "In-Reply-To": "<p@x.com>", References: "<r@x.com> <p@x.com>" });
  });

  test("an In-Reply-To with several ids is not used as the chain", () => {
    expect(
      buildReplyHeaders({
        messageId: "<p@x.com>",
        inReplyTo: "<a@x.com> <b@x.com>",
        references: null,
      }),
    ).toEqual({ "In-Reply-To": "<p@x.com>", References: "<p@x.com>" });
  });

  test("a first message in a thread gets its own id as the chain", () => {
    expect(
      buildReplyHeaders({ messageId: "<p@x.com>", inReplyTo: null, references: null }),
    ).toEqual({ "In-Reply-To": "<p@x.com>", References: "<p@x.com>" });
  });

  test("the parent's id already in its chain moves to the end once", () => {
    expect(
      buildReplyHeaders({
        messageId: "<p@x.com>",
        inReplyTo: null,
        references: "<r@x.com> <p@x.com> <s@x.com>",
      }),
    ).toEqual({
      "In-Reply-To": "<p@x.com>",
      References: "<r@x.com> <s@x.com> <p@x.com>",
    });
  });

  test("no valid Message-ID means no threading headers", () => {
    expect(
      buildReplyHeaders({
        messageId: null,
        inReplyTo: "<a@x.com>",
        references: "<a@x.com>",
      }),
    ).toBeNull();
    expect(
      buildReplyHeaders({ messageId: "junk", inReplyTo: null, references: null }),
    ).toBeNull();
  });

  test("hostile stored values are parsed again: only valid ids reach the headers", () => {
    const headers = buildReplyHeaders({
      messageId: "<p@x.com>\r\nBcc: victim@example.org",
      inReplyTo: null,
      references: "<r@x.com>\r\nX-Evil: 1 <bad id@x.com>",
    });
    expect(headers).toEqual({
      "In-Reply-To": "<p@x.com>",
      References: "<r@x.com> <p@x.com>",
    });
    const { dropped } = filterCustomHeaders(Object.entries(headers!));
    expect(dropped).toEqual([]);
  });

  test("a long chain is capped to 20 ids and 998 characters, root and parent kept", () => {
    const chain = Array.from({ length: 30 }, (_, i) => idOfLength(120, `r${i}`));
    const parent = idOfLength(120, "p");
    const headers = buildReplyHeaders({
      messageId: parent,
      inReplyTo: null,
      references: chain.join(" "),
    })!;
    const out = headers.References.split(" ");
    expect(headers.References.length).toBeLessThanOrEqual(998);
    expect(out[0]).toBe(chain[0]);
    expect(out.at(-1)).toBe(parent);
    /** Order kept: the survivors are the newest ids, in their original order. */
    const kept = out.slice(1, -1);
    expect(kept).toEqual(chain.slice(chain.length - kept.length));
    expect(filterCustomHeaders(Object.entries(headers)).dropped).toEqual([]);
  });
});

describe("replyCandidates", () => {
  test("In-Reply-To first, then References newest to oldest, deduplicated", () => {
    expect(
      replyCandidates({
        messageId: "<self@x.com>",
        inReplyTo: ["<p@x.com>"],
        references: ["<r1@x.com>", "<r2@x.com>", "<p@x.com>"],
      }),
    ).toEqual(["<p@x.com>", "<r2@x.com>", "<r1@x.com>"]);
  });
});
