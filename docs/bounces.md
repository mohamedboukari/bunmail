# Bounces Module

Parses Delivery Status Notifications (DSNs) that arrive at BunMail's inbound SMTP, binds them to the original outbound email and recipient through a signed per-recipient return path (#236), and feeds the **suppression list** ([docs/suppressions.md](suppressions.md)) so we stop sending to dead recipients.

Repeatedly sending to bouncing addresses is the **single fastest way to kill IP reputation**. Gmail / Yahoo / Outlook track sender bounce rates per-IP and per-domain; a few hundred sends to non-existent mailboxes is enough to start landing legitimate mail in spam. This module closes the loop.

## What is a bounce?

When BunMail's outbound SMTP delivers a message, the recipient's MX server **accepts the SMTP transaction** at handoff: that's why the email row's `status` becomes `sent`. The recipient's mail system then tries to land the message in the actual mailbox. If that fails (mailbox doesn't exist, full, blocked, etc.), the receiver sends a **Delivery Status Notification** back to the envelope sender.

The DSN arrives at our **inbound** SMTP server, which is why this module lives next to `smtp-receiver`. With inbound SMTP enabled, that envelope sender is a [signed return path](#signed-return-paths-236) naming one email and one recipient.

## Two bounce flavours

Receivers handle "address doesn't exist" / "address rejects mail" in **two distinct ways**, and both need to feed the suppression list:

| Flavour | When the receiver does this | Caught by |
|---|---|---|
| **Inline 5xx** | The MX checks the address synchronously and rejects during `RCPT TO` or `DATA` with a `550 5.1.1` style reply. No DSN is ever sent: the sending MTA already knows. | The queue's send-failure path: [queue.service.ts → `handleSendFailure`](../src/modules/emails/services/queue.service.ts) (#68) |
| **Async DSN** | The MX accepts at 250, tries to deliver later, fails, sends a Delivery Status Notification back to the envelope sender. | The bounce module: [bounce-parser](../src/modules/bounces/services/bounce-parser.service.ts) + [bounce-handler](../src/modules/bounces/services/bounce-handler.service.ts) (#24) |

Both paths converge on the same `suppressionService.addFromBounce()` call and fire the same `email.bounced` webhook. From the consumer's perspective the signal is uniform: the only difference is the `source` field on the webhook payload (`"inline"` vs `"rfc3464"` / `"fallback"`).

Modern Gmail / Outlook / Yahoo prefer **inline 5xx** for obvious-nonexistence cases. Async DSNs are more common for "address used to exist" / "mailbox full" / "domain temporarily unreachable" cases.

## Async DSN parser strategies

Two paths, tried in order. Both are pure functions in [src/modules/bounces/services/bounce-parser.service.ts](../src/modules/bounces/services/bounce-parser.service.ts).

### 1. RFC 3464 (the standard)

Triggered when the message's `Content-Type` is `multipart/report; report-type=delivery-status`. We read the canonical headers from the `message/delivery-status` MIME part:

| Header | What we use it for |
|---|---|
| `Final-Recipient` | The recipient address that bounced |
| `Original-Recipient` | Optional: the address as first submitted, before forwarding or alias expansion (see recipient check below) |
| `Status` | Enhanced SMTP status code (`5.x.x` = hard, `4.x.x` = soft, `2.x.x` = ignored) |
| `Diagnostic-Code` | Human-readable reason: persisted on the suppression row |
| `Original-Message-ID` | Optional and informational: the return path, not this field, links the bounce to its email (#236). Postfix, for one, does not send it |

Modern Gmail / Outlook / Yahoo bounces all hit this path.

### 2. Fallback regex (non-RFC)

Older MTAs (qmail, Exim with old configs, custom mail servers) sometimes send plain-text bounce notices that don't follow RFC 3464. The fallback scrapes:

- Any enhanced (`5.1.1`) or basic (`550`) SMTP status code from the body
- The first `<user@host>` recipient in the **body** (not in headers: `Message-ID:` and `In-Reply-To:` headers also carry `<x@y>` and would otherwise win document order)
- An `In-Reply-To:` or embedded `Message-ID:` header: part of the evidence that a plain-text message is a bounce at all (it is not used to link it, #236)

The fallback only runs when the message has obvious bounce markers: sender is `MAILER-DAEMON` or `postmaster`, subject mentions delivery failure, or content-type is `multipart/report`. This **`looksLikeBounce` gate** prevents normal customer reply mail that happens to contain a status-code-shaped string from being mis-classified.

## Signed return paths (#236)

A DSN is unauthenticated mail, and the Message-ID in its body is visible to every recipient of the email. Linking bounces by Message-ID (as before #236) let one recipient forge a DSN for a co-recipient of the same email and get that address suppressed under the sender's key. So the link now comes from the address the DSN is delivered to, which BunMail signs.

**When.** Signed return paths are used for domains whose MX points at this BunMail; other domains keep the From address as envelope sender. Precisely, both must hold, decided once per email at each send attempt (the same answer for all its recipients):

- inbound SMTP is enabled (`SMTP_ENABLED=true`), the only setup where a DSN can reach BunMail;
- the sender domain's MX set names this server's `MAIL_HOSTNAME` (case-insensitive, trailing dot ignored).

A multi-domain install can send for a domain whose mail is hosted elsewhere (a Google Workspace mailbox, say). Such a domain keeps the From address as envelope sender: a `b+` address there would be rejected by its own mail host, losing DSNs that today at least reach a human, and receivers doing sender-verification callouts could refuse the mail. The MX answer is cached in memory per domain (an hour for a yes or a no, NXDOMAIN and "no MX" included; five minutes after a DNS error or a 5-second timeout; at most 10,000 domains). A DNS error falls back to the plain envelope (fail safe) and is logged at `warn` once per domain per five minutes. Pointing a domain's MX here (or away) takes effect within the hour; a retry decides again, and the delivery state copes with the change. With `SMTP_ENABLED=false` nothing changes.

**The address.** Each recipient of an email gets its own envelope sender (`MAIL FROM`):

```
b+<24 hex of the email id>.<recipient index>.<MAC>@<sender domain>
```

- **Recipient index**: the recipient's position in the email's recipients in a fixed order: `to`, then `cc`, then `bcc`, parsed and de-duplicated as the mailer does (`parseRecipients`, first occurrence wins). Decimal, no leading zero, at most 999999.
- **MAC**: HMAC-SHA256 over `verp:v1:<email id>:<index>:<lowercased recipient>`, truncated to 96 bits (24 hex characters), under a key derived with HKDF-SHA256 from `DKIM_ENCRYPTION_KEY` under its own label (`bunmail return path v1`, separate from the unsubscribe key). No new secret, nothing stored per address.
- **Lowercase hex only**, so a receiving MTA that folds the case of the local part does not break it. The local part is at most 58 characters (RFC 5321 allows 64).
- **Domain**: the domain of the From address, the same as the envelope sender before #236. SPF is still evaluated for that domain and DMARC alignment of the envelope sender is unchanged. Its MX points at this BunMail (see **When**), so DSNs arrive here.

**One SMTP transaction per recipient.** The envelope sender belongs to the whole transaction, so with return paths each recipient is sent in its own transaction, with only that recipient in `RCPT TO`: a co-recipient never sees another recipient's return path. The transactions to one MX share one connection (a nodemailer pool of one connection). Headers, DKIM signature, custom headers, `List-Unsubscribe` and `Feedback-ID` are the same in every transaction. Delivery outcomes, failure classification and retries are per recipient: the delivery state holds one entry per recipient, keyed `<mx host>#<recipient index>`. A single-recipient email is one transaction, as before.

**Verification.** At `RCPT TO`, an address whose local part starts with `b+` (any case) is accepted only when it verifies: it parses, the email row exists, the index names one of its recipients, the MAC matches that recipient (constant-time compare), and the domain is the email's sender domain. Anything else is refused with `550` (a database error answers `451`), so nothing is stored. The `b+` local part is therefore reserved on domains BunMail receives for.

**At DATA**, a message to a verified return path is handled before every other branch and is never stored as inbound mail or notified:

- a DSN (RFC 3464, or the heuristic fallback) applies to **exactly the bound email and recipient**. What the DSN body says about recipients (`Final-Recipient`, `Original-Recipient`) is ignored; a mismatch is logged at `warn`.
- anything else (an auto-reply or vacation notice, which RFC 3834 sends to the return path, an ARF report) is acknowledged and dropped, logged at `info`.

**No Message-ID fallback.** A DSN sent to any other address (not a verified `b+` address) has no effect: it is logged at `warn`, acknowledged and dropped, as unlinkable bounces always were. That is what makes a DSN with a missing or invalid signature harmless.

**Upgrade consequences.** Late DSNs for emails sent before the upgrade (or before `SMTP_ENABLED` was turned on, or before the domain's MX pointed here) arrive at the plain sender address and are ignored; synchronous `5xx` rejections at send time still suppress, unchanged. Auto-replies sent to the return path are dropped, as at every major ESP.

**Rotation.** Rotating `DKIM_ENCRYPTION_KEY` invalidates every return path already sent: there is no previous-key mechanism for that key, so DSNs for mail sent before the rotation have no effect (SECURITY.md, Rotation).

**Residual.** Whoever can read a recipient's own return path (the recipient, whose delivered copy usually shows it in `Return-Path:`, their mailbox provider, or anyone they forward the message to) can bounce that one recipient, the same as that recipient's own provider bouncing it. Nobody can bounce a co-recipient.

### Parser performance

`parseBounce` runs on every inbound message (up to 10 MB), so it is written to run in linear time: identifiers on `Message-ID` / `In-Reply-To` / `References` lines are collected in one pass, the DSN content-type is checked with two independent tests, field regexes stay on one line, and address extraction looks at most 1,000 characters. `test/unit/bounce-parser.test.ts` has bounded-time tests with large generated inputs.

## Inline 5xx flow (#68)

When `processEmail`'s SMTP send throws an error, the catch block parses the error message via [src/utils/smtp-error.ts](../src/utils/smtp-error.ts) and dispatches via `handleSendFailure`:

| Classification | What happens |
|---|---|
| **Sender policy block (#246)**: `5.7.x`, or a `5xx` naming a blocklist, reputation or SPF/DKIM/DMARC failure (`550 5.7.1 ... blocked using Spamhaus`) | The receiver refused **the sender**, not the address: the group fails (`blocked: true` in its delivery state), **nobody is suppressed**, and `email.failed` carries `blocked: true`. A reply that also says the user doesn't exist stays a hard bounce. Fix the sending IP's reputation or the domain's authentication, then resend. |
| **Hard (5xx)**: `550 5.1.1`, etc. | Auto-suppress recipient with `bounceType: "hard"`, mark email `status = 'bounced'`, fire `email.bounced` webhook with `source: "inline"`, **stop retrying**. Three retries to the same MX would just be three more `550` hits: exactly what tanks IP reputation. |
| **Soft (4xx)**: `452 4.2.2 mailbox full`, `421 greylist`, etc. | Retried with backoff (5 m, 15 m, 30 m, 1 h, 2 h, then every 4 h) until the email is `MAIL_RETRY_MAX_AGE_HOURS` old (#180). Repeated soft bounces are still handled by the async-DSN path's escalation rule: the inline catch-block doesn't have enough signal alone to make a per-recipient soft → hard call safely. |
| **Non-SMTP error**: DNS resolution failure, socket timeout, TLS handshake error | Retried with backoff. An IP address or port in the error (`connect ECONNREFUSED 5.6.7.8:25`) is never read as a status code. Infrastructure problems don't tell us anything about the recipient. |

Auto-suppression on inline 5xx fires on **attempt 1**: no point waiting for further retries to confirm what the receiver already told us authoritatively.

## Async DSN → suppression flow

When a DSN parses cleanly and arrived at a verified return path, the bounce handler does five things for the email and recipient that return path names (see [Signed return paths](#signed-return-paths-236)):

1. **Look up existing suppression** for `(api_key_id, recipient)`.
2. **Decide hard vs soft** with escalation:
   - Parsed kind `hard` → always `hard`.
   - Parsed kind `soft`, no existing suppression → `soft` (24h expiry).
   - Parsed kind `soft`, **existing soft suppression still active** → escalate to `hard` (permanent). Repeated transient failures are effectively permanent for IP-reputation purposes.
3. **Persist via `suppressionService.addFromBounce`**. A bounce never weakens a suppression (#191): with no row on file it inserts one; on conflict it only rewrites a **temporary** row (a soft bounce refreshes the window, a hard bounce makes it permanent); a **permanent** row of any reason (complaint, unsubscribe, manual, an earlier hard bounce) is left exactly as it is. Steps 4 and 5 run either way. See [suppressions.md](suppressions.md#precedence).
4. **Mark the original email row**: `status = 'bounced'`, only if the queue has finished with it (`sent` or `failed`); a row still being retried keeps its status so its other recipients are still attempted. The dashboard / `GET /emails?status=bounced` filter then shows it correctly.
5. **Fire `email.bounced` webhook** with the original email id, recipient, bounce type, status, diagnostic, and `suppressionId` (so receivers can cross-reference the suppression in effect: the one just written, or the permanent one left in place).

## Webhook payload

`email.bounced` from the **inline 5xx** path:

```json
{
  "event": "email.bounced",
  "timestamp": "2026-05-08T...",
  "data": {
    "emailId": "msg_a1b2c3...",
    "to": "user@example.com",
    "bounceType": "hard",
    "status": "5.1.1",
    "diagnostic": "Can't send mail - all recipients were rejected: 550-5.1.1 ...",
    "suppressionId": "sup_d4e5f6...",
    "source": "inline"
  }
}
```

`email.bounced` from the **async DSN** path:

```json
{
  "event": "email.bounced",
  "timestamp": "2026-05-08T...",
  "data": {
    "emailId": "msg_a1b2c3...",
    "to": "user@example.com",
    "bounceType": "hard",
    "status": "5.1.1",
    "diagnostic": "550 5.1.1 User unknown",
    "suppressionId": "sup_d4e5f6..."
  }
}
```

The async-DSN path doesn't emit a `source` field today (consumers can treat its absence as `"rfc3464"` or `"fallback"`). Both payload shapes carry `suppressionId` so receivers can cross-reference the auto-created suppression row regardless of which path fired.

## What we do **not** do

- **No `2.x.x` "delivered" reports**: those are positive confirmations and don't need handling.
- **No linking by Message-ID** (#236): a DSN that did not arrive at a verified return path is logged and dropped, whatever Message-ID it carries. The Message-ID is visible to every recipient, so it cannot tell a real bounce from a forged one.
- **No retry of the original email**: by definition the recipient's MX accepted the SMTP transaction; retrying would just bounce again and double-tank reputation.
- **No DMARC `rua` / FBL complaint processing here**: those are separate parsers (#41, see [dmarc-reports.md](dmarc-reports.md); #191, see [feedback-loops.md](feedback-loops.md)). A `multipart/report` with `report-type=feedback-report` is never taken as a bounce: `parseBounce` returns `null` for it (before #191 it fell into the fallback parser and was usually dropped), and the receiver routes it to the feedback-loop handler first.

## Status column mapping

| Status | Meaning |
|---|---|
| `queued` | Waiting for the queue processor |
| `sending` | Mid-SMTP-transaction |
| `sent` | SMTP transaction succeeded; recipient's MX accepted |
| `failed` | All retries exhausted; never reached an MX |
| `bounced` | Was `sent`, then a DSN came back. Set by this module |

## Testing

The parser is fully unit-testable in [test/unit/bounce-parser.test.ts](../test/unit/bounce-parser.test.ts): RFC 3464 hard / soft, 2.x.x delivered, a DSN without Original-Message-ID, qmail-style fallback, and the negative case where normal customer reply mail mentions a status code.

The handler's orchestration is unit-testable via injected callbacks in [test/unit/bounce-handler.test.ts](../test/unit/bounce-handler.test.ts): hard, first soft, escalation on second soft, no double-escalation on already-hard, a DSN naming a co-recipient (only the bound recipient is affected), and a permanent suppression kept on file.

Return paths: [test/unit/return-path.test.ts](../test/unit/return-path.test.ts) (round trip, every tamper, case folding, wrong recipient / index / email / domain / key, the 64-character bound, recipient order), the MX rule and its cache in [test/unit/return-path-mx.test.ts](../test/unit/return-path-mx.test.ts), the per-recipient transactions in [test/unit/mailer.service.test.ts](../test/unit/mailer.service.test.ts), and the real receiver in [test/integration/return-path.integration.test.ts](../test/integration/return-path.integration.test.ts).

## Manual smoke test (when staging)

```bash
# 1. Suppress a known bouncer manually first to see the gate work
curl -X POST https://your-host/api/v1/suppressions \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"email": "test@example.com", "reason": "manual"}'

# 2. Trigger an actual bounce: send to a known-invalid Gmail address
curl -X POST https://your-host/api/v1/emails/send \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"from": "hello@your-domain", "to": "garbage-non-existent@gmail.com", "subject": "test", "html": "<p>x</p>"}'

# 3. Wait ~30s for the bounce DSN to arrive (needs SMTP_ENABLED=true and the
#    sending domain's MX pointing at BunMail: it comes back to b+...@your-domain)
docker compose logs app | grep "Bounce handled"
# → expect "bounceType":"hard","status":"5.1.1","escalated":false

# 4. Confirm the auto-suppression
curl https://your-host/api/v1/suppressions?email=garbage-non-existent@gmail.com \
  -H "Authorization: Bearer YOUR_KEY"

# 5. Confirm the email row shows bounced
curl 'https://your-host/api/v1/emails?status=bounced' \
  -H "Authorization: Bearer YOUR_KEY"
```
