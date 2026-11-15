# Feedback Loops (spam complaints)

When a recipient clicks "This is spam", some mailbox providers tell the sender through a **feedback loop** (FBL): a report in ARF format (Abuse Reporting Format, RFC 5965) sent by email to an address the sender registered. BunMail processes these reports on its inbound SMTP receiver (#191): the recipient who complained gets a permanent `complaint` suppression under the API key that sent the email, and `email.complained` fires to that key's webhooks.

Someone who marked you as spam must not be mailed again: every further message to them raises your complaint rate, and mailbox providers start filtering everything you send well before it reaches 0.3%.

## What the operator has to do

BunMail cannot enrol for you: each provider ties its feedback loop to something only the domain or IP owner can prove.

### 1. Route an FBL address to BunMail

The reports must reach this BunMail's inbound receiver:

1. **Inbound SMTP on:** `SMTP_ENABLED=true` and `SMTP_PORT=25`, with the port published (see [inbound.md](inbound.md#first-boot-checklist-docker-compose)).
2. **MX:** the domain of the FBL address has an `MX` record pointing at this host.
3. **Registered domain:** with recipient validation on (the default), that domain must be registered in BunMail, or the reports are refused at `RCPT TO`.

Any local part works, for example `fbl@example.com`: the receiver recognises a report by its content type, not its address. Reports are acknowledged and processed, never stored in the inbound list. A provider's enrolment confirmation mail is ordinary mail, so it appears in the dashboard's Inbound list as usual.

### 2. Enrol with each provider

| Provider | Program | Keyed on | Notes |
|---|---|---|---|
| Yahoo / AOL | Complaint Feedback Loop (CFL), via Yahoo Sender Hub | The DKIM signing domain (`d=`) | Register the domains BunMail signs for. Reports cover mail signed with them. The recipient address is usually redacted, so on a single-recipient email BunMail uses that email's recipient. |
| Microsoft (Outlook.com, Hotmail, Live) | Junk Mail Reporting Program (JMRP), and Smart Network Data Services (SNDS) | The sending IP addresses | Enrol the server's public sending IPs (`MAIL_PUBLIC_IP`). JMRP sends the per-message reports; SNDS is a reputation dashboard with no per-message reports. |
| Gmail | No per-message feedback loop | `Feedback-ID` header | Gmail only reports aggregate spam rates per `Feedback-ID` in Postmaster Tools (for high-volume senders). BunMail sends `Feedback-ID: <api\|smtp>:<hashed key>:<sender domain>:bunmail` on every email since #250 (see [emails.md](emails.md#feedback-id-and-auto-submitted-250)), so a key or sender domain with a high rate stands out there. Nothing arrives at BunMail. |
| iCloud | None | | No feedback loop. |
| Others | Varies | | Several other providers offer feedback loops, some through Validity's Universal Feedback Loop. Any that send standard ARF reports work the same way. |

Program names, URLs and requirements change: follow each provider's current postmaster documentation for the enrolment steps.

### 3. Optional: list the providers' feedback-loop signers and senders (`FEEDBACK_LOOP_DOMAINS`, `FEEDBACK_LOOP_SENDERS`)

Only needed with `SUPPRESSIONS_SHARED_HARD=true` (see [suppressions.md](suppressions.md#shared-hard-suppressions-suppressions_shared_hard-250)). A complaint is shared with the other API keys only when its report is **verified**. A verified complaint must come from a configured feedback-loop sender, signed by that sender's own domain:

1. a DKIM signature on the report passes, may vouch for it (see step 5 below), and its `d=` is one of `FEEDBACK_LOOP_DOMAINS`;
2. the report's header section has exactly one top-level `Content-Type` and exactly one `From` field, holding plainly one address that matches `FEEDBACK_LOOP_SENDERS` (see "Which `From`" below);
3. that signature's `d=` is **aligned** with the `From` domain: the same domain, or the `From` domain is a subdomain of it (`d=example.net` covers `From: feedback@fbl.example.net`, not the other way round);
4. the SMTP envelope sender (`MAIL FROM`) is empty (`<>`) or also matches `FEEDBACK_LOOP_SENDERS`.

**Which `From`.** A signature covers one instance of each header field it lists, so the `From` and `Content-Type` that count are read the way the DKIM verifier reads the header section (latin1, its own line split and field names), not the way the ARF parser does. Any second line that could be taken for a `From` or a `Content-Type` field (whatever its case, with controls, non-ASCII bytes or spaces around the name, or after a bare CR or LF), other than a line folded into the field above it, means the report is not verified. The `From` value must be plainly one mailbox: a bare address without quotes, or `Name <address>` (the name may be one quoted string), printable ASCII, compared in ASCII case only; a comment (`(...)` outside a quoted name), a backslash anywhere, a list, a group or a value of 1000 characters or more is refused.

Both lists are comma-separated and empty by default. With either one empty, no report is verified and no complaint is shared, whatever `SUPPRESSIONS_SHARED_HARD` says. Any complaint that is not verified still suppresses the recipient under the API key that sent the email and fires `email.complained` as usual; it just does not block the other keys.

**`FEEDBACK_LOOP_DOMAINS`**: the DKIM signing domains (`d=`) of the providers' reports.

- **Exact match only**, ASCII case and a final dot ignored: listing `example.net` does not accept `d=fbl.example.net`, nor the other way round. A subdomain rule would trust every name under a listed domain, so one mistaken entry (a two-label public suffix, or a provider that gives subdomains to its users) would let anyone verify a report; a missed domain only keeps complaints per key, the safe side.
- Each entry is normalised like a registered domain name (trimmed, an IDN turned into its A-label, lower-cased, one final dot dropped) and must have at least two labels; anything else (an IP address, a URL, an address, a wildcard) refuses to boot.
- **Consumer mailbox domains** (`gmail.com`, `yahoo.com`, `outlook.com`, `hotmail.com`, `proton.me`, `gmx.*` and the like, and every subdomain of one, such as `mail.yahoo.com`) sign the ordinary mail of every one of their users. Listing one is allowed, since some providers sign their reports with that same domain, but boot logs a `warn` naming it: for such a domain, `FEEDBACK_LOOP_SENDERS` must hold only the provider's exact feedback-loop address.

**`FEEDBACK_LOOP_SENDERS`**: who sends the providers' reports.

- An entry is one exact address (`feedback@fbl.example.net`) or `@` and a domain (`@fbl.example.net`: any address at exactly that domain, no subdomains). Matching ignores case.
- Prefer exact addresses. Use `@domain` only for a domain the provider reserves for its feedback loop. `@domain` for a consumer mailbox domain or a subdomain of one (`@gmail.com`, `@hotmail.com`, `@yahoo.co.uk`, `@arf.mail.yahoo.com`, ...) refuses to boot: list the exact address instead.
- Anything that is not a bare address or `@domain` (a display name, angle brackets, a `*`, a non-ASCII local part) refuses to boot.
- If a provider's envelope sender differs from its `From`, list it too (or the reports arrive with `<>`, which is accepted).

**Finding the values.** Take them from a real report, never from memory:

- The `Complaint handled` log line shows `dkim` and `dkimDomain` (the `d=` of the signature that passed). Once `FEEDBACK_LOOP_DOMAINS` is set, a report that is not verified also logs `Complaint not verified: it stays under the sending key` with `unverifiedReason`, `passingDomains` (every `d=` that passed), `reporter` (the `From` the ARF parser read), `signedFrom` (the `From` a signature covers, empty when there is not exactly one) and `envelopeFrom`. Addresses there go through `LOG_REDACT_PII` (in production only the first letter of the local part shows), so read the full address from the report itself.
- To read a report's headers, register an address you can read (an ordinary mailbox) as an extra feedback-loop address with the provider, or have one report forwarded as an attachment. The values are the `From:` header address (`FEEDBACK_LOOP_SENDERS`), the `d=` tag of the `DKIM-Signature:` header (`FEEDBACK_LOOP_DOMAINS`), and the `Return-Path:` the receiving server added (the envelope sender).
- Check them against the provider's postmaster documentation. Yahoo / AOL CFL reports have come from a dedicated address (`feedback@arf.mail.yahoo.com`); Microsoft JMRP reports from a dedicated staff address at a Microsoft consumer domain. These change, so trust the headers of a report you received.

**Upgrading.** A deployment that set `FEEDBACK_LOOP_DOMAINS` before `FEEDBACK_LOOP_SENDERS` existed verifies no new complaint until `FEEDBACK_LOOP_SENDERS` is set: boot logs a `warn` saying so. Complaints already stored as verified stay verified.

## How a report is processed

1. **Detection.** In the receiver's DATA handler, after the `unsub+` branch and **before** the bounce parser, a message whose top-level type is `multipart/report; report-type=feedback-report` (any case, quoted or not) goes to the feedback handler. The bounce parser also returns `null` for such a message (before #191 it fell into the bounce fallback parser and was usually dropped).
2. **Parsing** (`arf-parser.service.ts`, pure): the `message/feedback-report` part gives `Feedback-Type`, `User-Agent`, `Version`, `Original-Mail-From`, every `Original-Rcpt-To`, `Arrival-Date` (or `Received-Date`), `Reported-Domain`, `Source-IP`. The Message-ID of the reported message comes from the feedback part's `Original-Message-ID`, else from the `Message-ID` header of the third part (`message/rfc822` or `text/rfc822-headers`; providers often redact the body). A base64 part is decoded. The body is read in its relaxed-canonical form (RFC 6376 section 3.4.4: whitespace runs made one space, trailing whitespace and trailing empty lines dropped), with the boundary normalised the same way, and inside the body a line of only spaces or tabs counts as an empty line: a relaxed DKIM signature cannot tell such bodies apart, so they must yield the same parts, link and recipient.
3. **Type.** `abuse`, `fraud`, or no type at all: a complaint. `opt-out`: an unsubscribe. `not-spam`, `virus`, `other` and anything else: logged at `info` and dropped.
4. **Link.** The Message-ID must exactly match the stored Message-ID of an email BunMail sent. (Bounces no longer link this way: since #236 they are bound by a signed return path, see [bounces.md](bounces.md#signed-return-paths-236). Feedback reports go to the address registered with the provider, not to the return path, so they keep the Message-ID link.) No Message-ID, or one that matches nothing: logged at `warn` and dropped.
5. **DKIM.** The report's own DKIM signatures are verified by `dkim-verifier.service.ts` (RFC 6376, #373) and the verdict logged (`dkim`, `dkimDomain`): the first signature that passes, else the first one. It is **not required** to act on a report: not every provider signs its reports. It is one input of whether the complaint is **verified** (`verifyFeedbackReport`, see [step 3 of the setup](#3-optional-list-the-providers-feedback-loop-signers-and-senders-feedback_loop_domains-feedback_loop_senders)): a signature that passes and may vouch for the report (`signatureCanVouch`), whose `d=` is exactly one of `FEEDBACK_LOOP_DOMAINS` and is aligned with the report's `From`, which must match `FEEDBACK_LOOP_SENDERS` (as must a non-empty envelope sender). That `From`, and the single top-level `Content-Type`, are read with the verifier's own header split (`readSignedHeaderView`, see "Which `From`" in setup step 3), only once a signature passed. A passing signature may vouch only when its key is outside testing mode (`t=y` keys are treated as unsigned, RFC 6376 section 3.6.1), it has **no `l=` tag** (a body length limit, whatever length it gives, lets content be appended after the signed part), and its `h=` covers **`From` and `Content-Type`** (case-insensitive; the report's parts are found through the top-level `Content-Type`, so an unsigned one could be replaced). A passing signature that fails one of these is logged at `debug` (`Feedback report signature passed but cannot verify the report`, with the domain and the reason) and does not count. Only a verified complaint is shared across API keys (see step 7). The check runs only for linked reports, makes no DNS lookup for an unsigned report, is skipped for more than five DKIM-Signature fields or a header section over 64 KB, and gives up after 10 seconds (`temperror`). ARC header fields are not DKIM signatures and are neither counted nor verified. Verdicts: `pass`, `fail` (body hash or signature mismatch), `neutral` (signature syntax error, unknown algorithm or canonicalization, `h=` without From, `i=` outside `d=`, expired `x=`), `policy` (rsa-sha1, an RSA key under 1024 bits), `permerror` (no key record, a revoked or unusable key), `temperror` (any other DNS failure or the 10 s cap), `none` (unsigned), `skipped`.
6. **Recipient.** The first `Original-Rcpt-To` that was a recipient (to, cc or bcc) of the email, compared case-insensitively; else, if the email had exactly one recipient, that one; else none.
7. **Effect.**
   - Complaint with a recipient: `addFromComplaint`, a permanent `complaint` suppression under the email's API key (see [precedence](suppressions.md#precedence): complaint > unsubscribe / manual / hard bounce > temporary entries, and nothing that arrives later, a late bounce included, weakens it), with `complaint_verified` set from step 5. When the row was created or changed, `email.complained` fires to that key's webhooks. When the address already had a permanent `complaint`, nothing changes and nothing fires (logged at `debug`), except that a verified report upgrades an unverified complaint's flag (never the other way round).
   - Complaint without a recipient: nothing is suppressed (logged at `warn`), and `email.complained` still fires with `recipient: null` so the application can act on it.
   - Opt-out with a recipient: the one-click unsubscribe path (#249), a permanent `unsubscribe` suppression and `email.unsubscribed` with `source: "fbl"`. Without a recipient: logged at `warn` and dropped.
8. **Acknowledgement.** The SMTP transaction is accepted whatever the outcome, so the provider does not retry. A database error answers `451` (try again later), as for any inbound message.

Webhook payload: see [webhooks.md](webhooks.md#webhook-payload).

## Logs

| Message | Level | When |
|---|---|---|
| `Complaint handled` | `info` | Suppression created or strengthened, webhook fired; carries `dkim`, `dkimDomain`, `verified` and `unverifiedReason` |
| `Complaint not verified: it stays under the sending key` | `warn` / `info` | `FEEDBACK_LOOP_DOMAINS` is set and the complaint is not verified; carries `unverifiedReason`, `passingDomains`, `reporter`, `signedFrom` and `envelopeFrom`. `warn` when a listed domain signed the report but the sender, the alignment or the envelope does not match (`content_type_ambiguous`, `sender_missing`, `sender_not_listed`, `not_aligned`, `envelope_not_listed`); `info` for `domain_not_listed` and `no_feedback_loop_senders` |
| `FEEDBACK_LOOP_DOMAINS is set but FEEDBACK_LOOP_SENDERS is empty: no complaint is verified or shared` | `warn` | Once at boot |
| `FEEDBACK_LOOP_DOMAINS lists a mailbox provider domain that signs its users' mail` | `warn` | Once at boot, with `domains` |
| `Complaint suppression processed` | `info` | Every complaint write, with `verified` and `outcome` (`suppressed`, `verified-upgrade`, `already-complained`) |
| `Feedback opt-out handled` | `info` | An `opt-out` report went through the unsubscribe path |
| `Feedback report ignored: feedback type not acted on` | `info` | `not-spam`, `virus`, ... |
| `Feedback report dropped: no original email matches Message-ID` | `warn` | Unlinkable report |
| `Feedback report dropped: no readable feedback part` | `warn` | A `feedback-report` without a `message/feedback-report` part |
| `Complaint not suppressed: recipient could not be determined` | `warn` | Several recipients, no usable `Original-Rcpt-To` |
| `Feedback opt-out not applied: recipient could not be determined` | `warn` | Same, for `opt-out` |
| `Complaint already on file, nothing to do` | `debug` | Repeated report |

Lines carry `feedbackType`, `reporterDomain` (the domain of the report's `From`) and, once linked, `emailId`, `apiKeyId`, `dkim`, `dkimDomain`. Complaint lines also carry `verified` and `unverifiedReason` (`null` when verified): `no_feedback_loop_domains`, `no_feedback_loop_senders`, `domain_not_listed`, `content_type_ambiguous`, `sender_missing`, `sender_not_listed`, `not_aligned` or `envelope_not_listed`. Addresses go through `redactEmail`; the report's content and the reported message are never logged.

## Security

Reports arrive as unauthenticated mail, so the Message-ID link is the boundary: BunMail's Message-IDs carry 128 random bits, and only someone holding the delivered message can name one. A party that does can suppress that message's recipient under the sending key, which is no more than the recipient unsubscribing. Sharing a complaint with the other keys needs more than the Message-ID, which the sending tenant also holds: the report must be verified (setup step 3), from a configured feedback-loop sender and signed by that sender's own domain. A DKIM signature proves only which domain signed, and a provider's domain may also sign mail its users write, hence the sender list and the alignment rule. See [THREAT_MODEL.md](../THREAT_MODEL.md) for the full analysis and the residual risks.

The parser is bounded for the 10 MB inbound cap: header sections are read from their first 64 KB, at most 200 fields per section and 1000 characters per field, 16 MIME parts, 50 `Original-Rcpt-To` values, and Message-IDs over 255 characters are ignored. Unit tests assert a time budget on 10 MB hostile inputs.

## Module layout

```
src/modules/inbound/
├── services/
│   ├── arf-parser.service.ts        ← isFeedbackReport, parseFeedbackReport (pure)
│   ├── dkim-verifier.service.ts     ← verifyDkimSignatures: DKIM verdict per signature (#373)
│   ├── dkim-verifier-parse.service.ts ← message split, tag-lists, the signature's tags (#387)
│   ├── dkim-verifier-canonical.service.ts ← canonicalization, the signed header data (#387)
│   ├── dkim-verifier-key.service.ts ← key record lookup and checks, the signature check (#387)
│   ├── feedback-handler.service.ts  ← handleFeedbackReport (core, injected deps), handleInboundFeedbackReport (wired)
│   ├── feedback-verification.service.ts ← verifyFeedbackReport: the verified-complaint rule (pure)
│   └── smtp-receiver-data.service.ts ← the feedback branch, before the bounce parser
└── types/
    ├── feedback-report.types.ts     ← FeedbackReport, FeedbackAction, FeedbackOutcome
    └── dkim.types.ts                ← DkimSignatureResult, DkimResult, DkimVerifyDeps; the verifier's internal types (#387)
```

Suppression side: `addFromComplaint` in `src/modules/suppressions/services/suppression.service.ts` ([suppressions.md](suppressions.md#complaints-feedback-loops)).

### Service methods

#### `isFeedbackReport(raw): boolean`
True when the top-level `Content-Type` is `multipart/report` with `report-type=feedback-report`. Reads the top header section only.

#### `parseFeedbackReport(raw): FeedbackReport | null`
The parsed fields, or `null` when the message is not a feedback report or has no `message/feedback-report` part.

#### `classifyFeedbackType(feedbackType): "complaint" | "opt-out" | "ignore"`
The type rule of step 3.

#### `verifyFeedbackReport({ dkim, headers, envelopeFrom }, { domains, senders }): FeedbackVerification`
`feedback-verification.service.ts`, pure: the verified-complaint rule of [setup step 3](#3-optional-list-the-providers-feedback-loop-signers-and-senders-feedback_loop_domains-feedback_loop_senders). `{ verified: true, signingDomain }` when a `d=` of `dkim.passingDomains` (every passing signature that may vouch, see step 5) is exactly one of `domains` (`FEEDBACK_LOOP_DOMAINS`, ASCII case and a final dot ignored) and aligned with the domain of `headers.from` (the single `From` a signature covers, from `readSignedHeaderView`; `headers.contentTypeSingle` must also be true), which matches `senders` (`FEEDBACK_LOOP_SENDERS`), and `envelopeFrom` is `null` (`<>`) or matches `senders` too. Otherwise `{ verified: false, reason }`, with the reason codes of the [Logs](#logs) section. Either list empty verifies nothing.

#### `readSignedHeaderView(rawBytes): { from, contentTypeSingle }`
`feedback-verification.service.ts`, pure: `From` and `Content-Type` as the DKIM verifier reads the header section (`splitMessage`). `from` is the address of the one `from` field (`mailboxAddress`, refusing anything but plainly one mailbox), `null` when that split has none or several or a lenient scan of every line that does not continue the one above finds more than one line that could be a `From`; `contentTypeSingle` is the same test for `Content-Type`.

#### `mailboxAddress(value): string | null`
`arf-parser.service.ts`, pure: the one address of a `From` value (a bare address or `Name <address>`), lowercased in ASCII only; `null` for a value of 1000 characters or more, a backslash anywhere, a quote anywhere but around the leading display name, a `(` or `)` outside it, anything after the closing bracket, a list, a group, an unterminated quote, or an address that is not printable ASCII.

#### `handleFeedbackReport(report, deps): Promise<{ outcome, emailId? }>`
Steps 3 to 7 with injected dependencies (lookup, `transaction`, `addFromComplaint`, `unsubscribe`, `enqueueEvent`, DKIM check, `feedbackLoopDomains`, `feedbackLoopSenders`, `envelopeFrom`, `readSignedHeaders`). The complaint suppression and `email.complained` are written in one transaction (#184); a failure is logged (`Complaint not recorded`) and thrown, so the receiver answers `451` and the provider resends the report. Outcomes: `complained`, `complained-no-recipient`, `already-complained`, `unsubscribed`, `already-unsubscribed`, `dropped-unparseable`, `dropped-ignored-type`, `dropped-no-original`, `dropped-no-recipient`.

#### `handleInboundFeedbackReport(raw, rawBytes, envelopeFrom, dkimDeps?): Promise<{ outcome, emailId? }>`
Parses and handles with the real database, webhook and DKIM verifier dependencies, and the current `config.suppressions.feedbackLoopDomains` and `feedbackLoopSenders`. Called by the receiver with the SMTP envelope sender, lower-cased (`null` for `MAIL FROM:<>`); `dkimDeps` (the verifier's TXT lookup and clock) is for tests only.

#### `verifyDkimSignatures(message, deps?): Promise<DkimSignatureResult[]>`
`dkim-verifier.service.ts` (#373), on `node:crypto` and `src/utils/dns-txt.ts` (a TXT lookup that keeps a 2048-bit key published as two strings in one record, where Bun's `resolveTxt` splits it, oven-sh/bun#44692), no dependency. One result per DKIM-Signature field, in header order, empty for an unsigned message; never rejects. Each result has `result` (`pass`, `fail`, `neutral`, `temperror`, `permerror` or `policy`, as in step 5), `signingDomain` and `selector` as written, `reason` (null on `pass`), `testing` (the key record has `t=y`), `hasLengthLimit` (the signature has an `l=` tag) and `signedHeaders` (the `h=` names, lowercased, in order; empty when the tag-list does not parse).

- **Signature (RFC 6376 section 3.5):** the tag-list must be well formed (case-sensitive names, no repeated tag) with `v=1`, `a`, `b`, `bh`, `d`, `h` and `s`; `h=` must list From; `i=` must be `d=` or a subdomain of it; `x=` must be after `t=`, and an `x=` in the past is `neutral`. `a=rsa-sha256` and `a=ed25519-sha256` (RFC 8463) are verified, `a=rsa-sha1` is refused as `policy` (RFC 8301).
- **Canonicalization:** `simple` and `relaxed` for the header and the body, `l=` honoured. Header fields named in `h=` are taken bottom up, one instance per name; a name listed more often than the field occurs selects nothing, so a field added after signing breaks an over-signed signature. The signature field itself is hashed with only its `b=` value emptied. Bare LF line ends are read as CRLF.
- **Key record** at `<s>._domainkey.<d>` (TXT, the strings of the first record joined): `v=DKIM1` first when present, `k=rsa` (SubjectPublicKeyInfo or bare RSAPublicKey, at least 1024 bits) or `k=ed25519` (the raw 32-byte key), `h=` must allow sha256, `s=` must allow email, `t=s` refuses an `i=` subdomain; an empty `p=` is a revoked key. One lookup per key per message.
- **DNS:** NXDOMAIN or no data (`ENOTFOUND`, `ENODATA`) is `permerror`, any other failure `temperror`. `deps.resolveTxt` and `deps.now` replace the lookup and the clock in tests.

## Not handled

- **Complaint counts in the dashboard stats.** Complaints are visible as `complaint` suppressions and webhook events only.
- **Quoted-printable feedback parts and reports forwarded inside another message** are not decoded or unwrapped; providers send the feedback part as plain 7-bit text.
