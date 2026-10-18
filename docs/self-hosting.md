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
# Number of trusted reverse-proxy hops: set to 1 when BunMail runs behind a
# single proxy (see section 4) so dashboard login rate limiting (#109) keys off
# the real client IP instead of the proxy's. Default 0 (raw socket IP).
DASHBOARD_TRUSTED_PROXY_HOPS=1
# Optional: public base URL, used for the dashboard link in inbound notifications,
# the one-time owner setup link and invitation links
APP_BASE_URL=https://mail.yourdomain.com
# Optional: sender of invitation emails (a DKIM-verified domain registered in
# BunMail); unset = the inviter copies the link from the dashboard
SYSTEM_MAIL_FROM=noreply@yourdomain.com
# Optional: days an invitation link stays valid (1 to 90, default 7)
INVITE_EXPIRY_DAYS=7
# Optional: inbound notifications (per-domain notify_email is the opt-in)
INBOUND_NOTIFY_ENABLED=true
INBOUND_NOTIFY_FROM_LOCAL=notifications
```

> `MAIL_HOSTNAME` is **required in production** (#242): it is the SMTP EHLO name and the Message-ID domain of every email. BunMail refuses to start if it is unset, `localhost`, an IP address, not fully qualified, or a placeholder (`*.example.com`, `*.yourdomain.com`, `.test`, `.local`). Use this server's real hostname, whose A record points at the server and which the sending IP's PTR resolves to (see the reverse DNS section below).

> `BUNMAIL_OWNER_EMAIL` is **required in production** (#215): the email address of the dashboard owner account. BunMail refuses to start if it is unset, and refuses a malformed address or one over 254 characters in every environment (development only warns and skips the owner bootstrap when it is unset). It is stored lowercased. On first boot BunMail creates the owner and logs a one-time setup link (see [Claim the owner account](#claim-the-owner-account)). While setup is pending, a changed value updates the stored owner email on the next boot. After setup the database is the source of truth: changing the variable later only logs a warning. This account is the only way into the dashboard (#216): with the variable unset, development has no dashboard login and logs a warning at boot.

> Generate a DKIM encryption key: `openssl rand -base64 32`. **Required**: boot fails with a clear error if missing or not 32 bytes after base64 decode. Encrypts every domain's DKIM private key at rest with AES-256-GCM (#23). See [SECURITY.md](../SECURITY.md#dkim-private-key-encryption-at-rest) for the format and rotation procedure.

> `TRASH_RETENTION_DAYS`: how long soft-deleted emails (outbound and inbound) stay in trash before being permanently purged. Default `7`.

> `APP_BASE_URL`: public base URL of this instance (no trailing slash). Used to build the "view in dashboard" link in inbound notification emails (leave unset to omit it), the owner setup link logged on first boot, and invitation links (#217). When unset, the setup link falls back to `http://localhost:PORT`, which you can still open through an SSH tunnel; invitation links would too, so without a usable `APP_BASE_URL` BunMail never emails an invitation and shows the link to the inviter instead: set it before inviting anyone.

> `SYSTEM_MAIL_FROM` / `INVITE_EXPIRY_DAYS`: dashboard invitations (#217). Admins and the owner invite teammates from the dashboard (**Invite teammates** on the home page). When `SYSTEM_MAIL_FROM` is set to an address on a domain you registered in BunMail and whose DKIM record is verified, BunMail emails the accept link from it, signed with that domain's key. When it is unset, or the domain is missing or unverified, or the send fails, the invitation is still created and the inviter sees the link once on the Invitations page to send by hand (share it privately: anyone with it can create the account). A malformed `SYSTEM_MAIL_FROM` refuses to boot. `INVITE_EXPIRY_DAYS` (default `7`, a whole number from `1` to `90`, anything else refuses to boot) sets how long a link stays valid. See [docs/dashboard.md](dashboard.md#invitations-217).

> `INBOUND_NOTIFY_ENABLED` / `INBOUND_NOTIFY_FROM_LOCAL`: inbound notifications (#106). When a domain has a `notify_email` set, received mail for it triggers a summary email from `<INBOUND_NOTIFY_FROM_LOCAL>@<domain>` (default `notifications`). `INBOUND_NOTIFY_ENABLED=false` is a global kill switch. See [docs/inbound.md](inbound.md#inbound-notifications-106).

> `DASHBOARD_TRUSTED_PROXY_HOPS`: the dashboard login throttle (#109) rate-limits failed logins per client IP. Behind a reverse proxy (section 6) the socket IP is the proxy's, so set this to the number of trusted proxy hops (`1` for a single nginx/Caddy/Cloudflare): BunMail then reads the real client from the Nth-from-right `X-Forwarded-For` entry. Leave at `0` only if BunMail is exposed directly. **Make sure the origin is reachable only through the proxy** (don't expose `:3000`), otherwise `X-Forwarded-For` can be forged. Tune the limits with `DASHBOARD_LOGIN_RATE_LIMIT_MAX` (default `5`) and `DASHBOARD_LOGIN_RATE_LIMIT_WINDOW` (seconds, default `900`). See [docs/dashboard.md](dashboard.md#brute-force-protection-109).

> `API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW`: per-API-key request limit on the REST API (default `100` requests per `60` seconds, then `429` with `Retry-After`). Raise it if one key legitimately makes more calls than that, for example a high-volume sender. Boot fails on a non-positive or non-integer value.

> `MAIL_ALLOW_PRIVATE_MX`: by default BunMail refuses to deliver to an MX host that resolves to a private, loopback or link-local address, since recipient domains (and their MX records) are chosen by API callers. Set `true` only if you deliberately deliver to an internal mail server.

> `MAIL_RETRY_MAX_AGE_HOURS`: how long an email that keeps failing temporarily (4xx replies such as greylisting or rate limits, connection errors) is retried before it is marked `failed`. Default `48`. Retries back off: 5 m, 15 m, 30 m, 1 h, 2 h, then every 4 h.

## 2. DNS Records

Add these DNS records for `yourdomain.com` in your domain registrar (Cloudflare, Namecheap, etc.):

### A Record (points your mail subdomain to the server)

| Type | Host   | Value            |
|------|--------|------------------|
| A    | `mail` | `YOUR_SERVER_IP` |

### MX Record (tells other servers where to deliver mail)

| Type | Host | Value                  | Priority |
|------|------|------------------------|----------|
| MX   | `@`  | `mail.yourdomain.com`  | 10       |

### SPF Record (authorizes your server to send email for this domain)

| Type | Host | Value                                    |
|------|------|------------------------------------------|
| TXT  | `@`  | `v=spf1 a mx ip4:YOUR_SERVER_IP -all`    |

### DMARC Record (tells receivers what to do with unauthenticated mail)

| Type | Host     | Value                                                          |
|------|----------|----------------------------------------------------------------|
| TXT  | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@yourdomain.com` |

### DKIM Record (added after registering your domain in BunMail, see step 4)

| Type | Host                 | Value                    |
|------|----------------------|--------------------------|
| TXT  | `bunmail._domainkey` | `v=DKIM1; k=rsa; p=...`  |

### PTR Record (Reverse DNS)

Contact your VPS provider to set the PTR record for your server IP to `mail.yourdomain.com`. This is critical for deliverability, without it, many mail servers will reject your emails.

## 3. Start BunMail

```bash
cd /root/bunmail
docker compose up -d --build
```

This starts:
- **BunMail** on port `$PORT` (HTTP API + Dashboard, default 3000)
- **PostgreSQL**, published on `127.0.0.1:5432` only (loopback, from `docker-compose.override.yml`, for local development). To keep it on the compose network only, with nothing published, start with `docker compose -f docker-compose.yml up -d --build`, which skips the override file
- **Inbound SMTP** on port `$SMTP_PORT` (default 2525; use 25 in production: requires `SMTP_ENABLED=true`)

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

### Seed your first API key

```bash
docker compose exec app bun run src/db/seed.ts
```

**Save the key from the output: it's shown once!**

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

The dashboard lets you manage emails, domains, API keys, and view delivery status.

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

> **Set `DASHBOARD_TRUSTED_PROXY_HOPS=1`** once BunMail is behind one of these proxies. Both configs above forward `X-Forwarded-For`, and the dashboard login throttle (#109) reads the real client IP from it (rightmost entry) instead of the proxy's socket IP, so lockouts are per-attacker, not shared. Keep BunMail's `:3000` bound to localhost / firewalled so the only path in is through the proxy; otherwise a direct request could forge `X-Forwarded-For`.

## Firewall Rules

| Port | Protocol | Direction | Purpose                    |
|------|----------|-----------|----------------------------|
| 25   | TCP      | Outbound  | Send emails to MX servers  |
| 25   | TCP      | Inbound   | Receive inbound emails     |
| 587  | TCP      | Inbound   | SMTP submission: apps sending *through* BunMail (only if `SMTP_SUBMISSION_ENABLED=true`; restrict to the networks your apps live on) |
| 443  | TCP      | Inbound   | HTTPS (reverse proxy)      |
| 3000 | TCP      | Inbound   | HTTP API (or via proxy)    |

> **SMTP submission (#120).** To let other apps (Infisical, Netbird, Dify, a Nodemailer backend, …) send through BunMail over SMTP, set `SMTP_SUBMISSION_ENABLED=true`, uncomment the submission port line in `docker-compose.yml`, and open port 587 to those apps only. They authenticate with a `bm_live_…` API key as the password. Full setup and integration snippets: [docs/smtp-submission.md](smtp-submission.md).

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

### Upgrading to account login (#216)

Account login replaces the shared `DASHBOARD_PASSWORD` and the `SESSION_SECRET`-signed cookie. Pending migrations (including `0017`, which adds the session rotation columns) apply on container start as usual. The API, SMTP and the queue are not affected; only the dashboard is unreachable until the owner is claimed. In order:

1. **Before you pull**, add `BUNMAIL_OWNER_EMAIL=you@yourdomain.com`, a real `MAIL_HOSTNAME` (#242) and `APP_BASE_URL` to `.env`. Production refuses to start without the first two, so a `git pull` and rebuild without them crash-loops.
2. Pull and rebuild as above.
3. **Everyone is signed out once:** old dashboard cookies are rejected and cleared.
4. If the owner has not set a password yet, claim it: `docker compose logs app | grep 'Owner setup link'`, open the link, choose a password (15 or more characters). Setup signs you in. If the link expired or was lost, restart the container (a new link is logged while setup is pending) or run `docker compose exec app bun run src/db/reset-owner.ts`. If you already claimed the owner on an earlier version, sign in with that email and password.
5. Remove `DASHBOARD_PASSWORD` and `SESSION_SECRET` from `.env`. They do nothing any more; while they are set, every boot logs `Dashboard auth env vars are no longer used since #216, remove from .env`.

## Preventing Spam (Deliverability Guide)

If your emails land in spam, follow this checklist. Each step contributes to your sender reputation: skip none of them.

### 1. DNS Authentication (Required)

All three must be set correctly. Verify with:

```bash
# SPF
dig TXT yourdomain.com +short
# Expected: "v=spf1 a mx ip4:YOUR_SERVER_IP -all"

# DKIM
dig TXT bunmail._domainkey.yourdomain.com +short
# Expected: "v=DKIM1; k=rsa; p=MIIBIj..."

# DMARC
dig TXT _dmarc.yourdomain.com +short
# Expected: "v=DMARC1; p=quarantine; rua=mailto:postmaster@yourdomain.com"
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

### 3. MX Record (Required)

Even if you only send email, having an MX record tells other servers your domain is a legitimate mail domain:

```bash
dig MX yourdomain.com +short
# Expected: 10 mail.yourdomain.com.
```

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
- **Include an unsubscribe link**: required by most email providers for bulk mail
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
[ ] MX record pointing to mail.yourdomain.com
[ ] A record for mail.yourdomain.com → server IP
[ ] PTR (reverse DNS) set to mail.yourdomain.com
[ ] Server hostname matches PTR
[ ] MAIL_HOSTNAME in .env matches PTR
[ ] IP not on any blacklists
[ ] Tested with mail-tester.com (aim for 8+/10)
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
