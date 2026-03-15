# ───────────────────────────────────────────────────────
# BunMail — Multi-stage Dockerfile
#
# Stage 1 (install): resolves and installs dependencies
# Stage 2 (run):     copies source + node_modules, starts
# ───────────────────────────────────────────────────────

# ── Stage 1: Install dependencies ──
FROM oven/bun:1 AS install

WORKDIR /app

# Copy only the files needed for dependency resolution
COPY package.json bun.lock ./

# Install all dependencies (drizzle-kit needed for migrations)
RUN bun install --frozen-lockfile --ignore-scripts

# ── Stage 2: Run ──
FROM oven/bun:1 AS run

WORKDIR /app

# Copy installed node_modules from stage 1
COPY --from=install /app/node_modules ./node_modules

# Copy application source
COPY package.json bun.lock tsconfig.json drizzle.config.ts ./
COPY src/ ./src/

# Generate Drizzle migration files from the schema
RUN bun run db:generate

# Expose the HTTP API port and (optionally) the inbound SMTP port
EXPOSE 3000 2525

# Health check — Docker & orchestrators use this to determine container health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://localhost:3000/health'); if (!r.ok) process.exit(1);"

# Run database migrations then start the server
CMD ["sh", "-c", "bun run db:migrate && bun run start"]
