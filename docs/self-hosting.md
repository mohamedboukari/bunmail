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
# Optional: scheduled DNS re-verification of domains (#250), on by default;
# hours between checks of a passing domain, 6 to 168, default 24
# DOMAIN_REVERIFY_ENABLED=true
# DOMAIN_REVERIFY_INTERVAL_HOURS=24
# Optional: also refuse addresses any API key hard-bounced or got a complaint
# for (#250), default false
# SUPPRESSIONS_SHARED_HARD=false
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

> `APP_BASE_URL`: public base URL of this instance (no trailing slash). Used to build the "view in dashboard" link in inbound notification emails (leave unset to omit it), the owner setup link logged on first boot, invitation links (#217), admin-issued password reset links (#277) and, when it is an `https://` URL, the per-recipient one-click unsubscribe link `/u/<token>` in single-recipient mail (#249, see [suppressions.md](suppressions.md#one-click-unsubscribe)): that path must be publicly reachable, unauthenticated, through your reverse proxy. When unset, the setup and reset links fall back to `http://localhost:PORT`, which you can still open through an SSH tunnel; invitation links would too, so without a usable `APP_BASE_URL` BunMail never emails an invitation and shows the link to the inviter instead: set it before inviting anyone.

> `SYSTEM_MAIL_FROM` / `INVITE_EXPIRY_DAYS`: dashboard invitations (#217). Admins and the owner invite teammates from the dashboard (**Invite teammates** on the home page). When `SYSTEM_MAIL_FROM` is set to an address on a domain you registered in BunMail and whose DKIM record is verified, BunMail emails the accept link from it, signed with that domain's key. When it is unset, or the domain is missing or unverified, or the send fails, the invitation is still created and the inviter sees the link once on the Invitations page to send by hand (share it privately: anyone with it can create the account). A malformed `SYSTEM_MAIL_FROM` refuses to boot. `INVITE_EXPIRY_DAYS` (default `7`, a whole number from `1` to `90`, anything else refuses to boot) sets how long a link stays valid. See [docs/dashboard.md](dashboard.md#invitations-217). The same sender also sends **new-device sign-in alerts** (#282): when an account signs in with its password from a browser it has not used in the last 30 days, it gets "New sign-in to your BunMail account" (browser and OS, IP, approximate location, time, and what to do; no links). Without a usable `SYSTEM_MAIL_FROM` no alert is sent and the sign-in is only logged (`New-device sign-in`). See [docs/dashboard.md](dashboard.md#new-device-alerts-282).

> `INBOUND_NOTIFY_ENABLED` / `INBOUND_NOTIFY_FROM_LOCAL`: inbound notifications (#106). When a domain has a `notify_email` set, received mail for it triggers a summary email from `<INBOUND_NOTIFY_FROM_LOCAL>@<domain>` (default `notifications`). `INBOUND_NOTIFY_ENABLED=false` is a global kill switch. The notification is signed by your domain, so it carries no content of the inbound message (#250): its subject is `New email for <recipient address>` and its plain-text body names the sender, the arrival time, the size and, with `APP_BASE_URL` set, the dashboard link. `INBOUND_NOTIFY_PREVIEW=true` (default `false`; only `true` or `false`, anything else refuses to boot) adds the original subject and a 200-character preview to the body, with every `http://`, `https://` and `www.` link replaced by `[link removed]`. Automatic inbound mail (auto-replies, bulk and list mail, a null return path) is not notified, and each recipient address gets at most 5 notifications per 10 minutes and each domain at most 30, counted in memory per replica; the address's next notification reports how many were skipped. See [docs/inbound.md](inbound.md#inbound-notifications-106).

> `DASHBOARD_TRUSTED_PROXY_HOPS`: the dashboard login throttle (#109) rate-limits failed logins per client IP. Behind a reverse proxy (section 6) the socket IP is the proxy's, so set this to the number of trusted proxy hops (`1` for a single nginx/Caddy/Cloudflare): BunMail then reads the real client from the Nth-from-right `X-Forwarded-For` entry. Leave at `0` only if BunMail is exposed directly. **Make sure the origin is reachable only through the proxy** (don't expose `:3000`), otherwise `X-Forwarded-For` can be forged. Tune the limits with `DASHBOARD_LOGIN_RATE_LIMIT_MAX` (default `5`, 1 to 100) and `DASHBOARD_LOGIN_RATE_LIMIT_WINDOW` (seconds, default `900`, 60 to 86400); a value outside those bounds, or not a whole number, refuses to start (#220). Two-factor code checks keep their own fixed budget (5 per 15 minutes). See [docs/dashboard.md](dashboard.md#brute-force-protection-109).

> `API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW`: per-API-key request limit on the REST API (default `100` requests per `60` seconds, then `429` with `Retry-After`). Raise it if one key legitimately makes more calls than that, for example a high-volume sender. Boot fails on a non-positive or non-integer value.

> `MAIL_ALLOW_PRIVATE_MX`: by default BunMail refuses to deliver to an MX host that resolves to a private, loopback or link-local address, since recipient domains (and their MX records) are chosen by API callers. Set `true` only if you deliberately deliver to an internal mail server.

> `REQUIRE_VERIFIED_DOMAIN`: refuse sends from a sender domain whose DKIM record is not verified (#245). Default `false`: the email is queued and `POST /api/v1/emails/send` returns `warnings` (`dkim_unverified`, `spf_unverified`, `dmarc_unverified`), the dashboard flash names them, and SMTP submission logs them. With `true`, a registered domain whose stored DKIM flag is false is re-verified in DNS once before the send (a failure is remembered for 5 minutes per domain, so retries do not query DNS each time; running **Verify** on the domain takes effect at once), then refused with `422 SENDER_DOMAIN_UNVERIFIED` (SMTP `550`); an unregistered domain is refused in every environment. SPF and DMARC only warn. Only `true` or `false`; anything else refuses to boot.

> `DOMAIN_REVERIFY_ENABLED` / `DOMAIN_REVERIFY_INTERVAL_HOURS` (#250): a background loop re-checks every domain's SPF, DKIM and DMARC records, so a record removed or changed after verification is noticed. A passing domain is checked again every `DOMAIN_REVERIFY_INTERVAL_HOURS` (default `24`, 6 to 168, plus or minus an hour), a failing or inconclusive one after an hour. A failed lookup (SERVFAIL, timeout) never counts; two definitive failures in a row flip a verified domain to failing: `verifiedAt` is cleared, the failing flags are cleared (with `REQUIRE_VERIFIED_DOMAIN=true` and DKIM failing, its sends are then refused) and `domain.verification_failed` fires to admin keys' webhooks. Several replicas share the work safely. `DOMAIN_REVERIFY_ENABLED=false` (default `true`) turns the loop off: domains are then only checked by **Verify** and the inline check of `REQUIRE_VERIFIED_DOMAIN`. Only `true` or `false`, and only a whole number in range; anything else refuses to boot. See [domains.md](domains.md#scheduled-re-verification-250).

> `MAIL_PUBLIC_IP` (#247, #248): the public IPs this server sends from, comma-separated. Optional: unset, BunMail uses the A/AAAA records of `MAIL_HOSTNAME`. SPF verification checks that the domain authorizes these addresses, and every boot logs whether their PTR records name `MAIL_HOSTNAME` and resolve back (`Reverse DNS confirmed for every sending IP`, or a `warn` with the fix). Behind NAT the container can't see its egress address: set this to the real one.

> `MAIL_RETRY_MAX_AGE_HOURS`: how long an email that keeps failing temporarily (4xx replies such as greylisting or rate limits, connection errors) is retried before it is marked `failed`. Default `48`. Retries back off: 5 m, 15 m, 30 m, 1 h, 2 h, then every 4 h. A recipient whose last reply was `4.2.2` (mailbox full) when the window ends gets a 24-hour soft suppression and a soft `email.bounced` (#250); every other temporary failure gets neither.

> `SUPPRESSIONS_SHARED_HARD` (#250): every API key sends from the same IP and DKIM domains, so one key's bad list damages delivery for all of them. With `true`, a send (REST, dashboard, SMTP submission, and the queue's re-check before a retry) is also refused when **any** key holds a permanent hard-bounce suppression or a feedback-loop complaint for the address. Unsubscribes, manual entries and temporary rows stay per key (they are the tenant's own decision). The refusal is the usual `422 RECIPIENT_SUPPRESSED` (SMTP `550`) with `suppressionId: null`: it never names the other key or its row, and each key's suppression list still shows only its own rows. Default `false`. Only `true` or `false`; anything else refuses to boot. See [suppressions.md](suppressions.md#shared-hard-suppressions-suppressions_shared_hard-250).

> `QUEUE_BATCH_SIZE` / `QUEUE_POLL_INTERVAL_MS` / `QUEUE_MAX_CONCURRENT_SENDS`: send queue throughput (#176). Every `QUEUE_POLL_INTERVAL_MS` (default `2000`, 250 to 60000, with +/-10% jitter) the queue claims up to `QUEUE_BATCH_SIZE` due emails (default `5`, 1 to 100), but never more than the free slots under `QUEUE_MAX_CONCURRENT_SENDS` (default `10`, 1 to 500), the cap on sends in flight per process. A slow receiver holds its slot instead of making the queue open more connections; sends waiting for a busy MX (`MAIL_MX_CONCURRENCY`) hold theirs too. Raise the cap for high volume to many different domains; mind your IP reputation. Any other value refuses to boot. Each batch is shared across API keys round-robin (#258), so one key's backlog cannot delay another key's mail.

> `IDEMPOTENCY_KEY_TTL_HOURS` (#188): how long an `Idempotency-Key` sent on `POST /api/v1/emails/send` is remembered (default `24`, 1 to 168). Within it, a retry with the same key and body returns the first response (with `Idempotent-Replayed: true`) instead of sending again; after it, the key is reusable. Each key keeps a snapshot of its first response for this long, without message content (no subject, body or custom headers: ids, addresses, status and warnings only), so the storage overhead is small; a replay after the email is trashed or purged returns the original ids and status with the content fields `null`. The purge worker deletes expired keys every 6 hours. Anything else refuses to boot.

> `WEBHOOKS_MAX_PER_API_KEY` / `WEBHOOK_DELIVERY_RETENTION_DAYS` (#258): per-key webhook limits. A key may have at most `WEBHOOKS_MAX_PER_API_KEY` webhooks (default `10`, 1 to 100); one more is refused with `422 WEBHOOK_LIMIT_REACHED`, and webhooks already over a lowered cap are kept. Finished webhook deliveries (`delivered` and `failed`) are deleted by the hourly cleanup once their last change is older than `WEBHOOK_DELIVERY_RETENTION_DAYS` (default `30`, 1 to 365); `failed` rows used to be kept forever, so raise it if you rely on them for forensics. Pending deliveries are never deleted. Any other value refuses to boot. Replays are limited to 5 per delivery per hour (not configurable; in memory, per replica).

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

Every account sees its own signed-in devices at **Active sessions** (#281, in the Account group of the sidebar): browser and system, IP address, signed in at, last active, and, when you set up GeoIP below, an approximate location. A user can sign out one device or every other device from there. With `SYSTEM_MAIL_FROM` set, a password sign-in from a browser the account has not used in the last 30 days also emails the account an alert (#282); BunMail recognizes the browser by a long-lived `bm_device` cookie, so a changing IP does not count as a new device.

### Two-factor authentication (#220)

Every account can turn on two-factor authentication at **Two-factor** (Account group of the sidebar): scan the QR code with an authenticator app (Aegis, 2FAS, Google Authenticator, 1Password, Bitwarden and the like), enter its 6-digit code, and keep the ten recovery codes shown once. From then on, signing in asks for a code from the app after the password. **Turn it on for the owner account**: the owner can do everything, and a leaked password alone is then not enough.

`REQUIRE_2FA` makes it mandatory: `owner` for the owner, `admin` for admins and the owner (default `none`). An account it covers without 2FA is sent to its Two-factor page on every request until it enrols, so nobody is locked out, but enable 2FA on those accounts first if you want a smooth switch. Anything but `none`, `owner` or `admin` refuses to start.

Turning it on asks for the current password. With `SYSTEM_MAIL_FROM` set, the account gets an email (no links) when 2FA is turned on or off, its recovery codes are replaced, a reset removes it, or someone enters the right password and then keeps entering wrong codes (change the password if that was not you).

**Lost phone.** Sign in with a recovery code (each works once). Without one: an admin or the owner issues a **Reset password** link on the Users page; completing it sets a new password and removes the account's 2FA (enrol again afterwards). For the owner, run `docker compose exec app bun run src/db/reset-owner.ts` and complete the printed link: that removes the owner's 2FA too. Shell access is the trust boundary of that path.

The TOTP secrets are stored encrypted with `DKIM_ENCRYPTION_KEY` (like DKIM keys and webhook secrets). If you rotate that key without re-encrypting, existing authenticator codes stop working (recovery codes still do; reset to re-enrol).

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

> **Set `DASHBOARD_TRUSTED_PROXY_HOPS=1`** once BunMail is behind one of these proxies. Both configs above forward `X-Forwarded-For`, and the dashboard login throttle (#109) reads the real client IP from it (rightmost entry) instead of the proxy's socket IP, so lockouts are per-attacker, not shared. **Keep BunMail's `:3000` bound to localhost / firewalled so the only path in is through the proxy**; otherwise a direct request could forge `X-Forwarded-For` and get a fresh throttle bucket per request. The default `docker-compose.yml` publishes `3000` on all interfaces, and Docker-published ports bypass UFW: change the app's `ports` line to `"127.0.0.1:${PORT:-3000}:${PORT:-3000}"` when a proxy runs on the same host. BunMail logs `Request bypassed the trusted proxy` (at most once an hour, #256) when a request arrives with fewer `X-Forwarded-For` entries than `DASHBOARD_TRUSTED_PROXY_HOPS`.

## Firewall Rules

| Port | Protocol | Direction | Purpose                    |
|------|----------|-----------|----------------------------|
| 25   | TCP      | Outbound  | Send emails to MX servers  |
| 25   | TCP      | Inbound   | Receive inbound emails     |
| 587  | TCP      | Inbound   | SMTP submission: apps sending *through* BunMail (only if `SMTP_SUBMISSION_ENABLED=true`; restrict to the networks your apps live on) |
| 443  | TCP      | Inbound   | HTTPS (reverse proxy)      |
| 3000 | TCP      | (none)    | HTTP API + dashboard, loopback only; reached through the proxy on 443 |

> **SMTP submission (#120).** To let other apps (Infisical, Netbird, Dify, a Nodemailer backend, …) send through BunMail over SMTP, set `SMTP_SUBMISSION_ENABLED=true`, publish the submission port in your `docker-compose.override.yml` (see `docker-compose.override.example.yml`), and open port 587 to those apps only. They authenticate with a `bm_live_…` API key as the password. Full setup and integration snippets: [docs/smtp-submission.md](smtp-submission.md).

## Runs as non-root

The container runs as the unprivileged `bun` user (uid 1000), not root (#167). The app only reads from disk, so a compromise can't modify its own code.

**Low ports (25, 587).** A non-root process can only bind ports below 1024 when the kernel setting `net.ipv4.ip_unprivileged_port_start` is `0` inside the container. `docker-compose.yml` pins it:

```yaml
sysctls:
  net.ipv4.ip_unprivileged_port_start: 0
```

It's scoped to the container's own network namespace and changes nothing on the host. Docker 20.10+ already defaults to it; the pin makes it explicit. On Kubernetes it's an allowed "safe" sysctl (set it in the pod's `securityContext.sysctls`). If your platform forbids it, run the servers on high ports inside the container instead (`SMTP_PORT=2525`, `SMTP_SUBMISSION_PORT=2587`) and publish them as `25:2525` and `587:2587`.

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

Check if your IP is blacklisted:

```bash
# Check major blacklists
# Visit: https://mxtoolbox.com/blacklists.aspx
# Enter: YOUR_SERVER_IP
```

### 6. Email Content Best Practices

Even with perfect DNS, bad content triggers spam filters:

- **Always include a plain text version**: use both `html` and `text` fields in the API
- **Avoid spam trigger words**: "free", "limited time", "act now", excessive caps/exclamation marks
- **Include an unsubscribe link**: required by most email providers for bulk mail. With an `https://` `APP_BASE_URL`, every single-recipient email gets a one-click `List-Unsubscribe` link that BunMail turns into a suppression (#249); send bulk mail one recipient per message, without cc or bcc, so it carries one
- **Use a real From address**: `hello@yourdomain.com` is better than `noreply@yourdomain.com`
- **Don't send HTML-only**: always include a text fallback
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
[ ] IP not on any blacklists
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
