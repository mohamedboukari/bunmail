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

For the full picture: assets we protect, attackers we model against, controls already in code, and the controls that **stay with the operator** (firewall, disk encryption, reverse-proxy TLS, IP-reputation monitoring), see [THREAT_MODEL.md](THREAT_MODEL.md).

## Security Best Practices for Self-Hosters

- **The dashboard login is the owner account (#216).** The dashboard reads and writes across all API keys, so production refuses to boot without `BUNMAIL_OWNER_EMAIL`, the account that signs in (the shared `DASHBOARD_PASSWORD` and `SESSION_SECRET` were removed in 0.10.0; a value left in `.env` only logs a boot warning). Choose a strong owner password (15 characters minimum, argon2id). Sessions are server-side and revocable: **Log out** ends one, a session expires after 24 h without use and 7 days after sign-in at the latest, and the session token rotates about once a minute. A replaced token presented after its 30 s grace period is treated as stolen and signs the account out of every session (`Session token reuse detected: all sessions of the user revoked` at `warn`); investigate that line if nobody lost a connection at the time.
- **Invite teammates deliberately (#217).** Admins and the owner invite accounts from the dashboard (the owner grants admin or member, an admin grants member; nobody can be invited as owner, enforced in the service and by a database check). Every role reads all mail, so invite only people who may see it. Set `SYSTEM_MAIL_FROM` to an address on a domain registered and DKIM-verified in BunMail so the accept link is emailed, signed; without it the inviter sees the link once on the Invitations page and must deliver it privately, since **anyone holding the link creates the account** until it is used or expires (`INVITE_EXPIRY_DAYS`, default 7). Set `APP_BASE_URL` (without a usable one, links are never emailed and are shown to the inviter instead). Disabling, deleting or demoting an inviter kills the invitations they sent. Revoke invitations you no longer need; every acceptance is logged at `warn` (`Invitation accepted`, with the new user, the inviter and the client IP). When someone leaves, deactivate or remove their account at **Users** (#218): it signs them out everywhere at once, revokes the invitations they sent and disables every API key they created (#219; reactivating the account does not re-enable them). **Upgrading to #219:** keys created before it are attributed to the owner; after inviting other accounts, rotate any admin key you shared with them, because account actions only reach the keys an account created.
- **Hand over password reset links privately (#277).** When an admin or member forgets their password, an admin (for members) or the owner (for admins and members) clicks **Reset password** at **Users**. The link is shown **once**, to that admin's session only, and is never emailed: deliver it over a private channel, since **anyone holding it can set the account's password** until it is used or expires (**1 hour**). Issuing a new link kills the previous one; deactivating the account or the issuer kills it too. Using it signs the account out of every session. Every use is logged at `warn` (`Password reset completed`, with the account, the issuer and the client IP); investigate one nobody expected. The owner's password is reset only with the `reset-owner` script.
- **Change a password you suspect is known (#279).** Any account, the owner included, can change its own password at **Change password** in the sidebar with its current password. It signs the account out on every other device and browser at once, and revokes its open reset links, so it also cuts off a stolen session. Guessing the current password through the form is throttled like a login (`DASHBOARD_LOGIN_RATE_LIMIT_*`, per account and per client IP). Every change is logged at `warn` (`Password changed`).
- **Review your signed-in devices (#281).** Every account sees its own live sessions at **Active sessions** in the sidebar (device, IP, signed in, last active) and can sign out one device or every other device at once; sign out anything you do not recognize, then change your password. An approximate location per session is optional: `GEOIP_DB_PATH` (an offline DB-IP Lite or GeoLite2 file, no third party involved) or `GEOIP_PROVIDER=ipinfo` (sends every sign-in IP to ipinfo.io; weigh the privacy trade-off). See [docs/self-hosting.md](docs/self-hosting.md#approximate-session-locations-geoip-281).
- **Newly created API keys and webhook secrets are shown once, to their creator only (#132, #280).** So is an invitation link whose email did not go out (#217), and a password reset link (#277). The dashboard never puts them in a URL; a one-time reveal token (60 s, single use) can be redeemed only by the same user and session, on the matching page. The store is in memory per replica: behind a load balancer without sticky sessions, a reveal may miss; revoke and recreate the key.
- **Set `BUNMAIL_OWNER_EMAIL` and claim the owner account promptly (#215).** Production refuses to boot without it. On first boot BunMail logs a one-time setup link (`Owner setup link`, valid 24 h, single use). Until it is used, **anyone who can read the app logs can open it first** and claim the owner account, so claim it right after the first deploy, and keep logs away from third parties during that window. Before setup each restart replaces the link; with several replicas only the most recently logged link works. Recovery (`docker compose exec app bun run src/db/reset-owner.ts`) needs shell access to the host and prints a fresh link to the operator's terminal. It also signs the owner out of every dashboard session as soon as it runs (#216), and completing the new link does so again, so if a setup link may have been used by someone else, or a session cookie may have leaked, run the reset script and set a new owner password. Until that link is completed the old password still signs in. The server logs `Owner setup completed` at `warn` with the client IP on every successful setup, so an unexpected claim is visible.
- Never expose the dashboard publicly without a reverse proxy + TLS
- Behind a reverse proxy, set `DASHBOARD_TRUSTED_PROXY_HOPS` to the number of trusted hops (`1` for a single nginx/Caddy/Cloudflare) so the dashboard login throttle (#109) rate-limits per real client IP instead of the proxy's. Keep the origin reachable only through the proxy, or `X-Forwarded-For` can be forged. Login brute-force protection (5 failed logins / 15 min per IP → HTTP 429) is on by default; tune via `DASHBOARD_LOGIN_RATE_LIMIT_*`. It is per IP only (no per-account lockout, which would let anyone lock the owner out), so the owner password's length is what stops guessing spread across many IPs.
- Rotate API keys periodically
- **Hand out restricted keys, and set their allowed-senders (#130, #126).** Keys are **admin** or **restricted**; only admin keys can manage keys/domains/read inbound. Existing keys upgraded to **admin**: from the dashboard, **demote any key you give to an app or developer** to restricted (or create it restricted). Then set that key's `allowedSenders` to the exact `From` addresses it may use, so it can't impersonate anyone else at your domain (sends from anything else are rejected: 403 / SMTP 550). Treat an **admin** key like the dashboard owner password.
- Keep BunMail and its dependencies up to date
- **The container runs as non-root** (uid 1000, #167). Keep the `net.ipv4.ip_unprivileged_port_start: 0` sysctl from `docker-compose.yml` if you bind ports 25/587, and make any mounted TLS private key readable by uid 1000. See [docs/self-hosting.md](docs/self-hosting.md#runs-as-non-root).
- Use a firewall to restrict SMTP port access (2525)
- **SMTP submission (#120), if enabled** (`SMTP_SUBMISSION_ENABLED=true`, port 587): apps authenticate with an API key as the password. Plaintext AUTH is **refused by default** (#133), with neither a cert nor an explicit opt-in the server won't start, so a full-privilege key can't leak in cleartext. To run plaintext on a trusted network (same host / private Docker network) set `SMTP_SUBMISSION_ALLOW_INSECURE=true`; to expose it beyond that, set `SMTP_SUBMISSION_TLS_CERT`/`SMTP_SUBMISSION_TLS_KEY` (STARTTLS) and firewall port 587 to the specific apps that use it. The per-IP failed-AUTH throttle (`SMTP_SUBMISSION_AUTH_RATE_LIMIT_*`) is on by default. See [docs/smtp-submission.md](docs/smtp-submission.md).

## DKIM Private Key Encryption at Rest

The same key and format also protect **webhook signing secrets** (#259): with one, anyone can sign requests every receiver accepts as genuine (fake `email.bounced` or `email.received`). They are encrypted on create, decrypted only in the delivery worker, and a boot pass ([`src/db/encrypt-webhook-secrets.ts`](src/db/encrypt-webhook-secrets.ts)) encrypts rows from before #259. Everything below about the key, the format and rotation applies to both.

Every domain registered through `POST /api/v1/domains` gets a freshly-generated 2048-bit RSA keypair. The **public** half is published in DNS (it's literally `v=DKIM1; k=rsa; p=...`), so storing it raw is fine. The **private** half is what an attacker would steal from a DB dump and use to forge signed mail under your domains forever, so it's encrypted at rest.

### Algorithm

- **Cipher:** AES-256-GCM (authenticated; tampering yields a decrypt error rather than a silently-forged plaintext).
- **Per-row IV:** 12 random bytes (NIST SP 800-38D recommendation), generated fresh on every encryption: two writes of the same key yield different ciphertexts.
- **Format:** stored as `v1:<base64-iv>:<base64-ciphertext>:<base64-tag>` so a future algorithm change can ship `v2:` alongside `v1:` without breaking existing rows.
- **Implementation:** [src/utils/crypto.ts](src/utils/crypto.ts): `encryptSecret` / `decryptSecret` / `isEncryptedSecret`.

### Setup

A `DKIM_ENCRYPTION_KEY` env var is **required** at boot (in both dev and prod: silently allowing dev to store plaintext is how prod accidents happen). Generate one with:

```bash
openssl rand -base64 32
```

Add it to `.env`. Treat it like a database password: never check in, never log, restrict file permissions (`chmod 600 .env`).

### Migration of existing rows

On first boot after upgrading, [`src/db/encrypt-domain-keys.ts`](src/db/encrypt-domain-keys.ts) scans the `domains` table and re-writes any row whose `dkim_private_key` is still plaintext PEM. This pass is idempotent: already-encrypted rows are skipped. You'll see one `Encrypted DKIM private key at rest` log entry per converted row, then `No DKIM keys needed encryption` on subsequent boots.

### Rotation

Rotation is a manual procedure for now; automated overlap (`DKIM_ENCRYPTION_KEY_PREVIOUS`) is tracked as a follow-up.

1. **Stop sending traffic** (drain the queue, take the API offline).
2. With the *current* key still set, run a one-shot script that decrypts every row's `dkim_private_key` to plaintext PEM, and every `webhooks.secret` to its plaintext, writing them back unencrypted.
3. Generate a new key (`openssl rand -base64 32`), update `.env`, set `DKIM_ENCRYPTION_KEY=<new>`.
4. Restart: the boot-time encrypters (DKIM keys and webhook secrets) see the now-plaintext rows and re-encrypt them under the new key. If any DKIM key was missed and is still encrypted under the old key, production refuses to start and names the domains (#244): nothing is ever sent unsigned.
5. Resume traffic.

A safer rolling rotation (read with old key, write with new) needs both keys to coexist briefly, see the follow-up issue for the planned design.

### What's *not* protected by this

- **Application-level memory.** A core dump or live-process attacker still sees plaintext PEMs in queue-thread memory while a send is in flight.
- **Backup files containing both DB dump and `.env`.** If both leak together, the encryption is moot. Keep them on different rotation/storage tiers.
- **`dkim_public_key`.** Published in DNS, no threat: stored plaintext intentionally.

## Outbound TLS

BunMail enables **opportunistic STARTTLS** when delivering to recipient MX servers: every connection that advertises STARTTLS will be upgraded to TLS, and only legacy receivers that don't speak TLS at all stay in plaintext. Cipher / cert validation is intentionally relaxed (`rejectUnauthorized: false`) because MTA-to-MTA delivery routinely encounters self-signed and expired certificates; refusing them would mean dropping legitimate mail.

If you need to **require** TLS for specific recipient domains (e.g. internal compliance), that's tracked in [#42](https://github.com/mohamedboukari/bunmail/issues/42). Per-message TLS observability metrics (cipher used, validation state) are tracked in [#37](https://github.com/mohamedboukari/bunmail/issues/37).
