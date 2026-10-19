import { describe, test, expect } from "bun:test";
import {
  composeMessageBody,
  wrapHtmlDocument,
} from "../../src/modules/emails/services/message-body.ts";

/** Send-time body composition (#250): the document wrapper and the text alternative. */

const WRAP_HEAD =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>';

describe("wrapHtmlDocument", () => {
  test("a fragment is wrapped in a minimal document", () => {
    expect(wrapHtmlDocument("<p>Hi</p>")).toBe(`${WRAP_HEAD}<p>Hi</p></body></html>`);
  });

  test.each([
    "<html><body>Hi</body></html>",
    '<!doctype html><HTML lang="en"><body>Hi</body></HTML>',
    "<html\n><body>Hi</body></html>",
  ])("a document with <html> is left alone: %p", (html) => {
    expect(wrapHtmlDocument(html)).toBe(html);
  });

  test("<htmlfoo> or text mentioning html is not a document", () => {
    expect(wrapHtmlDocument("<htmlx>Hi")).toStartWith(WRAP_HEAD);
    expect(wrapHtmlDocument("about html files")).toStartWith(WRAP_HEAD);
  });
});

describe("composeMessageBody", () => {
  test("HTML only: wrapped, and a text part is derived from it", () => {
    expect(composeMessageBody("<p>Hello <b>you</b></p>", null)).toEqual({
      html: `${WRAP_HEAD}<p>Hello <b>you</b></p></body></html>`,
      text: "Hello you",
      wrapped: true,
      textDerived: true,
    });
  });

  test("whitespace-only text counts as none", () => {
    expect(composeMessageBody("<p>Hi</p>", "  \n").text).toBe("Hi");
  });

  test("the caller's text is kept as is", () => {
    const body = composeMessageBody("<html><p>Hi</p></html>", "  My own text  ");
    expect(body).toEqual({
      html: "<html><p>Hi</p></html>",
      text: "  My own text  ",
      wrapped: false,
      textDerived: false,
    });
  });

  test("text only: unchanged", () => {
    expect(composeMessageBody(null, "plain")).toEqual({
      html: null,
      text: "plain",
      wrapped: false,
      textDerived: false,
    });
  });

  test("HTML with no text in it: wrapped, no text part added", () => {
    const body = composeMessageBody('<img src="x">', null);
    expect(body.text).toBeNull();
    expect(body.textDerived).toBe(false);
    expect(body.wrapped).toBe(true);
  });

  test("empty HTML is passed through", () => {
    expect(composeMessageBody("  ", "t").html).toBe("  ");
  });
});
