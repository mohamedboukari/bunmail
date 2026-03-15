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
SMTP_ENABLED=true
SMTP_PORT=25
LOG_LEVEL=info
```

> Generate a session secret: `openssl rand -hex 32`

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
| TXT  | `@`  | `v=spf1 a mx ip4:YOUR_SERVER_IP ~all`    |

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

## Troubleshooting

**Container keeps restarting:**
- Check logs: `docker compose logs app`
- Common cause: missing env vars or database connection issues

**Emails land in spam:**
- Ensure SPF, DKIM, and DMARC records are correctly configured
- Ensure PTR (reverse DNS) record matches `MAIL_HOSTNAME`
- Check your server IP reputation at [MXToolbox](https://mxtoolbox.com/blacklists.aspx)
- New server IPs have no reputation — start with low volume and build up

**"Failed to connect" errors:**
- Outbound port 25 is blocked — contact your VPS provider or choose one from the recommended list
- DNS resolution issues — check with `dig MX example.com`

**Dashboard not loading:**
- Check `DASHBOARD_PASSWORD` is set in `.env`
- Check the container is running: `docker compose ps`
- If using a reverse proxy, verify it's forwarding to port 3000

**Migration errors:**
- Check logs: `docker compose logs app`
- Ensure `DATABASE_URL` is correct and PostgreSQL is healthy: `docker compose ps`
