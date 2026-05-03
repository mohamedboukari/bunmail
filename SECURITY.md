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

## Threat Model

For the full picture — assets we protect, attackers we model against, controls already in code, and the controls that **stay with the operator** (firewall, disk encryption, reverse-proxy TLS, IP-reputation monitoring) — see [THREAT_MODEL.md](THREAT_MODEL.md).

## Security Best Practices for Self-Hosters

- Always set a strong `DASHBOARD_PASSWORD` — BunMail refuses to boot in production with an empty value (`BUNMAIL_ENV=production` + empty `DASHBOARD_PASSWORD` throws at startup) because the dashboard reads/writes across all API keys.
- Never expose the dashboard publicly without a reverse proxy + TLS
- Rotate API keys periodically
- Keep BunMail and its dependencies up to date
- Use a firewall to restrict SMTP port access (2525)

## DKIM Private Key Encryption at Rest

Every domain registered through `POST /api/v1/domains` gets a freshly-generated 2048-bit RSA keypair. The **public** half is published in DNS (it's literally `v=DKIM1; k=rsa; p=...`), so storing it raw is fine. The **private** half is what an attacker would steal from a DB dump and use to forge signed mail under your domains forever — so it's encrypted at rest.

### Algorithm

- **Cipher:** AES-256-GCM (authenticated; tampering yields a decrypt error rather than a silently-forged plaintext).
- **Per-row IV:** 12 random bytes (NIST SP 800-38D recommendation), generated fresh on every encryption — two writes of the same key yield different ciphertexts.
- **Format:** stored as `v1:<base64-iv>:<base64-ciphertext>:<base64-tag>` so a future algorithm change can ship `v2:` alongside `v1:` without breaking existing rows.
- **Implementation:** [src/utils/crypto.ts](src/utils/crypto.ts) — `encryptSecret` / `decryptSecret` / `isEncryptedSecret`.

### Setup

A `DKIM_ENCRYPTION_KEY` env var is **required** at boot (in both dev and prod — silently allowing dev to store plaintext is how prod accidents happen). Generate one with:

```bash
openssl rand -base64 32
```

Add it to `.env`. Treat it like a database password: never check in, never log, restrict file permissions (`chmod 600 .env`).

### Migration of existing rows

On first boot after upgrading, [`src/db/encrypt-domain-keys.ts`](src/db/encrypt-domain-keys.ts) scans the `domains` table and re-writes any row whose `dkim_private_key` is still plaintext PEM. This pass is idempotent — already-encrypted rows are skipped. You'll see one `Encrypted DKIM private key at rest` log entry per converted row, then `No DKIM keys needed encryption` on subsequent boots.

### Rotation

Rotation is a manual procedure for now; automated overlap (`DKIM_ENCRYPTION_KEY_PREVIOUS`) is tracked as a follow-up.

1. **Stop sending traffic** (drain the queue, take the API offline).
2. With the *current* key still set, run a one-shot script that decrypts every row's `dkim_private_key` to plaintext PEM in memory.
3. Generate a new key (`openssl rand -base64 32`), update `.env`, set `DKIM_ENCRYPTION_KEY=<new>`.
4. Restart — the boot-time encrypter sees the now-plaintext rows and re-encrypts them under the new key.
5. Resume traffic.

A safer rolling rotation (read with old key, write with new) needs both keys to coexist briefly — see the follow-up issue for the planned design.

### What's *not* protected by this

- **Application-level memory.** A core dump or live-process attacker still sees plaintext PEMs in queue-thread memory while a send is in flight.
- **Backup files containing both DB dump and `.env`.** If both leak together, the encryption is moot. Keep them on different rotation/storage tiers.
- **`dkim_public_key`.** Published in DNS, no threat — stored plaintext intentionally.

## Outbound TLS

BunMail enables **opportunistic STARTTLS** when delivering to recipient MX servers — every connection that advertises STARTTLS will be upgraded to TLS, and only legacy receivers that don't speak TLS at all stay in plaintext. Cipher / cert validation is intentionally relaxed (`rejectUnauthorized: false`) because MTA-to-MTA delivery routinely encounters self-signed and expired certificates; refusing them would mean dropping legitimate mail.

If you need to **require** TLS for specific recipient domains (e.g. internal compliance), that's tracked in [#42](https://github.com/mohamedboukari/bunmail/issues/42). Per-message TLS observability metrics (cipher used, validation state) are tracked in [#37](https://github.com/mohamedboukari/bunmail/issues/37).
