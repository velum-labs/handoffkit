# Warrant — governed execution and provenance plane for AI agents.
# One image serves every role: control plane (+ control panel UI), runner,
# CLI, and the demo seeder. See docker-compose.yml for the full deployment.

# TODO(hardcoded): pinned node:22-bookworm-slim
FROM node:22-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
# TODO(hardcoded): pnpm@10.33.4
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY examples ./examples
RUN pnpm install --frozen-lockfile
RUN pnpm build
# A prod-only install drops the TypeScript toolchain while keeping the
# workspace links and the trusted runtime deps (jose/pino/zod) intact.
RUN CI=true pnpm install --prod --frozen-lockfile

# TODO(hardcoded): pinned node:22-bookworm-slim
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
RUN printf '#!/bin/sh\nexec node /app/packages/cli/dist/index.js "$@"\n' > /usr/local/bin/warrant \
  && chmod +x /usr/local/bin/warrant \
  # Pre-create the volume mount points owned by the runtime user so named
  # volumes inherit writable ownership on first use.
  && mkdir -p /data/warrant /data/runner && chown -R node:node /data
USER node
ENV WARRANT_HOME=/data/warrant
CMD ["warrant", "help"]
