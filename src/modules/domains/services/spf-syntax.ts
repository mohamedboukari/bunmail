import { macroIp, parseIp, type IpAddress } from "./spf-address.ts";

/**
 * SPF record syntax and macros (#373), RFC 7208 4.6.1, 5, 6 and 7, strict:
 * the whole record is parsed before anything is evaluated, and any syntax
 * error anywhere in it is a `permerror` (RFC 7208 4.6).
 */

/** An evaluation that ends in an error result, and why. */
export class SpfError extends Error {
  constructor(
    readonly result: "permerror" | "temperror",
    message: string,
  ) {
    super(message);
    this.name = "SpfError";
  }
}

/** A syntax error or a broken limit. */
function permerror(message: string): SpfError {
  return new SpfError("permerror", message);
}

/** Macro letters (RFC 7208 7.2); `c`, `r` and `t` only in explanation text. */
type MacroLetter = "s" | "l" | "o" | "d" | "i" | "p" | "h" | "v" | "c" | "r" | "t";

const DOMAIN_SPEC_LETTERS: ReadonlySet<string> = new Set("slodiphv");
const EXP_ONLY_LETTERS: ReadonlySet<string> = new Set("crt");

/** One piece of a macro-string. */
export type MacroToken =
  /** Literal text, copied as is. */
  | { kind: "literal"; text: string }
  /** `%%`, `%_` or `%-`: a macro-expand that stands for fixed text. */
  | { kind: "escape"; text: string }
  /** `%{...}`: a macro letter with its transformers and delimiters. */
  | {
      kind: "macro";
      letter: MacroLetter;
      /** An uppercase letter: URL-escape the value (RFC 7208 7.3). */
      urlEscape: boolean;
      /** Keep this many right-hand parts; `null` keeps them all. */
      parts: number | null;
      reverse: boolean;
      /** The split characters; empty means `.`. */
      delimiters: string;
    };

/** `macro-letter transformers *delimiter` inside `%{...}` (RFC 7208 7.1). */
const MACRO_BODY = /^([a-z])([0-9]*)(r?)([.\-+,/_=]*)$/i;

const ESCAPES: Readonly<Record<string, string>> = { "%": "%", _: " ", "-": "%20" };

/** Narrows a lowercase letter to a macro letter. */
function isMacroLetter(letter: string): letter is MacroLetter {
  return DOMAIN_SPEC_LETTERS.has(letter) || EXP_ONLY_LETTERS.has(letter);
}

/**
 * Parses a macro-string (RFC 7208 7.1). A `%` not followed by `{`, `%`,
 * `_` or `-`, an unknown letter, a zero digit transformer, or a character
 * outside `%x21-7E` is a `permerror`. `c`, `r` and `t` are refused unless
 * `allowExpLetters` (the value of an unknown modifier, which is never
 * expanded).
 */
function parseMacroString(input: string, allowExpLetters: boolean): MacroToken[] {
  const tokens: MacroToken[] = [];
  let literal = "";
  const flush = (): void => {
    if (literal) tokens.push({ kind: "literal", text: literal });
    literal = "";
  };

  for (let pos = 0; pos < input.length; pos++) {
    const char = input.charAt(pos);
    if (char !== "%") {
      const code = input.charCodeAt(pos);
      if (code < 0x21 || code > 0x7e) {
        throw permerror("a macro-string may only hold visible US-ASCII characters");
      }
      literal += char;
      continue;
    }

    const next = input.charAt(pos + 1);
    const escape = ESCAPES[next];
    if (escape !== undefined) {
      flush();
      tokens.push({ kind: "escape", text: escape });
      pos++;
      continue;
    }
    if (next !== "{") throw permerror("'%' must be followed by '{', '%', '_' or '-'");
    const end = input.indexOf("}", pos + 2);
    if (end < 0) throw permerror("unterminated macro");
    const body = input.slice(pos + 2, end);
    const match = MACRO_BODY.exec(body);
    const letter = match?.[1]?.toLowerCase() ?? "";
    if (!match || !isMacroLetter(letter)) throw permerror(`invalid macro %{${body}}`);
    if (EXP_ONLY_LETTERS.has(letter) && !allowExpLetters) {
      throw permerror(`macro %{${body}} is only allowed in explanation text`);
    }
    const digits = match[2] ?? "";
    if (digits && Number(digits) === 0) {
      throw permerror(`macro %{${body}}: the number of parts must be nonzero`);
    }
    flush();
    tokens.push({
      kind: "macro",
      letter,
      urlEscape: match[1] !== letter,
      parts: digits ? Number(digits) : null,
      reverse: match[3] !== "",
      delimiters: match[4] ?? "",
    });
    pos = end;
  }
  flush();
  return tokens;
}

/**
 * `toplabel = ( *alphanum ALPHA *alphanum ) / ( 1*alphanum "-" *( alphanum
 * / "-" ) alphanum )` (RFC 7208 7.1): not all digits, no leading or
 * trailing dash.
 */
const TOPLABEL = /^(?:[a-z0-9]*[a-z][a-z0-9]*|[a-z0-9]+-[a-z0-9-]*[a-z0-9])$/i;

/**
 * Parses a domain-spec: `macro-string domain-end`, where domain-end is
 * `"." toplabel [ "." ]` or a macro-expand (RFC 7208 7.1). Empty is a
 * `permerror`.
 */
export function parseDomainSpec(input: string): MacroToken[] {
  const tokens = parseMacroString(input, false);
  const last = tokens.at(-1);
  if (!last) throw permerror("empty domain-spec");
  if (last.kind !== "literal") return tokens;
  const text = last.text.endsWith(".") ? last.text.slice(0, -1) : last.text;
  const dot = text.lastIndexOf(".");
  if (dot < 0 || !TOPLABEL.test(text.slice(dot + 1))) {
    throw permerror(`invalid domain-spec ${input}`);
  }
  return tokens;
}

/** The values macros expand to (RFC 7208 7.3). */
export interface MacroValues {
  /** `<sender>`, with `postmaster` for a missing local-part. */
  sender: string;
  localPart: string;
  senderDomain: string;
  /** The current `<domain>`: changes with include and redirect. */
  domain: string;
  ip: IpAddress;
  helo: string;
  /** The validated name of the IP for `%{p}`; `unknown` when absent. */
  ptrName?: string;
}

/** URL-escapes everything outside RFC 3986 `unreserved`, byte by byte. */
function urlEscape(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte);
    out += /^[A-Za-z0-9\-._~]$/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** Splits `value` on any of `delimiters` (default `.`). */
function splitParts(value: string, delimiters: string): string[] {
  const split = delimiters || ".";
  const parts: string[] = [];
  let current = "";
  for (const char of value) {
    if (split.includes(char)) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/** The raw value of a macro letter. */
function letterValue(letter: MacroLetter, values: MacroValues): string {
  switch (letter) {
    case "s":
      return values.sender;
    case "l":
      return values.localPart;
    case "o":
      return values.senderDomain;
    case "d":
      return values.domain;
    case "i":
      return macroIp(values.ip);
    case "p":
      return values.ptrName ?? "unknown";
    case "h":
      return values.helo;
    case "v":
      return values.ip.family === 4 ? "in-addr" : "ip6";
    default:
      /** `c`, `r`, `t`: parsing keeps them out of every expanded domain-spec. */
      throw permerror(`macro letter ${letter} is only allowed in explanation text`);
  }
}

/**
 * Expands macro tokens (RFC 7208 7.3): split on the delimiters, reverse
 * with `r`, keep the right-hand parts the digit asks for, join with dots,
 * then URL-escape for an uppercase letter.
 */
export function expandMacros(tokens: MacroToken[], values: MacroValues): string {
  return tokens
    .map((token) => {
      if (token.kind !== "macro") return token.text;
      const value = letterValue(token.letter, values);
      let result = value;
      if (token.reverse || token.parts !== null || token.delimiters) {
        let parts = splitParts(value, token.delimiters);
        if (token.reverse) parts = parts.toReversed();
        if (token.parts !== null && token.parts < parts.length) {
          parts = parts.slice(-token.parts);
        }
        result = parts.join(".");
      }
      return token.urlEscape ? urlEscape(result) : result;
    })
    .join("");
}

/** Longest domain name a query may use (RFC 7208 7.3). */
const MAX_NAME_LENGTH = 253;

/**
 * Whether `name` (no trailing dot) can be queried: at most 253 characters,
 * at least two labels of 1 to 63 visible characters or spaces each, and a
 * top label that follows `toplabel`. A name that fails is malformed
 * (RFC 7208 4.3).
 */
export function isValidDomainName(name: string): boolean {
  if (!name || name.length > MAX_NAME_LENGTH) return false;
  const labels = name.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => label.length > 0 && label.length <= 63)) return false;
  if (!labels.every((label) => /^[\x20-\x2d\x2f-\x7e]+$/.test(label))) return false;
  return TOPLABEL.test(labels.at(-1) ?? "");
}

/**
 * The name an expanded domain-spec queries: one trailing dot dropped,
 * then labels removed from the left until it fits in 253 characters
 * (RFC 7208 7.3). `null` when the result is not a valid domain name.
 */
export function targetName(expanded: string): string | null {
  let name = expanded.endsWith(".") ? expanded.slice(0, -1) : expanded;
  while (name.length > MAX_NAME_LENGTH && name.includes(".")) {
    name = name.slice(name.indexOf(".") + 1);
  }
  return isValidDomainName(name) ? name : null;
}

/** A directive's qualifier (RFC 7208 4.6.2); none is `+`. */
export type Qualifier = "+" | "-" | "~" | "?";

/** One mechanism of a parsed record, with its source term for messages. */
export type SpfMechanism = { qualifier: Qualifier; term: string } & (
  | { kind: "all" }
  | { kind: "include" | "exists"; domainSpec: MacroToken[] }
  | {
      kind: "a" | "mx";
      /** `null`: the current domain. */
      domainSpec: MacroToken[] | null;
      cidr4: number;
      cidr6: number;
    }
  | { kind: "ptr"; domainSpec: MacroToken[] | null }
  | { kind: "ip4" | "ip6"; network: IpAddress; prefix: number }
);

/** A parsed record: the mechanisms in order and the redirect target, if any. */
export interface SpfRecord {
  mechanisms: SpfMechanism[];
  redirect: MacroToken[] | null;
}

/** An SPF record starts with `v=spf1`, then a space or the end (RFC 7208 4.5). */
const SPF_VERSION = /^v=spf1( |$)/i;

/** Whether a TXT record (its strings joined) is an SPF record. */
export function isSpfRecord(text: string): boolean {
  return SPF_VERSION.test(text);
}

/** `name "=" ...`: a modifier, whose name starts with a letter (RFC 7208 4.6.1). */
const MODIFIER = /^([a-z][a-z0-9._-]*)=(.*)$/i;

/** `[qualifier] name rest`, the name ending at the first `:` or `/`. */
const DIRECTIVE = /^([+\-~?]?)([^:/]*)(.*)$/;

/** `[ ":" domain-spec ] [ ip4-cidr-length ] [ "/" ip6-cidr-length ]` of `a` and `mx`. */
const DUAL_CIDR_TERM = /^(?::(.*?))?(?:\/([0-9]+))?(?:\/\/([0-9]+))?$/;

/** `":" network [ "/" length ]` of `ip4` and `ip6`. */
const IP_TERM = /^:([^/]*)(?:\/(.*))?$/;

/** `qnum "." qnum "." qnum "." qnum`, no leading zeros (RFC 7208 5.6). */
const QNUM = "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])";
const IP4_NETWORK = new RegExp(`^${QNUM}(?:\\.${QNUM}){3}$`);

/**
 * A CIDR length, `max` when absent. No leading zeros and at most `max`
 * (RFC 7208 5.6), else a `permerror`.
 */
function cidrLength(text: string | undefined, max: number): number {
  if (text === undefined) return max;
  if (!/^(?:0|[1-9][0-9]*)$/.test(text) || Number(text) > max) {
    throw permerror(`invalid CIDR length /${text}`);
  }
  return Number(text);
}

/** Narrows a qualifier character. */
function qualifierOf(text: string): Qualifier {
  return text === "-" || text === "~" || text === "?" ? text : "+";
}

/** Parses one directive (RFC 7208 4.6.1 and 5). */
function parseMechanism(term: string): SpfMechanism {
  const match = DIRECTIVE.exec(term);
  const qualifier = qualifierOf(match?.[1] ?? "");
  const name = (match?.[2] ?? "").toLowerCase();
  const rest = match?.[3] ?? "";
  const base = { qualifier, term };

  switch (name) {
    case "all":
      if (rest) throw permerror(`invalid term ${term}`);
      return { ...base, kind: "all" };

    case "include":
    case "exists":
      if (!rest.startsWith(":")) throw permerror(`${name} needs a domain-spec: ${term}`);
      return { ...base, kind: name, domainSpec: parseDomainSpec(rest.slice(1)) };

    case "a":
    case "mx": {
      const parts = DUAL_CIDR_TERM.exec(rest);
      if (!parts) throw permerror(`invalid term ${term}`);
      return {
        ...base,
        kind: name,
        domainSpec: parts[1] === undefined ? null : parseDomainSpec(parts[1]),
        cidr4: cidrLength(parts[2], 32),
        cidr6: cidrLength(parts[3], 128),
      };
    }

    case "ptr":
      if (!rest) return { ...base, kind: "ptr", domainSpec: null };
      if (!rest.startsWith(":")) throw permerror(`invalid term ${term}`);
      return { ...base, kind: "ptr", domainSpec: parseDomainSpec(rest.slice(1)) };

    case "ip4":
    case "ip6": {
      const parts = IP_TERM.exec(rest);
      const text = parts?.[1] ?? "";
      const network = parseIp(text);
      const valid =
        name === "ip4"
          ? IP4_NETWORK.test(text) && network?.family === 4
          : network?.family === 6;
      if (!parts || !network || !valid) throw permerror(`invalid network in ${term}`);
      return {
        ...base,
        kind: name,
        network,
        prefix: cidrLength(parts[2], name === "ip4" ? 32 : 128),
      };
    }

    default:
      throw permerror(`unknown mechanism in ${term}`);
  }
}

/**
 * Parses a selected SPF record (strict, RFC 7208 4.6): terms are separated
 * by spaces only, every term must be valid, `redirect` and `exp` appear at
 * most once, and unknown modifiers must hold a valid macro-string. `exp`
 * is checked but never evaluated. Throws a `permerror` on any error.
 */
export function parseSpfRecord(text: string): SpfRecord {
  if (/[^\x20-\x7e]/.test(text)) {
    throw permerror("the record holds a character outside printable US-ASCII");
  }
  const mechanisms: SpfMechanism[] = [];
  let redirect: MacroToken[] | null = null;
  const seen = { redirect: 0, exp: 0 };

  for (const term of text.slice("v=spf1".length).split(" ")) {
    if (!term) continue;
    const modifier = MODIFIER.exec(term);
    if (!modifier) {
      mechanisms.push(parseMechanism(term));
      continue;
    }
    const name = (modifier[1] ?? "").toLowerCase();
    const value = modifier[2] ?? "";
    if (name === "redirect") {
      seen.redirect++;
      redirect = parseDomainSpec(value);
    } else if (name === "exp") {
      seen.exp++;
      parseDomainSpec(value);
    } else {
      parseMacroString(value, true);
    }
  }

  if (seen.redirect > 1) throw permerror("more than one redirect modifier");
  if (seen.exp > 1) throw permerror("more than one exp modifier");
  return { mechanisms, redirect };
}
