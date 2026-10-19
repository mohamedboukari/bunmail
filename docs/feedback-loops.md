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

## How a report is processed

1. **Detection.** In the receiver's DATA handler, after the `unsub+` branch and **before** the bounce parser, a message whose top-level type is `multipart/report; report-type=feedback-report` (any case, quoted or not) goes to the feedback handler. The bounce parser also returns `null` for such a message (before #191 it fell into the bounce fallback parser and was usually dropped).
2. **Parsing** (`arf-parser.service.ts`, pure): the `message/feedback-report` part gives `Feedback-Type`, `User-Agent`, `Version`, `Original-Mail-From`, every `Original-Rcpt-To`, `Arrival-Date` (or `Received-Date`), `Reported-Domain`, `Source-IP`. The Message-ID of the reported message comes from the feedback part's `Original-Message-ID`, else from the `Message-ID` header of the third part (`message/rfc822` or `text/rfc822-headers`; providers often redact the body). A base64 part is decoded.
3. **Type.** `abuse`, `fraud`, or no type at all: a complaint. `opt-out`: an unsubscribe. `not-spam`, `virus`, `other` and anything else: logged at `info` and dropped.
4. **Link.** The Message-ID must exactly match the stored Message-ID of an email BunMail sent. (Bounces no longer link this way: since #236 they are bound by a signed return path, see [bounces.md](bounces.md#signed-return-paths-236). Feedback reports go to the address registered with the provider, not to the return path, so they keep the Message-ID link.) No Message-ID, or one that matches nothing: logged at `warn` and dropped.
5. **DKIM.** The report's own DKIM signature is verified with mailauth and the result logged (`dkim`, `dkimDomain`). It is **not required**: not every provider signs its reports. The check runs only for linked reports, makes no DNS lookup for an unsigned report, is skipped for more than five signatures or a header section over 64 KB, and gives up after 10 seconds.
6. **Recipient.** The first `Original-Rcpt-To` that was a recipient (to, cc or bcc) of the email, compared case-insensitively; else, if the email had exactly one recipient, that one; else none.
7. **Effect.**
   - Complaint with a recipient: `addFromComplaint`, a permanent `complaint` suppression under the email's API key (see [precedence](suppressions.md#precedence): complaint > unsubscribe / manual / hard bounce > temporary entries, and nothing that arrives later, a late bounce included, weakens it). When the row was created or changed, `email.complained` fires to that key's webhooks. When the address already had a permanent `complaint`, nothing changes and nothing fires (logged at `debug`).
   - Complaint without a recipient: nothing is suppressed (logged at `warn`), and `email.complained` still fires with `recipient: null` so the application can act on it.
   - Opt-out with a recipient: the one-click unsubscribe path (#249), a permanent `unsubscribe` suppression and `email.unsubscribed` with `source: "fbl"`. Without a recipient: logged at `warn` and dropped.
8. **Acknowledgement.** The SMTP transaction is accepted whatever the outcome, so the provider does not retry. A database error answers `451` (try again later), as for any inbound message.

Webhook payload: see [webhooks.md](webhooks.md#webhook-payload).

## Logs

| Message | Level | When |
|---|---|---|
| `Complaint handled` | `info` | Suppression created or strengthened, webhook fired |
| `Complaint suppression processed` | `info` | Every complaint write, with `outcome` |
| `Feedback opt-out handled` | `info` | An `opt-out` report went through the unsubscribe path |
| `Feedback report ignored: feedback type not acted on` | `info` | `not-spam`, `virus`, ... |
| `Feedback report dropped: no original email matches Message-ID` | `warn` | Unlinkable report |
| `Feedback report dropped: no readable feedback part` | `warn` | A `feedback-report` without a `message/feedback-report` part |
| `Complaint not suppressed: recipient could not be determined` | `warn` | Several recipients, no usable `Original-Rcpt-To` |
| `Feedback opt-out not applied: recipient could not be determined` | `warn` | Same, for `opt-out` |
| `Complaint already on file, nothing to do` | `debug` | Repeated report |

Lines carry `feedbackType`, `reporterDomain` (the domain of the report's `From`) and, once linked, `emailId`, `apiKeyId`, `dkim`, `dkimDomain`. Addresses go through `redactEmail`; the report's content and the reported message are never logged.

## Security

Reports arrive as unauthenticated mail, so the Message-ID link is the boundary: BunMail's Message-IDs carry 128 random bits, and only someone holding the delivered message can name one. A party that does can suppress that message's recipient, which is no more than the recipient unsubscribing. See [THREAT_MODEL.md](../THREAT_MODEL.md) for the full analysis and the residual risks.

The parser is bounded for the 10 MB inbound cap: header sections are read from their first 64 KB, at most 200 fields per section and 1000 characters per field, 16 MIME parts, 50 `Original-Rcpt-To` values, and Message-IDs over 255 characters are ignored. Unit tests assert a time budget on 10 MB hostile inputs.

## Module layout

```
src/modules/inbound/
├── services/
│   ├── arf-parser.service.ts        ← isFeedbackReport, parseFeedbackReport (pure)
│   ├── feedback-handler.service.ts  ← handleFeedbackReport (core, injected deps), handleInboundFeedbackReport (wired)
│   └── smtp-receiver.service.ts     ← the feedback branch, before the bounce parser
└── types/
    └── feedback-report.types.ts     ← FeedbackReport, FeedbackAction, FeedbackOutcome
```

Suppression side: `addFromComplaint` in `src/modules/suppressions/services/suppression.service.ts` ([suppressions.md](suppressions.md#complaints-feedback-loops)).

### Service methods

#### `isFeedbackReport(raw): boolean`
True when the top-level `Content-Type` is `multipart/report` with `report-type=feedback-report`. Reads the top header section only.

#### `parseFeedbackReport(raw): FeedbackReport | null`
The parsed fields, or `null` when the message is not a feedback report or has no `message/feedback-report` part.

#### `classifyFeedbackType(feedbackType): "complaint" | "opt-out" | "ignore"`
The type rule of step 3.

#### `handleFeedbackReport(report, deps): Promise<{ outcome, emailId? }>`
Steps 3 to 7 with injected dependencies (lookup, `addFromComplaint`, `unsubscribe`, `dispatchEvent`, DKIM check). Outcomes: `complained`, `complained-no-recipient`, `already-complained`, `unsubscribed`, `already-unsubscribed`, `dropped-unparseable`, `dropped-ignored-type`, `dropped-no-original`, `dropped-no-recipient`.

#### `handleInboundFeedbackReport(raw, rawBytes): Promise<{ outcome, emailId? }>`
Parses and handles with the real database, webhook and mailauth dependencies. Called by the receiver.

## Not handled

- **Complaint counts in the dashboard stats.** Complaints are visible as `complaint` suppressions and webhook events only.
- **Quoted-printable feedback parts and reports forwarded inside another message** are not decoded or unwrapped; providers send the feedback part as plain 7-bit text.
