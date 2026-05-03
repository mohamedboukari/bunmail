# ───────────────────────────────────────────────────────
# BunMail — Multi-stage Dockerfile
#
# Stage 1 (install): resolves and installs dependencies
# Stage 2 (run):     copies source + node_modules, starts
#
# Base image is pinned to a specific Bun patch version (matches the
# version pinned in CI) for reproducibility. The run stage applies the
# latest Debian security patches at build time so Trivy's image scan
# doesn't flag CVEs that have a fix available upstream but haven't yet
# been re-cut in the official base image.
# ───────────────────────────────────────────────────────

# ── Stage 1: Install dependencies ──
FROM oven/bun:1.3.10 AS install

WORKDIR /app

# Copy only the files needed for dependency resolution. Both
# `package.json` and `bun.lock` are required for `--frozen-lockfile`,
# which makes the install deterministic — same versions every build.
COPY package.json bun.lock ./

# `--frozen-lockfile` aborts if the lockfile is missing/out-of-date,
# so a stale CI without the committed lockfile fails loud instead of
# silently re-resolving (which would invalidate the security scan).
# `--ignore-scripts` blocks postinstall hooks at build time; trusted
# postinstalls are allowlisted via `trustedDependencies` in package.json.
RUN bun install --frozen-lockfile --ignore-scripts

# ── Stage 2: Run ──
FROM oven/bun:1.3.10 AS run

# Apply latest Debian security patches. The base image rebuilds on a
# cadence, but new CVEs are published in between — running upgrade at
# build time pulls them in immediately. This is the same pattern the
# official Node/Python images recommend for hardened deployments.
# `--no-install-recommends` skips suggested-but-not-required packages
# to keep the image small, and we clean the apt cache to shrink the
# resulting layer.
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy installed node_modules from stage 1
COPY --from=install /app/node_modules ./node_modules

# Copy application source
COPY package.json bun.lock tsconfig.json drizzle.config.ts ./
COPY src/ ./src/

# Expose the HTTP API port and (optionally) the inbound SMTP port
EXPOSE 3000 2525

# Health check — Docker & orchestrators use this to determine container health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://localhost:3000/health'); if (!r.ok) process.exit(1);"

# Push schema to DB (creates/alters tables as needed) then start the server
CMD ["sh", "-c", "bun run db:push && bun run start"]
