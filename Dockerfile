# syntax=docker/dockerfile:1.7
#
# Production images for Code Workspace, built from the monorepo root:
#
#   api      NestJS HTTP + WebSocket API (public, behind the reverse proxy)
#   worker   Execution worker; drives the host Docker Engine to run sandboxes
#   migrate  One-shot database migrations (Prisma)
#   web      Caddy serving the static IDE and proxying /api and /ws
#
# Runtime images contain only production dependencies and run as a non-root user.

ARG NODE_IMAGE=node:24-bookworm-slim
ARG PNPM_VERSION=12.6.0

# ------------------------------------------------------------------ build
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
# OpenSSL lets Prisma's install step pick the right schema engine for the migrate
# image, which has no internet access at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo

# Manifests first so dependency installs are cached until they change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/web/scripts apps/web/scripts
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile

COPY . .
# The web app is exported as static files served from the same origin as the API.
ENV NEXT_OUTPUT=export NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# Self-contained production bundles (only production dependencies).
RUN pnpm --filter @cw/api deploy --prod --legacy /out/api \
 && pnpm --filter @cw/worker deploy --prod --legacy /out/worker \
 && pnpm --filter @cw/db deploy --legacy /out/db

# ------------------------------------------------------------------ api
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/api/v1/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Node is PID 1 under Docker's init (compose `init: true`) and handles SIGTERM with Nest shutdown hooks.
CMD ["node", "dist/main.js"]

# ------------------------------------------------------------------ worker
FROM ${NODE_IMAGE} AS worker
ENV NODE_ENV=production WORKER_HEALTH_FILE=/tmp/worker-healthy
WORKDIR /app
COPY --from=build --chown=node:node /out/worker ./
# The worker reaches the Docker Engine through the mounted socket; compose adds the
# socket's group so the process does not need to run as root.
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/main.js"]

# ------------------------------------------------------------------ migrate
# Only the database package, its migrations and the Prisma CLI (whose schema
# engine needs OpenSSL).
FROM ${NODE_IMAGE} AS migrate
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/db ./
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

# ------------------------------------------------------------------ web
FROM caddy:2-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/out /srv
# Compressed once here at maximum level instead of on every request (Monaco alone is several MB).
RUN apk add --no-cache zstd \
  && find /srv -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.json' -o -name '*.svg' -o -name '*.txt' \) -size +1k \
     -exec gzip -9 -k {} \; -exec zstd -19 -q {} \; \
  && apk del zstd
