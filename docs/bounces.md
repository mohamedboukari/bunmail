# Bounces Module

Parses Delivery Status Notifications (DSNs) that arrive at BunMail's inbound SMTP, links them back to the original outbound email, and feeds the **suppression list** ([docs/suppressions.md](suppressions.md)) so we stop sending to dead recipients.

Repeatedly sending to bouncing addresses is the **single fastest way to kill IP reputation**. Gmail / Yahoo / Outlook track sender bounce rates per-IP and per-domain; a few hundred sends to non-existent mailboxes is enough to start landing legitimate mail in spam. This module closes the loop.

## What is a bounce?

When BunMail's outbound SMTP delivers a message, the recipient's MX server **accepts the SMTP transaction** at handoff — that's why the email row's `status` becomes `sent`. The recipient's mail system then tries to land the message in the actual mailbox. If that fails (mailbox doesn't exist, full, blocked, etc.), the receiver sends a **Delivery Status Notification** back to the envelope sender.

The DSN arrives at our **inbound** SMTP server, which is why this module lives next to `smtp-receiver`.

## Parser strategies

Two paths, tried in order. Both are pure functions in [src/modules/bounces/services/bounce-parser.service.ts](../src/modules/bounces/services/bounce-parser.service.ts).

### 1. RFC 3464 (the standard)

Triggered when the message's `Content-Type` is `multipart/report; report-type=delivery-status`. We read the canonical headers from the `message/delivery-status` MIME part:

| Header | What we use it for |
|---|---|
| `Final-Recipient` | The recipient address that bounced |
| `Status` | Enhanced SMTP status code (`5.x.x` = hard, `4.x.x` = soft, `2.x.x` = ignored) |
| `Diagnostic-Code` | Human-readable reason — persisted on the suppression row |
| `Original-Message-ID` | Links the bounce back to the outbound `emails` row |

Modern Gmail / Outlook / Yahoo bounces all hit this path.

### 2. Fallback regex (non-RFC)

Older MTAs (qmail, Exim with old configs, custom mail servers) sometimes send plain-text bounce notices that don't follow RFC 3464. The fallback scrapes:

- Any enhanced (`5.1.1`) or basic (`550`) SMTP status code from the body
- The first `<user@host>` recipient in the **body** (not in headers — `Message-ID:` and `In-Reply-To:` headers also carry `<x@y>` and would otherwise win document order)
- An `In-Reply-To:` or embedded `Message-ID:` header to link back to the original

The fallback only runs when the message has obvious bounce markers — sender is `MAILER-DAEMON` or `postmaster`, subject mentions delivery failure, or content-type is `multipart/report`. This **`looksLikeBounce` gate** prevents normal customer reply mail that happens to contain a status-code-shaped string from being mis-classified.

## Linking back to the original email

We **require** an `originalMessageId` from the parser. Without it, we can't safely link the bounce to a specific tenant — and per #25's per-API-key suppression scoping, suppressing under the wrong key would be worse than dropping the bounce. The parser refuses to return a `ParsedBounce` without one, and the handler refuses to act if the lookup misses.

The lookup uses the `messageId` column on `emails`, set by nodemailer at send time. Both the wrapped (`<id@host>`) and unwrapped form are tried — different SMTP flavours include or strip the angle brackets.

## Bounce → suppression flow

When a bounce parses cleanly and links to an `emails` row, the handler does five things:

1. **Look up existing suppression** for `(api_key_id, recipient)`.
2. **Decide hard vs soft** with escalation:
   - Parsed kind `hard` → always `hard`.
   - Parsed kind `soft`, no existing suppression → `soft` (24h expiry).
   - Parsed kind `soft`, **existing soft suppression still active** → escalate to `hard` (permanent). Repeated transient failures are effectively permanent for IP-reputation purposes.
3. **Persist via `suppressionService.addFromBounce`**. Idempotent upsert — a re-bounce of the same recipient updates the existing row.
4. **Mark the original email row** — `status = 'bounced'`. The dashboard / `GET /emails?status=bounced` filter then shows it correctly.
5. **Fire `email.bounced` webhook** with the original email id, recipient, bounce type, status, diagnostic, and `suppressionId` (so receivers can cross-reference the auto-created suppression).

## Webhook payload

```json
{
  "event": "email.bounced",
  "timestamp": "2026-05-07T22:14:00.000Z",
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

## What we do **not** do

- **No `2.x.x` "delivered" reports** — those are positive confirmations and don't need handling.
- **No fuzzy linking when `Original-Message-ID` is missing** — would risk suppressing under the wrong API key. We log a warning and drop.
- **No retry of the original email** — by definition the recipient's MX accepted the SMTP transaction; retrying would just bounce again and double-tank reputation.
- **No DMARC `rua` / FBL complaint processing** — those are separate parsers (#41 and a future ticket).

## Status column mapping

| Status | Meaning |
|---|---|
| `queued` | Waiting for the queue processor |
| `sending` | Mid-SMTP-transaction |
| `sent` | SMTP transaction succeeded; recipient's MX accepted |
| `failed` | All retries exhausted; never reached an MX |
| `bounced` | Was `sent`, then a DSN came back. Set by this module |

## Testing

The parser is fully unit-testable in [test/unit/bounce-parser.test.ts](../test/unit/bounce-parser.test.ts) — 6 cases covering RFC 3464 hard / soft, 2.x.x delivered, missing Original-Message-ID, qmail-style fallback, and the negative case where normal customer reply mail mentions a status code.

The handler's orchestration is unit-testable via injected callbacks in [test/unit/bounce-handler.test.ts](../test/unit/bounce-handler.test.ts) — 5 cases covering hard, first soft, escalation on second soft, no double-escalation on already-hard, and drop-when-no-original.

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

# 3. Wait ~30s for the bounce DSN to arrive
docker compose logs app | grep "Bounce handled"
# → expect "bounceType":"hard","status":"5.1.1","escalated":false

# 4. Confirm the auto-suppression
curl https://your-host/api/v1/suppressions?email=garbage-non-existent@gmail.com \
  -H "Authorization: Bearer YOUR_KEY"

# 5. Confirm the email row shows bounced
curl 'https://your-host/api/v1/emails?status=bounced' \
  -H "Authorization: Bearer YOUR_KEY"
```
