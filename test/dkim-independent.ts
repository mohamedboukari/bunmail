/**
 * A DKIM verifier written from RFC 6376 and RFC 8463 alone, for the tests
 * of BunMail's signer (#345). It shares no code with the signer or with the
 * built-in verifier (`dkim-verifier*.service.ts`, whose canonicalization the
 * signer reuses), so a mistake common to both cannot hide behind it.
 *
 * Relaxed/relaxed only, the key passed in, one result per DKIM-Signature.
 */

import { createHash, verify, type KeyObject } from "crypto";

/** A header field as it appears, folding CRLFs and its final CRLF included. */
function headerFields(header: string): string[] {
  const fields: string[] = [];
  for (const line of header.split(/(?<=\r\n)/)) {
    if (line === "") continue;
    const last = fields.length - 1;
    if ((line.startsWith(" ") || line.startsWith("\t")) && last >= 0) {
      fields[last] += line;
    } else {
      fields.push(line);
    }
  }
  return fields;
}

/** The lowercase name of a field. */
function nameOf(field: string): string {
  return field.slice(0, field.indexOf(":")).trim().toLowerCase();
}

/** RFC 6376 section 3.4.2, written out again. */
function relaxField(field: string): string {
  const colon = field.indexOf(":");
  const name = field
    .slice(0, colon)
    .toLowerCase()
    .replace(/[ \t]+$/, "");
  const value = field
    .slice(colon + 1)
    .replace(/\r\n$/, "")
    .replace(/\r\n/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return `${name}:${value}`;
}

/** RFC 6376 section 3.4.4, written out again. */
function relaxBody(body: string): string {
  const lines = body
    .split("\r\n")
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/ $/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length === 0 ? "" : `${lines.join("\r\n")}\r\n`;
}

/**
 * Verifies every DKIM-Signature of a message (CRLF line ends) with `key`:
 * `pass`, `fail: body hash` or `fail: signature`.
 */
export function independentVerify(message: Buffer, key: KeyObject): string[] {
  const text = message.toString("latin1");
  const end = text.indexOf("\r\n\r\n");
  const fields = headerFields(text.slice(0, end + 2));
  const body = text.slice(end + 4);
  return fields
    .filter((field) => nameOf(field) === "dkim-signature")
    .map((signatureField) => {
      const tags = new Map<string, string>();
      for (const part of signatureField
        .slice(signatureField.indexOf(":") + 1)
        .split(";")) {
        const eq = part.indexOf("=");
        if (eq > 0)
          tags.set(part.slice(0, eq).trim(), part.slice(eq + 1).replace(/\s+/g, ""));
      }
      const bodyHash = createHash("sha256")
        .update(Buffer.from(relaxBody(body), "latin1"))
        .digest("base64");
      if (bodyHash !== tags.get("bh")) return "fail: body hash";

      /** Bottom-up selection: each listed name takes the lowest instance not taken yet. */
      const taken = new Set<number>();
      let data = "";
      for (const name of (tags.get("h") ?? "").toLowerCase().split(":")) {
        for (let i = fields.length - 1; i >= 0; i -= 1) {
          const field = fields[i] ?? "";
          if (!taken.has(i) && nameOf(field) === name) {
            taken.add(i);
            data += `${relaxField(field)}\r\n`;
            break;
          }
        }
      }
      data += relaxField(signatureField.replace(/(;[ \t\r\n]*b=)[^;]*/, "$1"));
      const signed = Buffer.from(data, "latin1");
      const signature = Buffer.from(tags.get("b") ?? "", "base64");
      const ok =
        tags.get("a") === "ed25519-sha256"
          ? verify(null, createHash("sha256").update(signed).digest(), key, signature)
          : verify("sha256", signed, key, signature);
      return ok ? "pass" : "fail: signature";
    });
}
