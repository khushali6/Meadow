# ── Meadow — Production Dockerfile ──────────────────────────────────────────
# Multi-stage build: builder compiles the TypeScript bundle; runner is minimal.
#
# Build:
#   docker build -t meadow .
#
# Run (basic):
#   docker run -d \
#     -v $HOME/.meadow:/home/meadow/.meadow \
#     -v $HOME/meadow-projects:/home/meadow/meadow-projects \
#     -p 56000:56000 \
#     --env-file ~/.meadow/secrets.env \
#     --name meadow \
#     meadow
#
# The coding engine (Cursor CLI etc.) must be installed in the host and bind-mounted,
# or use the "engine: custom" mode with a shell command the container can reach.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9

# Copy manifests first for better cache
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches/

RUN pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN pnpm run build

# Prune dev dependencies
RUN pnpm prune --prod

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:22-slim AS runner

# Create a non-root user
RUN useradd -m -u 1001 -s /bin/bash meadow

WORKDIR /app

# Copy built artefacts and production deps
COPY --from=builder --chown=meadow:meadow /app/dist ./dist
COPY --from=builder --chown=meadow:meadow /app/node_modules ./node_modules
COPY --from=builder --chown=meadow:meadow /app/package.json ./package.json

# Meadow data directory (config, DB, screenshots, secrets)
RUN mkdir -p /home/meadow/.meadow && chown meadow:meadow /home/meadow/.meadow

USER meadow

# Default meadow home, server host/port
ENV MEADOW_HOST=0.0.0.0 \
    MEADOW_PORT=56000 \
    HOME=/home/meadow

EXPOSE 56000

# Health check — Meadow exposes /api/trpc/overview
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:56000/api/trpc/overview', r => process.exit(r.statusCode === 200 ? 0 : 1))"

ENTRYPOINT ["node", "dist/bin.js"]
