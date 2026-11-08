/**
 * Shared helpers of the CSV export integration tests (#430): the app as
 * `src/index.ts` mounts the dashboard (with the request context, which
 * the role-aware Export link reads), a GET with a session cookie, and a
 * strict RFC 4180 reader that refuses anything the writer must never
 * produce (a bare LF record end, a stray quote).
 */
import { Elysia } from "elysia";
import { html } from "@elysiajs/html";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { withRequestContext } from "../../src/middleware/request-context.ts";

/** The dashboard, wrapped in the request context like in production. */
export const app = new Elysia().wrap(withRequestContext).use(html()).use(pagesPlugin);

/** A dashboard GET with an optional session cookie and extra headers. */
export function get(
  path: string,
  token: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (token) headers["cookie"] = `bm_session=${token}`;
  return app.handle(new Request(`http://localhost${path}`, { headers }));
}

/**
 * The body as text with its BOM kept: `Response.text()` decodes UTF-8 and
 * drops a leading BOM, which would hide whether the file carries one.
 */
export async function bodyText(response: Response): Promise<string> {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    await response.arrayBuffer(),
  );
}

/** A parsed export: the BOM seen, the header row and the data rows. */
export interface ParsedCsv {
  bom: boolean;
  header: string[];
  rows: string[][];
}

/**
 * Parses an RFC 4180 body: CRLF record ends (the last record included),
 * quoted fields with doubled quotes. Throws on a bare CR or LF outside
 * quotes, on a quote inside an unquoted field, and on a missing final CRLF.
 */
export function parseCsv(text: string): ParsedCsv {
  const bom = text.startsWith("﻿");
  const body = bom ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"' && field === "") {
      i += 1;
      for (;;) {
        if (i >= body.length) throw new Error("unterminated quoted field");
        if (body[i] === '"') {
          if (body[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        field += body[i];
        i += 1;
      }
      const next = body[i];
      if (next !== "," && next !== "\r")
        throw new Error(`junk after quoted field at ${i}`);
      continue;
    }
    if (ch === ",") {
      record.push(field);
      field = "";
      i += 1;
    } else if (ch === "\r") {
      if (body[i + 1] !== "\n") throw new Error(`bare CR at ${i}`);
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      i += 2;
    } else if (ch === "\n") {
      throw new Error(`bare LF at ${i}`);
    } else if (ch === '"') {
      throw new Error(`quote inside an unquoted field at ${i}`);
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field !== "" || record.length > 0) throw new Error("last record not ended by CRLF");
  const [header = [], ...rows] = records;
  return { bom, header, rows };
}

/** The rows of a parsed export as objects keyed by header. */
export function rowObjects(csv: ParsedCsv): Array<Record<string, string>> {
  return csv.rows.map((row) =>
    Object.fromEntries(csv.header.map((name, index) => [name, row[index] ?? ""])),
  );
}
