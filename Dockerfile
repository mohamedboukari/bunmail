# ───────────────────────────────────────────────────────
# BunMail — Multi-stage Dockerfile
#
# Three stages so the runtime image carries only what's needed at
# request time:
#
#   1. install    — Resolves dependencies. Runs `bun install` (no
#                   `--production` so dev deps like `drizzle-kit` and
#                   `eslint` are available in the build itself, even
#                   though they don't ship to the run stage).
#   2. prod-deps  — A second `bun install --production --frozen-lockfile`
#                   into a clean tree so the run stage gets node_modules
#                   without esbuild, drizzle-kit, eslint, knip, etc.
#                   This is what closed the ~36 esbuild Go-stdlib CVE
#                   findings in the Trivy image scan.
#   3. run        — Final image. Has Bun, the prod node_modules, the
#                   pre-generated SQL migration files (committed), and
#                   the runtime migrator (`src/db/migrate.ts`). No
#                   drizzle-kit at runtime.
#
# Base image is pinned to a specific Bun patch version (matches the
# version pinned in CI) for reproducibility. The run stage applies the
# latest Debian security patches at build time so Trivy's image scan
# doesn't flag CVEs that have a fix available upstream but haven't yet
# been re-cut in the official base image.
# ───────────────────────────────────────────────────────

# ── Stage 1: Install all dependencies (incl. dev) ──
FROM oven/bun:1.3.10 AS install

WORKDIR /app

# `bun.lock` is required for `--frozen-lockfile`, which makes the
# install deterministic — same versions every build.
COPY package.json bun.lock ./

# `--frozen-lockfile` aborts if the lockfile is missing/out-of-date,
# so a stale CI without the committed lockfile fails loud instead of
# silently re-resolving (which would invalidate the security scan).
# `--ignore-scripts` blocks postinstall hooks at build time; trusted
# postinstalls are allowlisted via `trustedDependencies` in package.json.
RUN bun install --frozen-lockfile --ignore-scripts

# ── Stage 2: Install production-only dependencies ──
# Separate stage so the run image gets node_modules without dev deps.
# Without this stage the runtime carries drizzle-kit + esbuild, whose
# bundled Go binaries pull ~36 (false-positive) CVEs into Trivy.
FROM oven/bun:1.3.10 AS prod-deps

WORKDIR /app

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile --ignore-scripts --production

# ── Stage 3: Run ──
FROM oven/bun:1.3.10 AS run

# Apply latest Debian security patches. The base image rebuilds on a
# cadence, but new Debian CVE patches between rebuilds are exactly what
# Trivy was flagging. Same pattern the official Node/Python images use.
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production-only node_modules from the prod-deps stage.
COPY --from=prod-deps /app/node_modules ./node_modules

# Application source + the committed SQL migration files. The runtime
# migrator (`src/db/migrate.ts`) reads `drizzle/<n>_*.sql` and applies
# anything not yet recorded in `__bunmail_migrations`.
COPY package.json bun.lock tsconfig.json drizzle.config.ts ./
COPY src/ ./src/
COPY drizzle/ ./drizzle/

# Expose the HTTP API port and (optionally) the inbound SMTP port
EXPOSE 3000 2525

# Health check — Docker & orchestrators use this to determine container health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://localhost:3000/health'); if (!r.ok) process.exit(1);"

# Run migrations via the bun-native migrator (no drizzle-kit needed),
# then start the server. The migrator is idempotent and auto-baselines
# legacy db:push-provisioned databases on first run.
CMD ["sh", "-c", "bun run db:migrate && bun run start"]
