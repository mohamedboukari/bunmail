# Self-Hosting Guide

How to deploy BunMail on your own server so emails are actually delivered.

## Requirements

- A VPS with **outbound port 25 open**
- A domain name you control (for DNS records)
- Docker + Docker Compose

## Recommended VPS Providers

Most cloud providers (AWS, GCP, Azure, Fly.io, Railway) **block port 25 by default**. Use a provider that allows SMTP traffic:

| Provider | Cheapest plan | Port 25 | Notes |
|----------|---------------|---------|-------|
| **RackNerd** | ~$11/year | Open by default | Best budget option, no ticket needed |
| **Hetzner** | €3.79/mo | Open by default | EU datacenters, great value |
| **OVH** | €3.50/mo | Open by default | EU + Canada |
| **Contabo** | €4.99/mo | Open by default | High specs for the price |
| **DigitalOcean** | $6/mo | Request needed | Usually approved same day |
| **Vultr** | $6/mo | Request needed | Usually approved same day |

> **Tip:** RackNerd offers ~$11/year VPS deals with port 25 open: check [racknerd.com/NewYear](https://www.racknerd.com/NewYear/) for current promotions.

## 1. Server Setup

```bash
# SSH into your server
ssh root@your-server-ip

# Install Docker on Ubuntu
apt update && apt install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt update && apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Verify Docker
docker --version && docker compose version
```

### Get the code

**Option A: Public repo (git clone):**

```bash
git clone https://github.com/your-username/bunmail.git
cd bunmail
```

**Option B: Private repo (rsync from your machine):**

```bash
# Run this from YOUR MACHINE, not the server
rsync -avz --exclude 'node_modules' --exclude '.git' --exclude '.env' \
  -e ssh ./bunmail/ root@your-server-ip:/root/bunmail/
```

### Configure environment

```bash
cd /root/bunmail
cp .env.example .env
nano .env
```

Set these values:

```env
BUNMAIL_ENV=production
DATABASE_URL=postgres://bunmail:bunmail@db:5432/bunmail
MAIL_HOSTNAME=mail.yourdomain.com
BUNMAIL_OWNER_EMAIL=you@yourdomain.com
DKIM_ENCRYPTION_KEY=run-openssl-rand-base64-32-to-generate
SMTP_ENABLED=true
SMTP_PORT=25
LOG_LEVEL=info
TRASH_RETENTION_DAYS=7
# Optional: days audit log entries are kept (#221), 30 to 3650, default 365
# AUDIT_LOG_RETENTION_DAYS=365
# Optional: hours an Idempotency-Key on the send API is remembered (#188),
# 1 to 168, default 24
# IDEMPOTENCY_KEY_TTL_HOURS=24
# Optional: most attachment bytes per email, decoded (#181), MB of 1,000,000
# bytes, 1 to 18, default 5
# ATTACHMENTS_MAX_TOTAL_MB=5
# Optional: scheduled DNS re-verification of domains (#250), on by default;
# hours between checks of a passing domain, 6 to 168, default 24
# DOMAIN_REVERIFY_ENABLED=true
# DOMAIN_REVERIFY_INTERVAL_HOURS=24
# Optional: also refuse addresses any API key hard-bounced or got a complaint
# for (#250), default false
# SUPPRESSIONS_SHARED_HARD=false
# Optional: daily DNSBL self-check of the sending IPs (#250), on by default
# SENDING_IP_DNSBL_CHECK=true
# Optional: send daily SMTP TLS reports (RFC 8460) to recipient domains that
# publish a _smtp._tls record (#345), off by default. Needs a contact address
# (TLSRPT_CONTACT_EMAIL, else SYSTEM_MAIL_FROM); mail reports go out from
# SYSTEM_MAIL_FROM. Organization name defaults to the contact's domain.
# TLSRPT_ENABLED=true
# TLSRPT_CONTACT_EMAIL=tls-reports@yourdomain.com
# TLSRPT_ORGANIZATION_NAME=Your Company
# Most report deliveries a day, all replicas together (1 to 100000, default 500)
# TLSRPT_MAX_REPORTS_PER_DAY=500
# Most reports one mail address or HTTPS origin gets a day (1 to 1000, default 50)
# TLSRPT_MAX_REPORTS_PER_DESTINATION_PER_DAY=50
# Number of trusted reverse-proxy hops: set to 1 when BunMail runs behind a
# single proxy (see section 6) so dashboard login rate limiting (#109) keys off
# the real client IP instead of the proxy's. Default 0 (raw socket IP).
DASHBOARD_TRUSTED_PROXY_HOPS=1
# Optional: public base URL, used for the dashboard link in inbound notifications,
# the one-time owner setup link, invitation links and password reset links
APP_BASE_URL=https://mail.yourdomain.com
# Optional: sender of invitation emails and new-device sign-in alerts (a
# DKIM-verified domain registered in BunMail); unset = the inviter copies the
# link from the dashboard and new-device sign-ins are only logged
SYSTEM_MAIL_FROM=noreply@yourdomain.com
# Optional: days an invitation link stays valid (1 to 90, default 7)
INVITE_EXPIRY_DAYS=7
# Optional: require two-factor authentication (#220): none (default), owner,
# or admin (admins and the owner)
# REQUIRE_2FA=owner
# Optional: inbound notifications (per-domain notify_email is the opt-in)
INBOUND_NOTIFY_ENABLED=true
INBOUND_NOTIFY_FROM_LOCAL=notifications
# Optional: add the original subject and a preview (links removed) to the
# notification body; default false, only true or false
# INBOUND_NOTIFY_PREVIEW=true
# Optional: approximate location on the Active sessions page (#281), off when
# unset. Offline DB-IP Lite / GeoLite2 .mmdb file (see section 5):
# GEOIP_DB_PATH=/geoip/dbip-city-lite-2026-10.mmdb
```

> `MAIL_HOSTNAME` is **required in production** (#242): it is the SMTP EHLO name and the Message-ID domain of every email. BunMail refuses to start if it is unset, `localhost`, an IP address, not fully qualified, or a placeholder (`*.example.com`, `*.yourdomain.com`, `.test`, `.local`). Use this server's real hostname, whose A record points at the server and which the sending IP's PTR resolves to (see the reverse DNS section below).

> `BUNMAIL_OWNER_EMAIL` is **required in production** (#215): the email address of the dashboard owner account. BunMail refuses to start if it is unset, and refuses a malformed address or one over 254 characters in every environment (development only warns and skips the owner bootstrap when it is unset). It is stored lowercased. On first boot BunMail creates the owner and logs a one-time setup link (see [Claim the owner account](#claim-the-owner-account)). While setup is pending, a changed value updates the stored owner email on the next boot. After setup the database is the source of truth: changing the variable later only logs a warning. This account is the only way into the dashboard (#216): with the variable unset, development has no dashboard login and logs a warning at boot.

> Generate a DKIM encryption key: `openssl rand -base64 32`. **Required**: boot fails with a clear error if missing or not 32 bytes after base64 decode. Encrypts every domain's DKIM private key (#23) and every webhook signing secret (#259) at rest with AES-256-GCM. See [SECURITY.md](../SECURITY.md#dkim-private-key-encryption-at-rest) for the format and rotation procedure.

> `TRASH_RETENTION_DAYS`: how long soft-deleted emails (outbound and inbound) stay in trash before being permanently purged. Default `7`.

> `AUDIT_LOG_RETENTION_DAYS`: how long entries of the audit log (#221: sign-ins, account, two-factor, API key, domain, webhook and suppression changes, read on the dashboard's **Audit log** page by admins and the owner) are kept before the purge worker deletes them. Default `365`; a whole number from `30` to `3650`, anything else refuses to boot. Entries cannot be edited, even through SQL from the app's connection (a database trigger refuses any `UPDATE`); they are not shipped anywhere, so back the database up if you need them beyond the host. See [docs/audit-log.md](audit-log.md).

> `APP_BASE_URL`: public base URL of this instance (no trailing slash). Used to build the "view in dashboard" link in inbound notification emails (leave unset to omit it), the owner setup link logged on first boot, invitation links (#217), admin-issued password reset links (#277) and, when it is an `https://` URL, the per-recipient one-click unsubscribe link `/u/<token>` in single-recipient mail (#249, see [suppressions.md](suppressions.md#one-click-unsubscribe)): that path must be publicly reachable, unauthenticated, through your reverse proxy. When unset, the setup and reset links fall back to `http://localhost:PORT`, which you can still open through an SSH tunnel; invitation links would too, so without a usable `APP_BASE_URL` BunMail never emails an invitation and shows the link to the inviter instead: set it before inviting anyone. Passkeys (#223) are bound to it: its hostname is the WebAuthn RP ID and its origin the only origin a passkey ceremony may come from, so it must be the exact `https://` address users open the dashboard on; unset (or plain `http://` other than `localhost`) turns passkeys off, and changing the hostname later orphans every registered passkey.

> `SSO_PROVIDERS` and `SSO_<ID>_*` (#224): OpenID Connect providers for single sign-on (an account links its identity on Account > Sign-in methods, then signs in with "Sign in with `<label>`"; see [Single sign-on](#single-sign-on-224) below), unset by default (SSO off). `SSO_PROVIDERS` lists ids (lowercase letters, digits and `-`, 1 to 32 each, comma-separated); per id (upper-cased, `-` as `_`): `SSO_<ID>_ISSUER` (required, the exact issuer URL, `https://`, plain `http://` only on a loopback host; optional for the presets `google` and `gitlab`), `SSO_<ID>_CLIENT_ID` and `SSO_<ID>_CLIENT_SECRET` (the switch: a provider appears only when both are set; listed with neither it is skipped with a boot warning, with one of the two the server refuses to boot; the presets are enabled by them even when not listed; the secret is never logged), `SSO_<ID>_LABEL` (default: `Google` or `GitLab` for a preset, else the id), `SSO_<ID>_SCOPES` (default `openid email profile`, must include `openid`), `SSO_<ID>_ALLOWED_DOMAINS` (optional) and `SSO_<ID>_AUTO_LINK` (default `false`; `true` needs allowed domains, is refused for a Microsoft Entra issuer, and links a user's first SSO sign-in to the member with the same verified email, never the owner, an admin or an account with 2FA; see [Single sign-on](#single-sign-on-224)). Any malformed value refuses to boot. SSO also needs an `https://` `APP_BASE_URL` (plain `http://` only for localhost): otherwise it stays off with one boot warning. The redirect URI to register at the provider is `<APP_BASE_URL>/dashboard/login/sso/<id>/callback`. BunMail fetches the provider's discovery document itself, without the SSRF guard (a private Keycloak on your LAN works). See [docs/users.md](users.md#single-sign-on-224).

> `SYSTEM_MAIL_FROM` / `INVITE_EXPIRY_DAYS`: dashboard invitations (#217). Admins and the owner invite teammates from the dashboard (**Invite teammates** on the home page). When `SYSTEM_MAIL_FROM` is set to an address on a domain you registered in BunMail and whose DKIM record is verified, BunMail emails the accept link from it, signed with that domain's key. When it is unset, or the domain is missing or unverified, or the send fails, the invitation is still created and the inviter sees the link once on the Invitations page to send by hand (share it privately: anyone with it can create the account). A malformed `SYSTEM_MAIL_FROM` refuses to boot. `INVITE_EXPIRY_DAYS` (default `7`, a whole number from `1` to `90`, anything else refuses to boot) sets how long a link stays valid. See [docs/dashboard.md](dashboard.md#invitations-217). The same sender also sends **new-device sign-in alerts** (#282): when an account signs in (with its password, a passkey or single sign-on) from a browser it has not used in the last 30 days, it gets "New sign-in to your BunMail account" (browser and OS, IP, approximate location, time, and what to do; no links). Without a usable `SYSTEM_MAIL_FROM` no alert is sent and the sign-in is only logged (`New-device sign-in`). See [docs/dashboard.md](dashboard.md#new-device-alerts-282).

> `INBOUND_NOTIFY_ENABLED` / `INBOUND_NOTIFY_FROM_LOCAL`: inbound notifications (#106). When a domain has a `notify_email` set, received mail for it triggers a summary email from `<INBOUND_NOTIFY_FROM_LOCAL>@<domain>` (default `notifications`). `INBOUND_NOTIFY_ENABLED=false` is a global kill switch. The notification is signed by your domain, so it carries no content of the inbound message (#250): its subject is `New email for <recipient address>` and its plain-text body names the sender, the arrival time, the size and, with `APP_BASE_URL` set, the dashboard link. `INBOUND_NOTIFY_PREVIEW=true` (default `false`; only `true` or `false`, anything else refuses to boot) adds the original subject and a 200-character preview to the body, with every `http://`, `https://` and `www.` link replaced by `[link removed]`. Automatic inbound mail (auto-replies, bulk and list mail, a null return path) is not notified, and each recipient address gets at most 5 notifications per 10 minutes and each domain at most 30, counted in memory per replica; the address's next notification reports how many were skipped. See [docs/inbound.md](inbound.md#inbound-notifications-106).

> `DASHBOARD_TRUSTED_PROXY_HOPS`: the dashboard login throttle (#109) rate-limits failed logins per client IP. Behind a reverse proxy (section 6) the socket IP is the proxy's, so set this to the number of trusted proxy hops (`1` for a single nginx/Caddy/Cloudflare): BunMail then reads the real client from the Nth-from-right `X-Forwarded-For` entry. Leave at `0` only if BunMail is exposed directly. **Make sure the origin is reachable only through the proxy** (don't expose `:3000`), otherwise `X-Forwarded-For` can be forged. Tune the limits with `DASHBOARD_LOGIN_RATE_LIMIT_MAX` (default `5`, 1 to 100) and `DASHBOARD_LOGIN_RATE_LIMIT_WINDOW` (seconds, default `900`, 60 to 86400); a value outside those bounds, or not a whole number, refuses to start (#220). Two-factor code checks keep their own fixed budget (5 per 15 minutes). See [docs/dashboard.md](dashboard.md#brute-force-protection-109).

> `API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW`: per-API-key request limit on the REST API (default `100` requests per `60` seconds, then `429` with `Retry-After`). Raise it if one key legitimately makes more calls than that, for example a high-volume sender. Boot fails on a non-positive or non-integer value.

> `MAIL_ALLOW_PRIVATE_MX`: by default BunMail refuses to deliver to an MX host that resolves to a private, loopback or link-local address, since recipient domains (and their MX records) are chosen by API callers. Set `true` only if you deliberately deliver to an internal mail server.

> `REQUIRE_VERIFIED_DOMAIN`: refuse sends from a sender domain whose DKIM record is not verified (#245). Default `false`: the email is queued and `POST /api/v1/emails/send` returns `warnings` (`dkim_unverified`, `spf_unverified`, `dmarc_unverified`), the dashboard flash names them, and SMTP submission logs them. With `true`, a registered domain whose stored DKIM flag is false is re-verified in DNS once before the send (a failure is remembered for 5 minutes per domain, so retries do not query DNS each time; running **Verify** on the domain takes effect at once), then refused with `422 SENDER_DOMAIN_UNVERIFIED` (SMTP `550`); an unregistered domain is refused in every environment. SPF and DMARC only warn. Only `true` or `false`; anything else refuses to boot.

> `DOMAIN_REVERIFY_ENABLED` / `DOMAIN_REVERIFY_INTERVAL_HOURS` (#250): a background loop re-checks every domain's SPF, DKIM and DMARC records, so a record removed or changed after verification is noticed. A passing domain is checked again every `DOMAIN_REVERIFY_INTERVAL_HOURS` (default `24`, 6 to 168, plus or minus an hour), a failing or inconclusive one after an hour. A failed lookup (SERVFAIL, timeout) never counts; two definitive failures in a row flip a verified domain to failing: `verifiedAt` is cleared, the failing flags are cleared (with `REQUIRE_VERIFIED_DOMAIN=true` and DKIM failing, its sends are then refused) and `domain.verification_failed` fires to admin keys' webhooks. Several replicas share the work safely. `DOMAIN_REVERIFY_ENABLED=false` (default `true`) turns the loop off: domains are then only checked by **Verify** and the inline check of `REQUIRE_VERIFIED_DOMAIN`. Only `true` or `false`, and only a whole number in range; anything else refuses to boot. See [domains.md](domains.md#scheduled-re-verification-250).

> `MAIL_PUBLIC_IP` (#247, #248): the public IPs this server sends from, comma-separated. Optional: unset, BunMail uses the A/AAAA records of `MAIL_HOSTNAME`. SPF verification checks that the domain authorizes these addresses, and every boot logs whether their PTR records name `MAIL_HOSTNAME` and resolve back (`Reverse DNS confirmed for every sending IP`, or a `warn` with the fix). Behind NAT the container can't see its egress address: set this to the real one.

> `SENDING_IP_DNSBL_CHECK` (#250): about a minute after boot, then every 24 hours, BunMail looks up each sending IP on three blocklists and shows the result on the dashboard home (**Blocklists** card); see [Blocklists](#blocklists-dnsbl-self-check-250) below. Default `true` (a few DNS lookups a day). `false` turns it off. Only `true` or `false`; anything else refuses to boot.

> `TLSRPT_ENABLED` / `TLSRPT_CONTACT_EMAIL` / `TLSRPT_ORGANIZATION_NAME` (#345): with `TLSRPT_ENABLED=true`, BunMail records how its TLS sessions to each recipient domain went and, once a day, sends a TLS report (RFC 8460) to every domain that publishes a `_smtp._tls` TXT record (Gmail, Outlook and Yahoo do), by HTTPS POST or by mail, as the record asks. Default `false`: no lookups, no recording, no job. The contact address (`TLSRPT_CONTACT_EMAIL`, else `SYSTEM_MAIL_FROM`) goes into each report and its domain is the submitter; with TLS-RPT on and neither set, BunMail refuses to boot. Mail reports are sent from `SYSTEM_MAIL_FROM` and only DKIM-signed, so its domain must be registered and DKIM-verified; otherwise `mailto:` addresses are skipped with a warning. `TLSRPT_ORGANIZATION_NAME` (1 to 100 printable characters) defaults to the contact's domain. `TLSRPT_MAX_REPORTS_PER_DAY` (1 to 100000, default 500) caps report deliveries per UTC day across every replica: past it, the remaining reports are deferred to the next day (never sent in a burst, still within the 7-day retention) and one `TLS report daily cap reached` warning is logged; raise it if that warning shows up for legitimate traffic. `TLSRPT_MAX_REPORTS_PER_DESTINATION_PER_DAY` (1 to 1000, default 50; high enough for shared report collectors that receive many domains' reports on one HTTPS origin) caps the reports one mail address or one HTTPS origin gets per day, so many domains cannot aim BunMail's reports at one third party; if your recipients share a reporting service, raise it (a held-back report waits for the next day). Reporting addresses on the suppression list (any API key) get no report. Only `true` or `false` for the switch; anything malformed refuses to boot. See [tls-rpt.md](tls-rpt.md).

> `MAIL_MX_CONCURRENCY` / `MAIL_MX_RATE_PER_MIN` (#91, #250): outbound throttling per **provider bucket**: every Microsoft MX (`*.outlook.com`) is one bucket, every Google MX (`*.google.com`, `*.googlemail.com`) another, likewise Yahoo (`*.yahoodns.net`) and Apple (`*.icloud.com`), and any other MX counts as its registrable domain. `MAIL_MX_CONCURRENCY` (default `1`) is the number of parallel SMTP sessions per bucket. `MAIL_MX_RATE_PER_MIN` is optional (unset: no budget; a whole number from 1 to 100000, anything else refuses to boot): at most that many messages per minute per bucket, as a token bucket. A message over it is deferred, not failed: its email goes back to `queued` until a token is due, without counting an attempt, recording an error or firing a webhook. With `REDIS_URL` set, both hold across every replica (set the same values on each; see [Running several replicas](#running-several-replicas)); without it they are per replica, so N replicas allow N times them. See [docs/emails.md](emails.md#throttle-provider-buckets-and-rate-budget-250).

> `MAIL_IP_FAMILY` (#250): the address family outbound SMTP prefers, `4` (default) or `6`; anything else refuses to boot. With `4`, an MX host is reached over IPv4 whenever it has an IPv4 address, over IPv6 only when it has none; `6` is the mirror. Prefer `6` only when your IPv6 address has a matching PTR record and is authorized by SPF: Gmail in particular is stricter about IPv6 senders.

> **Sending from one specific address.** BunMail cannot pick its outbound source address itself: Bun 1.3.14 ignores `localAddress` on outbound sockets, so there is no `MAIL_SOURCE_IP` setting. On a host with several addresses, choose the source in the network layer: run the container with `network_mode: host` and set the host's default route source (`ip route change default via <gateway> src <address>`), or keep the bridge network and add an SNAT rule for port 25 (`iptables -t nat -I POSTROUTING -p tcp --dport 25 -s <docker subnet> -j SNAT --to-source <address>`). Then set `MAIL_PUBLIC_IP` to that same address, so the SPF guidance and the reverse DNS (FCrDNS) check at boot describe the address receivers actually see, and give it a PTR record naming `MAIL_HOSTNAME`.

> `MAIL_RETRY_MAX_AGE_HOURS`: how long an email that keeps failing temporarily (4xx replies such as greylisting or rate limits, connection errors) is retried before it is marked `failed`. Default `48`. Retries back off: 5 m, 15 m, 30 m, 1 h, 2 h, then every 4 h. A recipient whose last reply was `4.2.2` (mailbox full) when the window ends gets a 24-hour soft suppression and a soft `email.bounced` (#250); every other temporary failure gets neither.

> `SUPPRESSIONS_SHARED_HARD` (#250): every API key sends from the same IP and DKIM domains, so one key's bad list damages delivery for all of them. With `true`, a send (REST, dashboard, SMTP submission, and the queue's re-check before a retry) is also refused when **any** key holds a permanent hard-bounce suppression or a feedback-loop complaint for the address. Unsubscribes, manual entries and temporary rows stay per key (they are the tenant's own decision). The refusal is the usual `422 RECIPIENT_SUPPRESSED` (SMTP `550`) with `suppressionId: null`: it never names the other key or its row, and each key's suppression list still shows only its own rows. Default `false`. Only `true` or `false`; anything else refuses to boot. See [suppressions.md](suppressions.md#shared-hard-suppressions-suppressions_shared_hard-250).

> `QUEUE_BATCH_SIZE` / `QUEUE_POLL_INTERVAL_MS` / `QUEUE_MAX_CONCURRENT_SENDS`: send queue throughput (#176). Every `QUEUE_POLL_INTERVAL_MS` (default `2000`, 250 to 60000, with +/-10% jitter) the queue claims up to `QUEUE_BATCH_SIZE` due emails (default `5`, 1 to 100), but never more than the free slots under `QUEUE_MAX_CONCURRENT_SENDS` (default `10`, 1 to 500), the cap on sends in flight per process. A slow receiver holds its slot instead of making the queue open more connections; sends waiting for a busy provider bucket (`MAIL_MX_CONCURRENCY`) hold theirs too. Raise the cap for high volume to many different domains; mind your IP reputation. Any other value refuses to boot. Each batch is shared across API keys round-robin (#258), so one key's backlog cannot delay another key's mail.

> `IDEMPOTENCY_KEY_TTL_HOURS` (#188): how long an `Idempotency-Key` sent on `POST /api/v1/emails/send` is remembered (default `24`, 1 to 168). Within it, a retry with the same key and body returns the first response (with `Idempotent-Replayed: true`) instead of sending again; after it, the key is reusable. Each key keeps a snapshot of its first response for this long, without message content (no subject, body, custom headers or attachment files: ids, addresses, status, warnings and attachment metadata only), so the storage overhead is small; a replay after the email is trashed or purged returns the original ids and status with the content fields `null`. The purge worker deletes expired keys every 6 hours. Anything else refuses to boot.

> `ATTACHMENTS_MAX_TOTAL_MB` (#181): the most attachment bytes one email may carry once decoded, which is also the most one file may have (default `5`, a whole number from 1 to 18, MB of 1,000,000 bytes; anything else refuses to boot). 18 MB keeps the encoded message under the 25 MB most receivers accept. The HTTP body limit follows it (12 MiB plus the base64 of the budget plus 64 KiB: about 19.3 MB at the default, 36.6 MB at 18), and so does the SMTP submission size limit (about 17.4 MB, 35.2 MB at 18). If a reverse proxy sits in front of BunMail, raise its body limit to match (nginx `client_max_body_size`). Files are stored in Postgres (`email_attachments`) only until the email is sent, fails or bounces, so they cost database space while emails are queued or retrying: up to the budget per queued email. For larger files, upload them to your own storage and send a link.

> `WEBHOOKS_MAX_PER_API_KEY` / `WEBHOOK_DELIVERY_RETENTION_DAYS` (#258): per-key webhook limits. A key may have at most `WEBHOOKS_MAX_PER_API_KEY` webhooks (default `10`, 1 to 100); one more is refused with `422 WEBHOOK_LIMIT_REACHED`, and webhooks already over a lowered cap are kept. Finished webhook deliveries (`delivered` and `failed`) are deleted by the hourly cleanup once their last change is older than `WEBHOOK_DELIVERY_RETENTION_DAYS` (default `30`, 1 to 365); `failed` rows used to be kept forever, so raise it if you rely on them for forensics. Pending deliveries are never deleted. Any other value refuses to boot. Replays are limited to 5 per delivery per hour (not configurable; in memory, per replica).

> **Other settings** (defaults in brackets; full descriptions in [.env.example](../.env.example)):
> - `HOST` (`0.0.0.0`) and `PORT` (`3000`): the HTTP bind address and port.
> - `DASHBOARD_LOGIN_RATE_LIMIT_ENABLED` (`true`): `false` turns the login throttle off.
> - `LOG_LEVEL` (`info`; `debug`, `info`, `warn` or `error`, anything else refuses to boot) and `LOG_REDACT_PII` (`true` in production, `false` in development). See [docs/logging.md](logging.md).
> - `METRICS_TOKEN` (unset: `/metrics` is a 404): the bearer token Prometheus scrapers send to `GET /metrics` (#362); 32 to 256 letters, digits, `-` or `_` with at least 8 distinct characters, anything else refuses to boot. See [docs/metrics.md](metrics.md).
> - `REDIS_URL` (unset: in memory, one replica): Redis or Valkey for the state several replicas share (#185), a `redis://` or `rediss://` URL with a host, optional `user:password@` and `/db`; anything else refuses to boot, and the password is never logged. Use one Redis, or one Redis database, per BunMail install. `rediss://` verifies the server certificate. See [Running several replicas](#running-several-replicas).
> - OpenTelemetry tracing (#363, off by default; see [docs/tracing.md](tracing.md)): `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (unset; an http(s) URL turns tracing on, OTLP/HTTP protobuf), `OTEL_TRACES_EXPORTER` (unset; `otlp` or `none`), `OTEL_SDK_DISABLED` (`false`), `OTEL_SERVICE_NAME` (`bunmail`), `OTEL_TRACES_SAMPLER` (`parentbased_always_on`) and `OTEL_TRACES_SAMPLER_ARG` (`1`, 0 to 1); anything malformed refuses to boot. The exporter reads `OTEL_EXPORTER_OTLP_HEADERS`, timeout, compression and certificates itself. An incoming `traceparent` is honoured only through the trusted proxies (`DASHBOARD_TRUSTED_PROXY_HOPS` of 1 or more).
> - `TOMBSTONE_RETENTION_DAYS` (`90`): how long the post-purge snapshot of a hard-deleted email is kept (#34, see [emails.md](emails.md#tombstones-34)).
> - `WEBHOOK_ALLOW_INSECURE_HTTP` (`false`): `true` also allows `http://` webhook URLs; private addresses stay blocked (#128).
> - Inbound SMTP (see [docs/inbound.md](inbound.md)): `SMTP_ENABLED` (`false`), `SMTP_PORT` (`2525`; use `25` in production), `SMTP_DNSBL_ENABLED` (`true`), `SMTP_DNSBL_ZONE` (`zen.spamhaus.org`), `SMTP_RECIPIENT_VALIDATION` (`true`), `SMTP_RATE_LIMIT_ENABLED` / `SMTP_RATE_LIMIT_MAX` / `SMTP_RATE_LIMIT_WINDOW` (`true`, `10` connections per `60` seconds per IP; ENABLED `true` or `false`, MAX 1 to 100000, WINDOW 1 to 86400 seconds, anything else such as `0` or `TRUE` refuses to boot, #185).
> - SMTP submission (#120, see [docs/smtp-submission.md](smtp-submission.md)): `SMTP_SUBMISSION_ENABLED` (`false`), `SMTP_SUBMISSION_PORT` (`465` with a TLS cert, `587` without), `SMTP_SUBMISSION_DAILY_QUOTA` (`0`: unlimited), `SMTP_SUBMISSION_TLS_CERT` / `SMTP_SUBMISSION_TLS_KEY` (unset; set both for implicit TLS, #349), `SMTP_SUBMISSION_TLS_MODE` (`implicit` with a cert; `starttls` refuses to boot on Bun, anything else refuses to boot), `SMTP_SUBMISSION_ALLOW_INSECURE` (`false`: with neither TLS nor this flag the server refuses to start; ignored with TLS), `SMTP_SUBMISSION_RATE_LIMIT_ENABLED` / `_MAX` / `_WINDOW` (`true`, `30` connections per `60` seconds per IP; MAX 1 to 100000, WINDOW 1 to 86400 seconds), `SMTP_SUBMISSION_AUTH_RATE_LIMIT_ENABLED` / `_MAX` / `_WINDOW` (`true`, `10` failed AUTHs per `900` seconds per IP; MAX 1 to 10000, WINDOW 1 to 86400 seconds). The `_ENABLED` switches take `true` or `false`. For these limits anything else, such as `0`, a decimal, `TRUE` or a typo, refuses to boot (#185).

## 2. DNS Records

Add these DNS records for `yourdomain.com` in your domain registrar (Cloudflare, Namecheap, etc.). Once the domain is registered (step 4), its dashboard page lists the exact records for it, with this server's `MAIL_HOSTNAME` and `MAIL_PUBLIC_IP` filled in, and the API returns them as `dnsRecords` (#250).

### A Record (points your mail subdomain to the server)

| Type | Host   | Value            |
|------|--------|------------------|
| A    | `mail` | `YOUR_SERVER_IP` |

### MX Record (optional: where other servers deliver mail for the domain)

| Type | Host | Value                  | Priority |
|------|------|------------------------|----------|
| MX   | `@`  | `mail.yourdomain.com`  | 10       |

Needed only for BunMail to receive bounces, DMARC reports and inbound mail for the domain (`SMTP_ENABLED=true`). Sending works without it. If the domain's mail is hosted elsewhere (Google Workspace, Microsoft 365), keep that MX: replacing it moves the domain's mailboxes to BunMail. The domain page shows where the MX points and which of these flows are active (#250).

### SPF Record (authorizes your server to send email for this domain)

| Type | Host | Value                                    |
|------|------|------------------------------------------|
| TXT  | `@`  | `v=spf1 a:mail.yourdomain.com -all`      |

`a:mail.yourdomain.com` authorizes the addresses your `MAIL_HOSTNAME` resolves to (the same name its PTR record must carry). If the domain already has an SPF record (Google Workspace, Microsoft 365, ...), add the `a:` term to it: a domain must publish exactly one SPF record. The dashboard's domain page shows the exact record and **Verify** evaluates it for this server's sending IPs (#247).

### DMARC Record (tells receivers what to do with unauthenticated mail)

| Type | Host     | Value                                                  |
|------|----------|--------------------------------------------------------|
| TXT  | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com`    |

Start at `p=none`, which only collects reports, and move to `p=quarantine`, then `p=reject`, once the reports show your mail passes. BunMail stores the reports itself when inbound SMTP is on and the MX points at it; otherwise send them to an address you read. Publish exactly one DMARC record. **Verify** requires exactly one `v=DMARC1` record with a valid `p=` (a subdomain may inherit its parent domain's record) and shows the parsed policy (#250).

### DKIM Record (added after registering your domain in BunMail, see step 4)

| Type | Host                 | Value                    |
|------|----------------------|--------------------------|
| TXT  | `bunmail._domainkey` | `v=DKIM1; k=rsa; p=...`  |

A 2048-bit key is longer than the 255 characters one TXT string holds: the domain page shows it split into quoted strings to paste as they are; providers that take one long value split it themselves. `bunmail` is the default selector: pass `dkimSelector` when registering the domain to use another one, and replace a key later without downtime with a DKIM key rotation (#250, see [domains.md](domains.md#key-rotation-250)).

### PTR Record (Reverse DNS)

Contact your VPS provider to set the PTR record for your server IP to `mail.yourdomain.com`. This is critical for deliverability, without it, many mail servers will reject your emails.

## 3. Start BunMail

```bash
cd /root/bunmail
docker compose up -d --build
```

This starts:
- **BunMail** on `127.0.0.1:$PORT` (HTTP API + Dashboard, default 3000): loopback only, behind the reverse proxy of section 6 (#205)
- **PostgreSQL** on the compose network only, nothing published

**Host-specific ports and mounts go in `docker-compose.override.yml`** (#205), which is not tracked by git, so `git pull` never conflicts with them. Start from the example: `cp docker-compose.override.example.yml docker-compose.override.yml`, then keep only what this host needs: inbound SMTP on 25 (`SMTP_ENABLED=true`), SMTP submission, the TLS mount, or (not recommended) the app on all interfaces without a proxy. The example's first block publishes Postgres on `127.0.0.1:5432` for local development; drop it on a server.

Port mappings in `docker-compose.yml` read `PORT` and `SMTP_PORT` from `.env` automatically, if you change them in `.env`, you don't need to edit anything else.

> **Docker-published ports bypass UFW.** Docker inserts its own iptables rules ahead of UFW's, so a port published on `0.0.0.0` is reachable from the internet even with `ufw default deny incoming`. Only publish what must be public (25, 587) on all interfaces; bind everything else to `127.0.0.1`. Check with `ss -ltnp` (5432 must not show `0.0.0.0` or `*`). Before #209 the override published Postgres on `0.0.0.0:5432`.

Migrations run automatically on boot. Verify with:

```bash
# Check containers are running
docker compose ps

# Check logs
docker compose logs app

# Check health (use your PORT value)
curl http://localhost:${PORT:-3000}/health
```

## 4. Initial Setup

### Claim the owner account

On first boot BunMail creates the owner account for `BUNMAIL_OWNER_EMAIL` and logs a one-time setup link at `warn` level (at `error` when `LOG_LEVEL=error`, so no log level hides it):

```bash
docker compose logs app | grep 'Owner setup link'
```

Open the link and choose the owner password (15 to 256 characters, confirmed twice). The link is valid for 24 hours and works once. Until the password is set, every restart logs a new link and the previous one stops working, so **use the most recent link** (with several replicas, only the last one logged works). Anyone who can read these logs can claim the account first, so do this right after the first deploy.

After setup you are signed in to the dashboard (redirected to `/dashboard`); from then on you sign in at `/dashboard/login` with `BUNMAIL_OWNER_EMAIL` and that password. If the link expired or got lost before setup, restart the container (a restart logs a new link only while setup is pending) or print a fresh one:

```bash
docker compose exec app bun run src/db/reset-owner.ts
```

The script prints the link to your terminal (not to `docker compose logs`) and revokes every earlier link. It also works after setup, as a password reset and a kill switch: it signs the owner out of every dashboard session at once (#216). The stored owner password stays in place until the new link is completed, so it still signs in until then; completing the link signs every session out again. If `BUNMAIL_OWNER_EMAIL` differs from the stored owner, the script warns and keeps the stored address. It exits `1` when there is no owner and `BUNMAIL_OWNER_EMAIL` is unset.

To hand the instance over, the owner transfers ownership to an active admin from **Users** in the dashboard (#218, confirmed with the owner's password); the previous owner becomes an admin. Then set `BUNMAIL_OWNER_EMAIL` to the new owner's address: until you do, every boot logs that it differs from the stored owner (it never changes anything), and `reset-owner` always acts on the current owner.

### Seed your first API key

```bash
docker compose exec app bun run src/db/seed.ts
```

**Save the key from the output: it's shown once!** It is printed to the terminal only, never to the logs.

### Register your domain (generates DKIM keys)

```bash
curl -X POST http://localhost:3000/api/v1/domains \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "yourdomain.com"}'
```

The response includes `dkimDnsRecord`: add it as a TXT record in your DNS:

| Type | Host                 | Value (from response)    |
|------|----------------------|--------------------------|
| TXT  | `bunmail._domainkey` | `v=DKIM1; k=rsa; p=...`  |

A 2048-bit key is longer than the 255 characters one TXT string holds: the domain page shows it split into quoted strings to paste as they are; providers that take one long value split it themselves.

### Verify DNS records

Wait ~5 minutes for DNS propagation, then:

```bash
curl -X POST http://localhost:3000/api/v1/domains/DOMAIN_ID/verify \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Send a test email

```bash
curl -X POST http://localhost:3000/api/v1/emails/send \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "hello@yourdomain.com",
    "to": "you@gmail.com",
    "subject": "BunMail works!",
    "html": "<h1>Hello from BunMail</h1>"
  }'
```

Check your inbox (and spam folder). Check the email status:

```bash
curl -s http://localhost:3000/api/v1/emails \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## 5. Dashboard

Open `https://mail.yourdomain.com/dashboard` (through the reverse proxy of section 6) and sign in with the owner email and the password you chose at [Claim the owner account](#claim-the-owner-account). Every failed login shows the same `Invalid email or password.`, whatever the cause.

> **HTTPS in production.** With `BUNMAIL_ENV=production` the session cookie is `Secure`, so browsers only keep it over HTTPS (most browsers also accept it on `http://localhost`, for example through an SSH tunnel: `ssh -L 3000:localhost:3000 root@your-server-ip`). Over plain `http://YOUR_SERVER_IP:3000` the sign-in does not stick.

Sessions (#216) live in the database: a session expires after 24 hours without use and 7 days after sign-in at the latest, **Log out** ends it on the server, and `reset-owner` signs the owner out everywhere. While you use the dashboard, the session cookie is replaced with a fresh one about once a minute; if an old cookie shows up again later, BunMail treats it as stolen and signs the account out of every session (details in [docs/dashboard.md](dashboard.md#auth-flow)).

The dashboard lets you manage emails, domains, templates, webhooks, API keys and suppressions, and view delivery status. Admins and the owner invite teammates at **Invitations** and manage accounts at **Users** (roles, deactivation, password reset links, ownership transfer); see [docs/dashboard.md](dashboard.md).

Every account sees its own signed-in devices at **Active sessions** (#281, in the Account group of the sidebar): browser and system, IP address, signed in at, last active, and, when you set up GeoIP below, an approximate location. A user can sign out one device or every other device from there. With `SYSTEM_MAIL_FROM` set, a sign-in (password, passkey or single sign-on) from a browser the account has not used in the last 30 days also emails the account an alert (#282); BunMail recognizes the browser by a long-lived `bm_device` cookie, so a changing IP does not count as a new device.

### Two-factor authentication (#220)

Every account can turn on two-factor authentication at **Two-factor** (Account group of the sidebar): scan the QR code with an authenticator app (Aegis, 2FAS, Google Authenticator, 1Password, Bitwarden and the like), enter its 6-digit code, and keep the ten recovery codes shown once. From then on, signing in asks for a code from the app after the password. **Turn it on for the owner account**: the owner can do everything, and a leaked password alone is then not enough.

`REQUIRE_2FA` makes it mandatory: `owner` for the owner, `admin` for admins and the owner (default `none`). An account it covers without 2FA is sent to its Two-factor page on every request until it enrols, so nobody is locked out, but enable 2FA on those accounts first if you want a smooth switch. Anything but `none`, `owner` or `admin` refuses to start.

Turning it on asks for the current password. With `SYSTEM_MAIL_FROM` set, the account gets an email (no links) when 2FA is turned on or off, its recovery codes are replaced, a reset removes it, or someone passes the first step (the right password, or a linked single sign-on account) and then keeps entering wrong codes (change the password, or secure the provider account, if that was not you).

**Lost phone.** Sign in with a recovery code (each works once). Without one: an admin or the owner issues a **Reset password** link on the Users page; completing it sets a new password and removes the account's 2FA and its single sign-on links (enrol and link again afterwards). For the owner, run `docker compose exec app bun run src/db/reset-owner.ts` and complete the printed link: that removes the owner's 2FA too. Shell access is the trust boundary of that path.

The TOTP secrets are stored encrypted with `DKIM_ENCRYPTION_KEY` (like DKIM keys and webhook secrets). If you rotate that key without re-encrypting, existing authenticator codes stop working (recovery codes still do; reset to re-enrol).

### Single sign-on (#224)

Accounts can sign in through your organization's OpenID Connect provider (Google Workspace, Keycloak, Authentik, Okta, Zitadel, GitLab, Microsoft Entra single-tenant). It is an extra way in, never a way to create accounts: dashboard accounts stay invite-only, and an identity at the provider opens only the BunMail account it was **linked** to. The password keeps working.

**Requirements.** An `https://` `APP_BASE_URL` (SSO stays off with one boot warning otherwise; plain `http://` only on `localhost`). At the provider: a confidential web client using the authorization code flow, a client secret sent with HTTP Basic (`client_secret_basic`), PKCE with `S256`, and ID tokens signed with a public key (RS256, ES256 and the like; `HS256` is refused). BunMail fetches `<issuer>/.well-known/openid-configuration` itself (a private Keycloak on your LAN works: the SSRF guard is deliberately not applied to the issuer you configure).

**Presets and supported providers.** Two ids are presets: `google` (issuer `https://accounts.google.com`, label `Google`) and `gitlab` (issuer `https://gitlab.com`, label `GitLab`). They need only `SSO_<ID>_CLIENT_ID` and `SSO_<ID>_CLIENT_SECRET`, and those two enable them even when `SSO_PROVIDERS` does not list them; an explicit `SSO_<ID>_ISSUER` or `SSO_<ID>_LABEL` still wins (a self-hosted GitLab sets its own issuer). Every other provider (Microsoft Entra, whose issuer carries your tenant, Okta, Auth0, Keycloak, Authentik, Zitadel, ...) is listed in `SSO_PROVIDERS` and needs `SSO_<ID>_ISSUER`. **GitHub** is not supported (it speaks OAuth 2.0 but not OpenID Connect: no ID token) and neither is **Apple** (its web flow posts the response back with `response_mode=form_post`, which the callback does not accept).

**Only providers with credentials appear.** The login page shows a **Sign in with `<label>`** button, with the provider's logo (chosen by the issuer's host: Google, Microsoft, GitLab, Okta, Auth0, Keycloak, a key icon otherwise), only for a provider whose client id and secret are both set. One listed in `SSO_PROVIDERS` with neither is skipped (no button, no routes) with one boot `warn` (`SSO provider skipped: no client credentials`, naming the missing variables); one with only one of the two refuses to boot, naming the missing variable, since that is almost always a typo.

**Set up a provider.**

1. Pick an id (lowercase letters, digits and `-`), for example `google` or `corp`, and register this **redirect URI** at the provider, exactly: `${APP_BASE_URL}/dashboard/login/sso/<id>/callback` (for example `https://mail.example.com/dashboard/login/sso/google/callback`). One URI per provider.
2. Put the client id and secret in `.env`, with the issuer unless the id is a preset (the id `my-idp` reads `SSO_MY_IDP_*`), list the id in `SSO_PROVIDERS` (optional for a preset) and restart. Any malformed value refuses to boot, naming the variable; the secret is never logged.
3. Each user signs in once with their password, opens **Account > Sign-in methods**, clicks **Link** next to the provider (the current password is asked), and signs in at the provider. From then on the login page's **Sign in with `<label>`** button signs them in. Or let the first SSO sign-in link it by email (below).

**Linking by verified email (optional, off by default).** With `SSO_<ID>_AUTO_LINK=true` and `SSO_<ID>_ALLOWED_DOMAINS=<your domains>` (required with it, or BunMail refuses to boot), the first **Sign in with `<label>`** of a user who never linked is linked to the BunMail account with the same email, then signs in, when the provider says the email is verified (`email_verified` exactly `true`), its domain is listed, and the account is an enabled **member without a BunMail second factor** and without a link at this provider yet. Anything else is refused like an unlinked sign-in. The user is emailed ("A sign-in method was linked automatically", no links). The **owner, admins and anyone with 2FA are never linked automatically**: they link on Account > Sign-in methods, where the password is asked (a link made at sign-in would exist before their second factor was passed).

*When to turn it on:* only where the identity provider is the source of truth for those addresses and users cannot set their own email: your Google Workspace domains (with Google, BunMail also requires the Workspace `hd` claim to be one of the listed domains, so a consumer Google account registered on a work address is refused) or a Keycloak or Authentik realm whose users cannot edit their email. *Never* for Microsoft Entra (its email claim is not a verified, immutable value: BunMail refuses to boot with auto-link on for `login.microsoftonline.com`, `sts.windows.net` and the sovereign cloud hosts `login.microsoftonline.us`, `login.partner.microsoftonline.cn`, `login.chinacloudapi.cn`, `sts.chinacloudapi.cn`, `login.microsoftonline.de`), for a provider with open registration, or for an identity broker or federated social login (Keycloak or Authentik with "trust email" on a social or upstream provider, Auth0, Okta social connections): a broker passes on what the weakest upstream provider says about the email. Domains are compared exactly: list each subdomain you want. Note that BunMail does not verify account addresses itself (an invitation link can be handed over), so auto-link trusts that each account's address belongs to its holder, and the alert goes to that same address.

**Google (quick start).** In the Google Cloud console: *APIs & Services > OAuth consent screen*, user type **Internal** for a Workspace organization (only its accounts can sign in; a consumer Google account cannot), then *Credentials > Create credentials > OAuth client ID*, application type **Web application**, and add `${APP_BASE_URL}/dashboard/login/sso/google/callback` under *Authorized redirect URIs* (for example `https://mail.example.com/dashboard/login/sso/google/callback`). Copy the client id and secret into `.env` and restart:

```env
SSO_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
SSO_GOOGLE_CLIENT_SECRET=GOCSPX-...
# Optional: google is a preset, enabled by the two lines above; listing it
# only fixes its place among the buttons.
# SSO_PROVIDERS=google
# Optional: link each user's first Google sign-in to the account with
# the same address, for these Workspace domains only.
# SSO_GOOGLE_ALLOWED_DOMAINS=example.com
# SSO_GOOGLE_AUTO_LINK=true
```

The preset issuer is exactly `https://accounts.google.com`, without a trailing slash (set `SSO_GOOGLE_ISSUER` only to that value, if at all). With a consumer (External) consent screen any Google account could reach the callback, but it still opens nothing unless an account linked it.

**Keycloak** (Authentik, Zitadel and other generic providers work the same way). In the realm: *Clients > Create client*, type **OpenID Connect**; turn **Client authentication** on (a confidential client) with only the **Standard flow**; set **Valid redirect URIs** to the redirect URI above (exactly, no wildcard); under *Advanced*, set the PKCE code challenge method to **S256**; copy the secret from the *Credentials* tab (authenticator "Client Id and Secret").

```env
SSO_PROVIDERS=corp
SSO_CORP_ISSUER=https://idp.example.com/realms/corp
SSO_CORP_CLIENT_ID=bunmail
SSO_CORP_CLIENT_SECRET=...
SSO_CORP_LABEL=Corporate SSO
```

**GitLab.** gitlab.com: *User settings > Applications* (or a group's *Settings > Applications*), scopes `openid`, `email`, `profile`, **Confidential** on, redirect URI `${APP_BASE_URL}/dashboard/login/sso/gitlab/callback`; then `SSO_GITLAB_CLIENT_ID` and `SSO_GITLAB_CLIENT_SECRET`. A self-hosted GitLab adds `SSO_GITLAB_ISSUER=https://gitlab.example.com`.

For any other provider, the issuer is the `issuer` value of its discovery document, byte for byte (mind a trailing slash; Microsoft Entra: `https://login.microsoftonline.com/<tenant-id>/v2.0`). Several providers: `SSO_PROVIDERS=google,corp` and one block each; the buttons follow that order, then any preset enabled by its credentials alone.

**What to expect.**

- **BunMail's own second factor still applies.** An account with TOTP or a passkey is asked for it after the provider, exactly as after the password; a provider's own MFA does not replace it. `REQUIRE_2FA` is unchanged.
- **The owner** can link an SSO account only while it has a BunMail second factor, and an owner without one is refused at sign-in: a takeover at the provider (or by its administrator) never becomes a one-factor way into the owner account.
- **Disabling someone at the provider is not enough.** BunMail has no SCIM or back-channel logout: their open BunMail sessions last until they expire (24 hours idle, 7 days at most) and their password still works. Deactivate the account in BunMail (**Users**) too; that signs it out at once.
- **Signing out is local.** **Log out** ends the BunMail session only; the provider session lives on, so on a shared computer the next **Sign in with** is one click at the provider. Sign out of the provider too on shared machines.
- **Unlinking** (Account > Sign-in methods, the password asked) signs out every session that identity opened. A completed password reset link or `reset-owner` link removes every link of the account too (with its 2FA), so an identity linked by someone who had access does not survive a reset; the security email lists what was removed.
- **Linking by verified email** (`SSO_<ID>_AUTO_LINK=true`) links only an identity that is not linked yet, to an enabled member without a second factor, and only once per provider; every such link is in the **Audit log** (`auth.sso.auto_linked`) and emailed to the account. Refused attempts show the same message as an unlinked sign-in; the audit log says why (`email_unverified`, `domain_not_allowed`, `second_factor_enrolled`, `admin_not_auto_linked`, `owner_not_auto_linked`, ...).
- Sign-ins with SSO count against the login rate limit like passwords (a failed one costs an attempt, a successful one gives it back) and appear in the **Audit log**. Each address may also start at most 20 sign-ins per 15 minutes. A callback request that another site embeds (an image, a frame) or that carries no sign-in in progress is refused without counting, so no site can lock your users out.
- **Several replicas, or a lot of traffic:** without `REDIS_URL`, each replica keeps the "already used" sign-in states in memory, at most 10 000 at a time (beyond that new sign-ins fail until older ones expire, within about 11 minutes). With `REDIS_URL` they are kept in Redis, shared by every replica, with no such cap.
- A new-device alert for an SSO sign-in names the provider; if you get one you do not recognise, remove unknown links under Account > Sign-in methods.

### Approximate session locations (GeoIP, #281)

Optional and **off by default**: without it the Active sessions page simply has no location column. When it is on, the location of a new session's IP is looked up once, in the background, right after sign-in, and stored with the session; a slow or failing lookup never delays or breaks a sign-in (it logs a `warn` `Session location lookup failed`). Private, loopback and link-local addresses are never looked up. The result is **approximate**: a VPN or proxy shows its own location, and the IP alone cannot do better.

Pick one source:

**Offline database (recommended): `GEOIP_DB_PATH`.** No third party sees any address.

1. Download the free **DB-IP Lite** "IP to City Lite" database in MMDB format from <https://db-ip.com/db/download/ip-to-city-lite> (no account needed, updated monthly) and unpack it: `gunzip dbip-city-lite-2026-10.mmdb.gz`. DB-IP Lite is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), which **requires attribution**: credit "IP Geolocation by DB-IP" with a link to <https://db-ip.com> wherever you show or describe the locations (for example in your internal docs or the page that lists your instance's dashboard users).
   Alternative: **MaxMind GeoLite2 City** or **GeoLite2 Country** (`.mmdb`), free with a MaxMind account and under the GeoLite2 EULA (its own attribution terms). Both formats work; a Country database gives "Country" labels only.
2. Make the file available to the container, readable by uid 1000 (the image runs as non-root), for example in your `docker-compose.override.yml`:

   ```yaml
   services:
     app:
       volumes:
         - ./geoip:/geoip:ro
   ```

3. Set `GEOIP_DB_PATH=/geoip/dbip-city-lite-2026-10.mmdb` in `.env` and restart. The file is read into memory once, at the first sign-in (`GeoIP database loaded, session locations on`). A missing or unreadable file logs one `warn` (`GeoIP database could not be loaded, session locations off`) and location stays off until the next restart; BunMail keeps running. Replace the file monthly and restart to pick up the new data.

**Online provider (opt-in): `GEOIP_PROVIDER=ipinfo` + `GEOIP_API_TOKEN`.** Uses ipinfo.io's free Lite API (`https://api.ipinfo.io/lite/<ip>`, HTTPS only, no request limit at the time of writing), which returns the **country only**. Create a free account at <https://ipinfo.io> and copy its access token. **Privacy: every sign-in IP address is then sent to ipinfo.io**, a third party; weigh that (GDPR and your own privacy notice) before turning it on. Each lookup times out after 3 seconds and its answer is size-capped and checked field by field. The token never appears in logs.

`GEOIP_DB_PATH` wins when both are set. Strict at boot: an unknown `GEOIP_PROVIDER`, a provider without `GEOIP_API_TOKEN`, a token without a provider, or a token with characters other than letters, digits, `-` and `_` refuses to start.

## 6. Reverse Proxy (Recommended for HTTPS)

### Caddy (automatic HTTPS)

```bash
apt install -y caddy
```

```
# /etc/caddy/Caddyfile
mail.yourdomain.com {
    reverse_proxy localhost:3000
}
```

```bash
systemctl restart caddy
```

### Nginx + Let's Encrypt

```bash
apt install -y nginx certbot python3-certbot-nginx
```

```nginx
# /etc/nginx/sites-available/bunmail
server {
    listen 80;
    server_name mail.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/bunmail /etc/nginx/sites-enabled/
nginx -t && systemctl restart nginx
certbot --nginx -d mail.yourdomain.com
```

> **Set `DASHBOARD_TRUSTED_PROXY_HOPS=1`** once BunMail is behind one of these proxies. Both configs above forward `X-Forwarded-For`, and the dashboard login throttle (#109) reads the real client IP from it (rightmost entry) instead of the proxy's socket IP, so lockouts are per-attacker, not shared. **Keep BunMail's `:3000` bound to localhost / firewalled so the only path in is through the proxy**; otherwise a direct request could forge `X-Forwarded-For` and get a fresh throttle bucket per request. Docker-published ports bypass UFW, so the default `docker-compose.yml` publishes `3000` on `127.0.0.1` only (#205); keep it that way when the proxy runs on the same host, and publish anything else from `docker-compose.override.yml`. BunMail logs `Request bypassed the trusted proxy` (at most once an hour, #256) when a request arrives with fewer `X-Forwarded-For` entries than `DASHBOARD_TRUSTED_PROXY_HOPS`.

## Firewall Rules

| Port | Protocol | Direction | Purpose                    |
|------|----------|-----------|----------------------------|
| 25   | TCP      | Outbound  | Send emails to MX servers  |
| 25   | TCP      | Inbound   | Receive inbound emails     |
| 465  | TCP      | Inbound   | SMTP submission over implicit TLS: apps sending *through* BunMail (only if `SMTP_SUBMISSION_ENABLED=true` with a TLS cert; restrict to the networks your apps live on) |
| 587  | TCP      | Inbound   | SMTP submission without TLS (no cert, `SMTP_SUBMISSION_ALLOW_INSECURE=true`): trusted networks only, never public |
| 443  | TCP      | Inbound   | HTTPS (reverse proxy)      |
| 3000 | TCP      | (none)    | HTTP API + dashboard, loopback only; reached through the proxy on 443 |

> **SMTP submission (#120).** To let other apps (Infisical, Netbird, Dify, a Nodemailer backend, …) send through BunMail over SMTP, set `SMTP_SUBMISSION_ENABLED=true`, publish the submission port in your `docker-compose.override.yml` (see `docker-compose.override.example.yml`), and open the port to those apps only: `465` with a TLS cert (implicit TLS, clients use "SSL/TLS"; STARTTLS is not available on Bun, #349), or `587` for plaintext on a trusted network. They authenticate with a `bm_live_…` API key as the password. Full setup and integration snippets: [docs/smtp-submission.md](smtp-submission.md).

## Runs as non-root

The container runs as the unprivileged `bun` user (uid 1000), not root (#167). The app only reads from disk, so a compromise can't modify its own code.

**Low ports (25, 465, 587).** A non-root process can only bind ports below 1024 when the kernel setting `net.ipv4.ip_unprivileged_port_start` is `0` inside the container. `docker-compose.yml` pins it:

```yaml
sysctls:
  net.ipv4.ip_unprivileged_port_start: 0
```

It's scoped to the container's own network namespace and changes nothing on the host. Docker 20.10+ already defaults to it; the pin makes it explicit. On Kubernetes it's an allowed "safe" sysctl (set it in the pod's `securityContext.sysctls`). If your platform forbids it, run the servers on high ports inside the container instead (`SMTP_PORT=2525`, `SMTP_SUBMISSION_PORT=2465`) and publish them as `25:2525` and `465:2465`.

**If an SMTP server can't bind its port, BunMail exits** with a message naming the port, the cause and the fix, for example:

```
Inbound SMTP can't listen on port 25 (EACCES: permission denied). BunMail runs as a non-root user: set the sysctl net.ipv4.ip_unprivileged_port_start=0 (pinned in docker-compose.yml) or use a port >= 1024.
```

The container then restart-loops visibly instead of staying "healthy" while no mail arrives.

**TLS keys must be readable by uid 1000.** If you mount a certificate and private key for `SMTP_SUBMISSION_TLS_CERT` / `SMTP_SUBMISSION_TLS_KEY`, a key owned by root with mode `600` (or `640` with another group) can't be read and the submission server won't start. Make it readable by uid 1000, e.g. `chgrp 1000 privkey.pem && chmod 640 privkey.pem`, or copy it to a file owned by uid 1000. Keys used only by a TLS proxy in front of BunMail (stunnel, Caddy) are unaffected.

## Updating BunMail

```bash
cd /root/bunmail

# Pull latest code (or rsync again for private repos)
git pull
# If you edited docker-compose.yml locally and git refuses to pull:
#   git stash && git pull && git stash pop

# Rebuild and restart
docker compose down && docker compose up -d --build
```

### Running several replicas

One app container is enough for most installs and needs nothing more. To run several behind a load balancer (on one host, each on its own published port, or on several hosts sharing one database), set `REDIS_URL` on every replica to the same Redis or Valkey (#185):

```yaml
# docker-compose.override.yml (see docker-compose.override.example.yml)
services:
  app:
    environment:
      REDIS_URL: redis://redis:6379
    depends_on:
      redis:
        condition: service_healthy
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped
```

- **What moves to Redis:** the API rate limit, the login, passkey sign-in, ownership transfer, password re-check and two-factor code budgets, the SMTP submission failed-AUTH throttle (API-key guessing) and connection limit, the inbound SMTP connection limit, the dashboard DNS-verify throttle, the once-a-minute `last_used_at` write per API key, the outbound MX session limit and rate budget (`MAIL_MX_CONCURRENCY` and `MAIL_MX_RATE_PER_MIN` per provider bucket, #391), and the one-time reveal of new API keys, webhook secrets, invitation and reset links and recovery codes. Without Redis each replica keeps its own (N replicas allow N times the attempts, and a reveal fails when the follow-up request reaches another replica).
- **SMTP behind a load balancer:** the SMTP limits (inbound and submission connections, the submission failed-AUTH throttle) count the socket's client address. The balancer must preserve the client source address (no SNAT; for example Kubernetes `externalTrafficPolicy: Local`, or a pass-through TCP balancer), otherwise every client shares the balancer's address and, with Redis, one client's failures or connection burst locks every client out across the cluster. PROXY protocol is not supported yet.
- **What does not need it:** the send queue, webhook deliveries, domain re-verification and the owner bootstrap coordinate through Postgres.
- **Outbound MX sessions:** with Redis, `MAIL_MX_CONCURRENCY` counts the SMTP sessions to a provider bucket from every replica together. Set the same value on every replica. A session holds a slot with a 60-second lease renewed every 20 seconds while it runs, so a replica that crashes mid-session frees its slot within a minute. Sessions waiting for a slot are served first come, first served across replicas. During a Redis outage each replica falls back to its own limit (N replicas open up to N times `MAIL_MX_CONCURRENCY`, as without Redis).
- **Outbound MX rate:** with Redis, `MAIL_MX_RATE_PER_MIN` is one token bucket per provider bucket shared by every replica, paced as smoothly as on one replica. Set the same value on every replica. During a Redis outage each replica paces on its own bucket, which starts full (N times the rate until Redis is back).
- **Still per replica:** passkey challenges (a passkey ceremony needs sticky sessions), and the notification, replay and unsubscribe budgets.
- **Version:** Redis 5 or later, or Valkey. The MX slot and rate scripts read the server clock (`TIME`) before they write, which needs script effects replication, the default since Redis 5; the example's `redis:7-alpine` is fine.
- **Nothing to persist:** every key expires within the longest limit window (an MX session slot with its 60-second lease, an MX rate bucket once it would be full again), so Redis needs no disk (the example turns persistence off). Keep Redis on the private network, never published; set a password (`redis://:password@redis:6379`) when it is shared with anything else. Redis Cluster is not supported.
- **One Redis, or one Redis database, per BunMail install:** every key starts with `bunmail:`, so two installs on the same Redis database would share lockout counters (one install's failed logins from an address would lock that address out of the other). Their reveals stay apart (each is encrypted with its install's `DKIM_ENCRYPTION_KEY`). Give each install its own database number (`redis://redis:6379/1`, `/2`, ...) or its own Redis.
- **TLS:** with `rediss://`, Bun verifies the server certificate and its host name (checked on Bun 1.3.14); a managed Redis with a public certificate works as is. For a private CA, mount it and set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` in `.env`. A certificate problem looks like an unreachable Redis: the replica refuses to start (`[boot] Redis did not answer`, code `ERR_REDIS_CONNECTION_CLOSED`).
- **Outages:** Redis must answer when a replica starts, or the replica refuses to start (Docker restarts it). If Redis goes down later, limits fall back to each replica's memory (`Shared store unavailable` at `error`), reveals are not shown (`One-time reveal could not be stored`), and the replica reconnects on its own (`Redis connection restored`). This is a deliberate trade-off: sign-in keeps working during the outage, but each replica starts a fresh budget in its own memory, so an attacker gets about one extra window of attempts per replica while Redis is down (see SECURITY.md).
- **Same `DKIM_ENCRYPTION_KEY` on every replica:** it also encrypts the reveals stored in Redis.

### Upgrading from 0.9.x to 0.10.0

0.10.0 replaces the shared `DASHBOARD_PASSWORD` and the `SESSION_SECRET`-signed cookie with accounts (#216) and adds two production boot guards. The full checklist is the **Upgrade guide** at the top of the 0.10.0 entry in [CHANGELOG.md](../CHANGELOG.md); in short:

1. **Before you pull**, back up the database and add `BUNMAIL_OWNER_EMAIL=you@yourdomain.com` (#215), a real `MAIL_HOSTNAME` (#242) and `APP_BASE_URL` to `.env`. Production refuses to start without the first two (before any migration runs), so a `git pull` and rebuild without them crash-loops.
2. If you edited `docker-compose.yml` or `docker-compose.override.yml`, `git stash` first (from the release after 0.10.0, host edits live in an untracked override: see the CHANGELOG). The container now runs as uid 1000 (see [Runs as non-root](#runs-as-non-root)).
3. Pull and rebuild as above. Migrations `0013` to `0020` (accounts, sessions, record ownership, retry leases) apply on container start.
4. **Everyone is signed out once:** old dashboard cookies are rejected and cleared.
5. Claim the owner: `docker compose logs app | grep 'Owner setup link'`, open the link, choose a password (15 or more characters). Setup signs you in. If the link expired or was lost, restart the container (a new link is logged while setup is pending) or run `docker compose exec app bun run src/db/reset-owner.ts`.
6. Remove `DASHBOARD_PASSWORD` and `SESSION_SECRET` from `.env`. They do nothing any more; while they are set, every boot logs `Dashboard auth env vars are no longer used since #216, remove from .env`.
7. Existing API keys, templates, domains and webhooks now belong to the owner (#219). After inviting teammates, rotate any admin key you shared with them.

The API, SMTP and the queue are not affected by the account change; only the dashboard is unreachable until the owner is claimed.

## Preventing Spam (Deliverability Guide)

If your emails land in spam, follow this checklist. Each step contributes to your sender reputation: skip none of them.

### 1. DNS Authentication (Required)

All three must be set correctly. Verify with:

```bash
# SPF
dig TXT yourdomain.com +short
# Expected: "v=spf1 a:mail.yourdomain.com -all" (or your existing record with that term)

# DKIM
dig TXT bunmail._domainkey.yourdomain.com +short
# Expected: "v=DKIM1; k=rsa; p=MIIBIj..."

# DMARC
dig TXT _dmarc.yourdomain.com +short
# Expected: "v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com" (then quarantine or reject)
```

| Record | What it does | Without it |
|--------|-------------|------------|
| **SPF** | Authorizes your server IP to send mail for your domain | Gmail marks as suspicious |
| **DKIM** | Cryptographically signs every email so recipients can verify it wasn't tampered with | Fails authentication checks |
| **DMARC** | Tells receivers what to do when SPF/DKIM fail (quarantine, reject, or report) | No policy = no trust signal |

### 2. Reverse DNS / PTR Record (Critical)

This is the **#1 reason** new servers land in spam. The PTR record maps your server IP back to your domain. Without it, Gmail and other providers see a generic datacenter hostname and immediately flag the email.

```bash
# Check your current PTR
dig -x YOUR_SERVER_IP +short

# Bad:  123-45-67-89-host.colocrossing.com.
# Good: mail.yourdomain.com.
```

**How to set it:** Contact your VPS provider's support team and ask them to set the PTR record for your IP to `mail.yourdomain.com`. Most providers (RackNerd, Hetzner, OVH) handle this via a support ticket within a few hours.

The PTR hostname must:
- Match your `MAIL_HOSTNAME` in `.env`
- Have a matching A record pointing back to the same IP (forward-confirmed reverse DNS)

### 3. MX Record (Recommended)

Even if you only send email, an MX record tells other servers your domain receives mail, so replies and bounces have somewhere to go. It need not point at BunMail: a domain whose mailboxes are hosted elsewhere keeps its own MX.

```bash
dig MX yourdomain.com +short
# Expected: 10 mail.yourdomain.com.
```

With `SMTP_ENABLED=true`, this MX is also where bounces come back. Signed return paths are used for domains whose MX points at this BunMail; other domains keep the From address as envelope sender (#236). For a domain whose MX names `MAIL_HOSTNAME`, the envelope sender of outbound mail is a signed per-recipient return path on that domain, `b+<id>.<index>.<MAC>@yourdomain.com`, instead of the From address, and only DSNs delivered to such an address are acted on. A domain whose mail is hosted elsewhere (Google Workspace, Microsoft 365) keeps the From address, so its DSNs still reach that mailbox; BunMail does not act on them. The MX answer is cached for an hour (five minutes after a DNS error, which falls back to the plain envelope). SPF and DMARC are unchanged: the envelope sender's domain is still the sending domain. The `b+` local part is reserved on domains BunMail receives for. See [bounces.md](bounces.md#signed-return-paths-236).

### 4. Server Hostname

Set the system hostname to match your PTR and `MAIL_HOSTNAME`:

```bash
hostnamectl set-hostname mail.yourdomain.com
```

This ensures the SMTP EHLO/HELO greeting matches the PTR, which is verified by receiving servers.

### 5. IP Reputation

New IPs have no reputation, which is treated as suspicious. Build it gradually:

- **Start slow**: send 10-20 emails per day for the first week
- **Increase gradually**: double volume each week
- **Send to engaged recipients**: avoid sending to lists that haven't opted in
- **Monitor bounces**: high bounce rates destroy reputation fast
- **Process spam complaints**: enrol in the mailbox providers' feedback loops (Yahoo/AOL CFL, Microsoft JMRP and SNDS) with an address that reaches BunMail's inbound SMTP, so recipients who mark your mail as spam are suppressed automatically; Gmail reports only aggregate rates per `Feedback-ID` in Postmaster Tools. See [feedback-loops.md](feedback-loops.md)

#### Blocklists (DNSBL self-check, #250)

BunMail checks its own sending IPs (`MAIL_PUBLIC_IP`, or the A/AAAA records of `MAIL_HOSTNAME`) about a minute after boot, then every 24 hours, on three blocklists:

| Zone | Lists | Look up and delist |
|---|---|---|
| `zen.spamhaus.org` (Spamhaus ZEN) | IPv4 and IPv6 | [check.spamhaus.org](https://check.spamhaus.org/) |
| `b.barracudacentral.org` (Barracuda BRBL) | IPv4 only | [barracudacentral.org/rbl/removal-request](https://www.barracudacentral.org/rbl/removal-request) |
| `bl.spamcop.net` (SpamCop) | IPv4 only | [spamcop.net/bl.shtml](https://www.spamcop.net/bl.shtml) |

IPv6 addresses are only looked up on ZEN: the other two zones do not list IPv6. The result is on the dashboard home (**Blocklists** card, admins and the owner) and in the logs: a `warn` line `Sending IP listed on a DNSBL` when an address becomes listed, an `info` line when it is delisted, and one `DNSBL self-check completed` line per run (`job: "dnsbl-self-check"`). Only `127.0.0.2` to `127.0.0.11` count as listed. Spamhaus return codes are named: `127.0.0.2` SBL, `.3` CSS, `.4` to `.7` XBL, `.9` DROP, `.10` and `.11` PBL. A **PBL** listing is a policy listing, not abuse: the range's owner (usually the hosting provider) says it should not send mail directly. If this server is meant to send mail, remove the address at check.spamhaus.org. This check only reports: a listing never holds or refuses mail, and results are kept in memory per replica.

**Public resolvers.** Spamhaus refuses queries sent through public resolvers (Google `8.8.8.8`, Cloudflare `1.1.1.1`, Quad9 and others) and answers `127.255.255.254` (or another `127.255.255.x` code) instead; the card then shows the zone as `unavailable`, never as listed. Barracuda may also ignore queries from resolvers it does not know. For a real answer, point the server at a local recursive resolver (see [Local resolver for DNSBL](#local-resolver-for-dnsbl) below), not at a forwarder to a public service. Lookups that fail or time out (5 s) show as `unknown`.

#### Local resolver for DNSBL

Both DNSBL checks (this outbound self-check, and the inbound check on port 25, see [inbound.md](inbound.md#layer-1-dnsbl-ip-check)) need DNS answers from your own IP. Through a public resolver, Spamhaus answers `127.255.255.254` (Cloudflare) or NXDOMAIN (Google) to everything, so nothing is ever found. The inbound check says so at boot: `Inbound DNSBL self-test failed: the zone does not answer`. The fix is a small recursive resolver on the host that the app container uses. Tested on Ubuntu 24.04 with Unbound 1.19:

1. **Install Unbound and give it a BunMail config.** It listens on loopback and on the `docker0` bridge (`172.17.0.1`, check with `ip -4 addr show docker0`), answers only loopback and Docker's private ranges, and never listens on the public IP. `docker0` keeps its address, while a Compose network's gateway can change after `docker compose down`, so the bridge is the stable choice. `ip-freebind` lets Unbound start at boot before `docker0` exists. It runs next to `systemd-resolved` (which only holds `127.0.0.53` and `127.0.0.54`).

   ```bash
   sudo apt-get install -y unbound
   sudo tee /etc/unbound/unbound.conf.d/bunmail.conf >/dev/null <<'EOF'
   server:
       interface: 127.0.0.1
       interface: 172.17.0.1
       ip-freebind: yes
       access-control: 0.0.0.0/0 refuse
       access-control: 127.0.0.0/8 allow
       access-control: 172.16.0.0/12 allow
       hide-identity: yes
       hide-version: yes
       prefetch: yes
   EOF
   sudo unbound-checkconf && sudo systemctl enable --now unbound && sudo systemctl restart unbound
   dig +short 2.0.0.127.zen.spamhaus.org @127.0.0.1   # Spamhaus's test entry: 127.0.0.2 (and others)
   ```

2. **Point the app container at it** in `docker-compose.override.yml` (the commented example is in `docker-compose.override.example.yml`), then recreate the app:

   ```yaml
   services:
     app:
       dns:
         - 172.17.0.1
   ```

   ```bash
   docker compose up -d app
   docker compose logs app | grep -E 'Inbound DNSBL self-test|DNSBL self-check completed'
   ```

   Expect `Inbound DNSBL self-test passed` (when inbound SMTP is on) and, about a minute later, a self-check line with `unavailable: 0`. All of the app's DNS (MX lookups for sending included) now goes through Unbound; send a test email to confirm.

A query to `172.17.0.1` from the host itself is refused (its source is the public IP, outside the allowed ranges); test from inside the container instead. To undo, remove the `dns:` block and run `docker compose up -d app`. The alternative to a local resolver is a free [Spamhaus DQS](https://www.spamhaus.com/free-trial/sign-up-for-a-free-data-query-service-account/) key for the inbound check (`SMTP_DNSBL_ZONE=<key>.zen.dq.spamhaus.net`); the outbound self-check uses the public zones and still needs the resolver.

**When listed:** find the cause first (a compromised account or API key, a bad list, an open relay on the same IP), stop it, then request removal at the zone's page above. SpamCop listings expire on their own about 24 hours after the reports stop. The next daily check (or a restart) shows the new state. For an overview of other blocklists, [mxtoolbox.com/blacklists.aspx](https://mxtoolbox.com/blacklists.aspx) checks many at once.

### 6. Email Content Best Practices

Even with perfect DNS, bad content triggers spam filters:

- **Always include a plain text version**: use both `html` and `text` fields in the API. An HTML-only send gets a text part derived from the HTML at send time (#250), but one you write reads better
- **Avoid spam trigger words**: "free", "limited time", "act now", excessive caps/exclamation marks
- **Include an unsubscribe link**: required by most email providers for bulk mail. With an `https://` `APP_BASE_URL`, every single-recipient email gets a one-click `List-Unsubscribe` link that BunMail turns into a suppression (#249); send bulk mail one recipient per message, without cc or bcc, so it carries one. Set `category: "marketing"` on such mail and BunMail refuses any that could not carry the link (#250); `category: "transactional"` leaves `List-Unsubscribe` out of receipts and alerts
- **Use a real From address**: `hello@yourdomain.com` is better than `noreply@yourdomain.com`
- **Don't send HTML-only**: always include a text fallback (BunMail derives one when you don't, #250)
- **Keep image-to-text ratio reasonable**: don't send an email that's just one big image

### 7. Verify Your Setup

After configuring everything, use these tools to verify:

| Tool | URL | What it checks |
|------|-----|----------------|
| **MXToolbox** | [mxtoolbox.com/SuperTool.aspx](https://mxtoolbox.com/SuperTool.aspx) | SPF, DKIM, DMARC, PTR, blacklists |
| **Mail Tester** | [mail-tester.com](https://www.mail-tester.com) | Send a test email and get a deliverability score (0-10) |
| **Google Postmaster** | [postmaster.google.com](https://postmaster.google.com) | Gmail-specific reputation and delivery stats |
| **DKIM Validator** | [dkimvalidator.com](https://dkimvalidator.com) | Send a test email to verify DKIM signing works |

### 8. Gmail "Show Original" Trick

When testing, open the email in Gmail, click the three dots menu → **"Show original"**. This shows the raw authentication results:

```
SPF:   PASS with IP 23.95.164.177
DKIM:  PASS with domain yourdomain.com
DMARC: PASS
```

If any of these show `FAIL` or `NONE`, fix the corresponding DNS record.

### Quick Checklist

```
[ ] SPF TXT record added
[ ] DKIM TXT record added (from BunMail domain registration)
[ ] DMARC TXT record added
[ ] MX record (pointing to mail.yourdomain.com only if BunMail should receive bounces, DMARC reports and inbound mail)
[ ] A record for mail.yourdomain.com → server IP
[ ] PTR (reverse DNS) set to mail.yourdomain.com
[ ] Server hostname matches PTR
[ ] MAIL_HOSTNAME in .env matches PTR
[ ] IP not on any blacklists (dashboard home, Blocklists card)
[ ] Tested with mail-tester.com (aim for 8+/10)
[ ] Feedback loops enrolled, FBL address routed to BunMail (docs/feedback-loops.md)
```

---

## Troubleshooting

**Container keeps restarting:**
- Check logs: `docker compose logs app` (every line carries its request or job ID; see [docs/logging.md](logging.md) for tracing one request, email or SMTP session)
- Common cause: missing env vars or database connection issues

**"Failed to connect" errors:**
- Outbound port 25 is blocked: contact your VPS provider or choose one from the recommended list
- DNS resolution issues: check with `dig MX example.com`

**Dashboard not loading:**
- Check the container is running: `docker compose ps`
- If using a reverse proxy, verify it's forwarding to port 3000
- `Dashboard temporarily unavailable` (HTTP `503`): the dashboard could not reach the session store in Postgres. Check the database with `docker compose ps` and `docker compose logs db`; the API keeps working.
- Pages render unstyled and the log shows `Dashboard asset missing` for `dashboard.css`: the stylesheet is built, not committed (#255). The Docker image builds it; when running from source, run `bun run build:css` (or `bun run dev`, which builds it first) and restart.

**Can't sign in to the dashboard (for example after upgrading to #216):**
- The dashboard login is the owner account, not `DASHBOARD_PASSWORD`. If the owner never completed setup, take the newest `Owner setup link` from `docker compose logs app` or run `docker compose exec app bun run src/db/reset-owner.ts`. A forgotten password is reset the same way.
- `Invalid email or password.` is shown for every failure. The server log line `Dashboard login failed` carries the `reason` (`unknown`, `no_password`, `disabled`, `bad_password`, `too_long`); `no_password` means the setup link was never completed.
- After 5 failures in 15 minutes from one IP the form is locked (HTTP `429`, `Retry-After`) until the window passes (#109).
- The sign-in succeeds but you land on the login page again: the `Secure` cookie was dropped because the dashboard is served over plain HTTP. Use HTTPS or an SSH tunnel to `localhost` (see [5. Dashboard](#5-dashboard)).
- `Forbidden: cross-origin request rejected` (HTTP `403`) on the login form: the `Origin` of the form post does not match the host BunMail sees. Behind a reverse proxy, forward the original `Host` header (`proxy_set_header Host $host;` in nginx; Caddy does it by default).
- Signed out unexpectedly and the log shows `Session token reuse detected: all sessions of the user revoked`: a replaced session cookie was presented more than 30 seconds after its replacement, so every session of the account was ended. Sign in again. It also happens, rarely, when the response carrying a new cookie never reached the browser (a dropped connection). If neither explains it, treat the cookie as stolen and run `reset-owner`.

**Migration errors:**
- Check logs: `docker compose logs app`
- Migrations run via the Bun-native runner at `src/db/migrate.ts` (#56): drizzle-kit no longer ships in the runtime image. The runner reads the committed `drizzle/<n>_*.sql` files and tracks applied tags in the `__bunmail_migrations` table. Every app container runs it on start, under a Postgres advisory lock (#175), so several replicas (`--scale app=2`, rolling deploys) are safe: one migrates, the others wait and then find nothing to do.
- Ensure `DATABASE_URL` is correct and PostgreSQL is healthy: `docker compose ps`

**Boot fails with a `[config]` error about `BUNMAIL_OWNER_EMAIL`:**
- Production requires it since #215 (`[config] BUNMAIL_OWNER_EMAIL must be set when BUNMAIL_ENV=production.`). Add `BUNMAIL_OWNER_EMAIL=you@yourdomain.com` to `.env` (one bare address, no name or angle brackets, at most 254 characters) and recreate the container with `docker compose up -d` (`docker compose restart` does not re-read `.env`). A malformed value (`[config] BUNMAIL_OWNER_EMAIL is not usable: ...`) is refused in development too; the error does not echo the value.

**Owner setup link expired, lost, or says the link is invalid:**
- The page (HTTP `400`) shows the same message for a missing, malformed, unknown, expired, used or replaced link. Before setup, restart the container (`docker compose restart app`) and take the newest `Owner setup link` from `docker compose logs app`; only the most recent link works. At any time, `docker compose exec app bun run src/db/reset-owner.ts` prints a fresh link to your terminal.
- ``Owner bootstrap failed; run `bun run src/db/reset-owner.ts` to retry`` in the logs: the boot continued without an owner link (the API and mail delivery do not depend on it). Fix the cause in the logged `error` and run `docker compose exec app bun run src/db/reset-owner.ts`.
- `Owner bootstrap skipped: BUNMAIL_OWNER_EMAIL belongs to an existing non-owner account, which is never promoted`: pick an address no other account uses.
- If the link points at `http://localhost:PORT` (the log line then carries a `hint`), `APP_BASE_URL` is unset or not an `http(s)://` URL: set it, or open the link through an SSH tunnel (`ssh -L 3000:localhost:3000 root@your-server-ip`).

**Boot fails with `[config] Missing required environment variable: DKIM_ENCRYPTION_KEY`:**
- Add `DKIM_ENCRYPTION_KEY=$(openssl rand -base64 32)` to `.env`. Required since v0.4.x: the key encrypts DKIM private keys at rest. Boot fails loudly rather than silently storing plaintext.
