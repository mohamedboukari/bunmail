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

> **Tip:** RackNerd offers ~$11/year VPS deals with port 25 open — check [racknerd.com/NewYear](https://www.racknerd.com/NewYear/) for current promotions.

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

**Option A — Public repo (git clone):**

```bash
git clone https://github.com/your-username/bunmail.git
cd bunmail
```

**Option B — Private repo (rsync from your machine):**

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
DASHBOARD_PASSWORD=your-secure-password
SESSION_SECRET=run-openssl-rand-hex-32-to-generate
DKIM_ENCRYPTION_KEY=run-openssl-rand-base64-32-to-generate
SMTP_ENABLED=true
SMTP_PORT=25
LOG_LEVEL=info
TRASH_RETENTION_DAYS=7
```

> Generate a session secret: `openssl rand -hex 32`
>
> Generate a DKIM encryption key: `openssl rand -base64 32`. **Required** — boot fails with a clear error if missing or not 32 bytes after base64 decode. Encrypts every domain's DKIM private key at rest with AES-256-GCM (#23). See [SECURITY.md](../SECURITY.md#dkim-private-key-encryption-at-rest) for the format and rotation procedure.

> `TRASH_RETENTION_DAYS` — how long soft-deleted emails (outbound and inbound) stay in trash before being permanently purged. Default `7`.

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

### DKIM Record (added after registering your domain in BunMail — see step 4)

| Type | Host                 | Value                    |
|------|----------------------|--------------------------|
| TXT  | `bunmail._domainkey` | `v=DKIM1; k=rsa; p=...`  |

### PTR Record (Reverse DNS)

Contact your VPS provider to set the PTR record for your server IP to `mail.yourdomain.com`. This is critical for deliverability — without it, many mail servers will reject your emails.

## 3. Start BunMail

```bash
cd /root/bunmail
docker compose up -d --build
```

This starts:
- **BunMail** on port 3000 (HTTP API + Dashboard)
- **PostgreSQL** on port 5432 (internal only)
- **Inbound SMTP** on port 25 (if `SMTP_ENABLED=true`)

Migrations run automatically on boot. Verify with:

```bash
# Check containers are running
docker compose ps

# Check logs
docker compose logs app

# Check health
curl http://localhost:3000/health
```

## 4. Initial Setup

### Seed your first API key

```bash
docker compose exec app bun run src/db/seed.ts
```

**Save the key from the output — it's shown once!**

### Register your domain (generates DKIM keys)

```bash
curl -X POST http://localhost:3000/api/v1/domains \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "yourdomain.com"}'
```

The response includes `dkimDnsRecord` — add it as a TXT record in your DNS:

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

Open `http://YOUR_SERVER_IP:3000/dashboard` in your browser. Log in with the `DASHBOARD_PASSWORD` you set in `.env`.

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

## Firewall Rules

| Port | Protocol | Direction | Purpose                    |
|------|----------|-----------|----------------------------|
| 25   | TCP      | Outbound  | Send emails to MX servers  |
| 25   | TCP      | Inbound   | Receive inbound emails     |
| 443  | TCP      | Inbound   | HTTPS (reverse proxy)      |
| 3000 | TCP      | Inbound   | HTTP API (or via proxy)    |

## Updating BunMail

```bash
cd /root/bunmail

# Pull latest code (or rsync again for private repos)
git pull

# Rebuild and restart
docker compose down && docker compose up -d --build
```

## Preventing Spam (Deliverability Guide)

If your emails land in spam, follow this checklist. Each step contributes to your sender reputation — skip none of them.

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

- **Start slow** — send 10-20 emails per day for the first week
- **Increase gradually** — double volume each week
- **Send to engaged recipients** — avoid sending to lists that haven't opted in
- **Monitor bounces** — high bounce rates destroy reputation fast

Check if your IP is blacklisted:

```bash
# Check major blacklists
# Visit: https://mxtoolbox.com/blacklists.aspx
# Enter: YOUR_SERVER_IP
```

### 6. Email Content Best Practices

Even with perfect DNS, bad content triggers spam filters:

- **Always include a plain text version** — use both `html` and `text` fields in the API
- **Avoid spam trigger words** — "free", "limited time", "act now", excessive caps/exclamation marks
- **Include an unsubscribe link** — required by most email providers for bulk mail
- **Use a real From address** — `hello@yourdomain.com` is better than `noreply@yourdomain.com`
- **Don't send HTML-only** — always include a text fallback
- **Keep image-to-text ratio reasonable** — don't send an email that's just one big image

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
- Check logs: `docker compose logs app`
- Common cause: missing env vars or database connection issues

**"Failed to connect" errors:**
- Outbound port 25 is blocked — contact your VPS provider or choose one from the recommended list
- DNS resolution issues — check with `dig MX example.com`

**Dashboard not loading:**
- Check `DASHBOARD_PASSWORD` is set in `.env`
- Check the container is running: `docker compose ps`
- If using a reverse proxy, verify it's forwarding to port 3000

**Migration errors:**
- Check logs: `docker compose logs app`
- Migrations run via the Bun-native runner at `src/db/migrate.ts` (#56) — drizzle-kit no longer ships in the runtime image. The runner reads the committed `drizzle/<n>_*.sql` files and tracks applied tags in the `__bunmail_migrations` table.
- Ensure `DATABASE_URL` is correct and PostgreSQL is healthy: `docker compose ps`

**Boot fails with `[config] Missing required environment variable: DKIM_ENCRYPTION_KEY`:**
- Add `DKIM_ENCRYPTION_KEY=$(openssl rand -base64 32)` to `.env`. Required since v0.4.x — the key encrypts DKIM private keys at rest. Boot fails loudly rather than silently storing plaintext.
