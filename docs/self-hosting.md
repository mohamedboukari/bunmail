# Self-Hosting Guide

How to deploy BunMail on your own server so emails are actually delivered.

## Requirements

- A VPS with **outbound port 25 open** (Hetzner, OVH, or any dedicated server)
- A domain name you control (for DNS records)
- Docker + Docker Compose

> Most cloud providers (AWS, GCP, Azure) block outbound port 25 by default. Use a provider that allows SMTP traffic.

## 1. Server Setup

```bash
# SSH into your server
ssh root@your-server-ip

# Install Docker (if not already installed)
curl -fsSL https://get.docker.com | sh

# Clone BunMail
git clone https://github.com/your-username/bunmail.git
cd bunmail

# Configure environment
cp .env.example .env
```

Edit `.env`:

```env
BUNMAIL_ENV=production
DATABASE_URL=postgres://bunmail:bunmail@db:5432/bunmail
MAIL_HOSTNAME=mail.yourdomain.com
DASHBOARD_PASSWORD=your-secure-password
SESSION_SECRET=generate-a-random-string-here
SMTP_ENABLED=true
SMTP_PORT=25
```

## 2. DNS Records

Add these DNS records for `yourdomain.com`:

### A Record (server)

| Type | Host                  | Value            |
|------|-----------------------|------------------|
| A    | `mail.yourdomain.com` | `YOUR_SERVER_IP` |

### MX Record (for receiving)

| Type | Host              | Value                  | Priority |
|------|-------------------|------------------------|----------|
| MX   | `yourdomain.com`  | `mail.yourdomain.com`  | 10       |

### SPF Record

| Type | Host              | Value                              |
|------|-------------------|------------------------------------|
| TXT  | `yourdomain.com`  | `v=spf1 a mx ip4:YOUR_SERVER_IP ~all` |

### DKIM Record

After registering your domain via the API or dashboard, BunMail auto-generates DKIM keys. The DNS record you need to add is shown on the domain detail page.

| Type | Host                                 | Value                    |
|------|--------------------------------------|--------------------------|
| TXT  | `bunmail._domainkey.yourdomain.com`  | `v=DKIM1; k=rsa; p=...` |

### DMARC Record

| Type | Host                    | Value                                                  |
|------|-------------------------|--------------------------------------------------------|
| TXT  | `_dmarc.yourdomain.com` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@yourdomain.com` |

### PTR Record (Reverse DNS)

Contact your VPS provider to set the PTR record for your server IP to `mail.yourdomain.com`. This is critical for deliverability.

## 3. Start BunMail

```bash
docker compose up -d
```

This starts:
- **BunMail** on port 3000 (HTTP API + Dashboard)
- **PostgreSQL** on port 5432 (internal only)
- **Inbound SMTP** on port 25 (if enabled)

Migrations run automatically on boot.

## 4. Reverse Proxy (Recommended)

Use Caddy or Nginx as a reverse proxy for HTTPS:

### Caddy (automatic HTTPS)

```
mail.yourdomain.com {
    reverse_proxy localhost:3000
}
```

### Nginx

```nginx
server {
    listen 443 ssl;
    server_name mail.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/mail.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mail.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 5. Verify Setup

```bash
# Create your first API key
curl -X POST https://mail.yourdomain.com/api/v1/api-keys \
  -H "Authorization: Bearer YOUR_SEED_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Production"}'

# Register your domain
curl -X POST https://mail.yourdomain.com/api/v1/domains \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "yourdomain.com"}'

# Verify DNS records
curl -X POST https://mail.yourdomain.com/api/v1/domains/DOM_ID/verify \
  -H "Authorization: Bearer YOUR_KEY"

# Send a test email
curl -X POST https://mail.yourdomain.com/api/v1/emails/send \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "hello@yourdomain.com",
    "to": "you@gmail.com",
    "subject": "BunMail works!",
    "html": "<h1>Hello from BunMail</h1>"
  }'
```

## Firewall Rules

| Port | Protocol | Direction | Purpose                    |
|------|----------|-----------|----------------------------|
| 25   | TCP      | Outbound  | Send emails to MX servers  |
| 25   | TCP      | Inbound   | Receive inbound emails     |
| 443  | TCP      | Inbound   | HTTPS (reverse proxy)      |
| 3000 | TCP      | Inbound   | HTTP API (or via proxy)    |

## Troubleshooting

**Emails land in spam:**
- Ensure SPF, DKIM, and DMARC records are correctly configured
- Ensure PTR record matches `MAIL_HOSTNAME`
- Check your server IP reputation at [MXToolbox](https://mxtoolbox.com/blacklists.aspx)

**"Failed to connect" errors:**
- Outbound port 25 is blocked — contact your VPS provider
- DNS resolution issues — check with `dig MX example.com`

**Dashboard not loading:**
- Check `DASHBOARD_PASSWORD` is set in `.env`
- Check the reverse proxy is forwarding to port 3000
