import { htmlToText } from "./html-to-text.ts";
import {
  applyBodyTracking,
  type BodyTracking,
} from "../../tracking/services/body-tracking.ts";

/**
 * The body parts of an outgoing message, composed at send time (#250)
 * from what the email row stores. Nothing here is written back: the row,
 * and so the API, keep exactly what the caller sent.
 *
 * - **Document wrapper:** HTML without an `<html>` element is a fragment;
 *   some clients and spam filters treat a fragment as a sign of careless
 *   or generated mail. It is wrapped in a minimal HTML5 document with a
 *   UTF-8 charset and a mobile viewport.
 * - **Text alternative:** HTML with no text part gets one derived from the
 *   HTML ({@link htmlToText}), so the message is `multipart/alternative`.
 *   HTML-only mail scores worse with spam filters and is unreadable in
 *   text-only clients. A caller's own text is always kept as is.
 * - **Tracking (#187):** with a `tracking` argument, the links are
 *   rewritten and the open pixel inserted, after the text alternative was
 *   derived from the original HTML, so the text part never carries a
 *   tracking URL. The caller passes it only for an email whose row says
 *   it is tracked while `TRACKING_ENABLED` is still on.
 *
 * Pure: no I/O, no logging.
 */

/** An `<html>` element, as a whole word: `<html>` or `<html lang="en">`, any case. */
const HTML_ELEMENT = /<html[\s>]/i;

/** What the wrapper puts around an HTML fragment. */
const DOCUMENT_HEAD =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>';
const DOCUMENT_TAIL = "</body></html>";

/** HTML wrapped in a minimal document when it has no `<html>` element; otherwise unchanged. */
export function wrapHtmlDocument(html: string): string {
  return HTML_ELEMENT.test(html) ? html : `${DOCUMENT_HEAD}${html}${DOCUMENT_TAIL}`;
}

/** The parts a message is sent with, and what composing them changed. */
export interface ComposedBody {
  html: string | null;
  text: string | null;
  /** The HTML was a fragment and got the document wrapper. */
  wrapped: boolean;
  /** The text part was derived from the HTML. */
  textDerived: boolean;
  /** What tracking changed (#187); absent when the message is not tracked. */
  tracked?: { links: number; pixel: boolean };
}

/**
 * The body a message is sent with: the HTML wrapped when it is a
 * fragment, and a text part derived from it when the email has none (or
 * only whitespace). Empty or whitespace-only HTML is passed through
 * unchanged, and so is text whenever the caller gave some. When the HTML
 * holds no text at all, no text part is added.
 */
export function composeMessageBody(
  html: string | null,
  text: string | null,
  tracking?: BodyTracking,
): ComposedBody {
  if (html === null || html.trim() === "") {
    return { html, text, wrapped: false, textDerived: false };
  }
  /** The text alternative comes from the original HTML, before any tracking. */
  const derived = text !== null && text.trim() !== "" ? null : htmlToText(html);
  const wrappedHtml = wrapHtmlDocument(html);
  const wrapped = wrappedHtml !== html;
  const parts =
    derived === null || derived === ""
      ? { text, textDerived: false }
      : { text: derived, textDerived: true };
  if (tracking === undefined) return { html: wrappedHtml, ...parts, wrapped };
  const tracked = applyBodyTracking(wrappedHtml, tracking);
  return {
    html: tracked.html,
    ...parts,
    wrapped,
    tracked: { links: tracked.links, pixel: tracked.pixel },
  };
}
