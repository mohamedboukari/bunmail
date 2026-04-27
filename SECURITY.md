# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.x     | :white_check_mark: |

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Use [GitHub's private vulnerability reporting](https://github.com/mohamedboukari/bunmail/security/advisories/new) to report security issues. This ensures the report stays private until a fix is available.

### What to include

- Description of the vulnerability
- Steps to reproduce
- Impact assessment (what an attacker could do)
- Suggested fix (if you have one)

### Response timeline

- **Acknowledgment:** within 48 hours
- **Initial assessment:** within 1 week
- **Fix + disclosure:** as soon as a patch is ready (typically within 2 weeks)

## Scope

The following are in scope:

- API authentication bypass
- SQL injection or other injection attacks
- Cross-site scripting (XSS) in the dashboard
- SMTP relay abuse (open relay, header injection)
- DKIM private key exposure
- Information disclosure (API keys, secrets, stack traces)
- Denial of service via API abuse

## Security Best Practices for Self-Hosters

- Always set a strong `DASHBOARD_PASSWORD` — BunMail refuses to boot in production with an empty value (`BUNMAIL_ENV=production` + empty `DASHBOARD_PASSWORD` throws at startup) because the dashboard reads/writes across all API keys.
- Never expose the dashboard publicly without a reverse proxy + TLS
- Rotate API keys periodically
- Keep BunMail and its dependencies up to date
- Use a firewall to restrict SMTP port access (2525)

## Outbound TLS

BunMail enables **opportunistic STARTTLS** when delivering to recipient MX servers — every connection that advertises STARTTLS will be upgraded to TLS, and only legacy receivers that don't speak TLS at all stay in plaintext. Cipher / cert validation is intentionally relaxed (`rejectUnauthorized: false`) because MTA-to-MTA delivery routinely encounters self-signed and expired certificates; refusing them would mean dropping legitimate mail.

If you need to **require** TLS for specific recipient domains (e.g. internal compliance), that's tracked in [#42](https://github.com/mohamedboukari/bunmail/issues/42). Per-message TLS observability metrics (cipher used, validation state) are tracked in [#37](https://github.com/mohamedboukari/bunmail/issues/37).
