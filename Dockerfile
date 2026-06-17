# Warrant — governed execution and provenance plane for AI agents.
# One image serves every role: control plane (+ control panel UI), runner,
# CLI, and the demo seeder. See docker-compose.yml for the full deployment.

# The Node major is pinned on purpose (supply-chain policy: known-good
# versions everywhere). Bump it together with .github/workflows/ci.yml and
# the engines field when moving majors.
FROM node:22-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
# Must match the packageManager pin in package.json (check-repo enforces
# that the pin exists; keep the two in lockstep when bumping pnpm).
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
ARG PACKAGES_READ_TOKEN
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY examples ./examples
RUN pnpm install --frozen-lockfile
RUN pnpm build
# A prod-only install drops the TypeScript toolchain while keeping the
# workspace links and the trusted runtime deps (jose/pino/zod) intact.
RUN CI=true pnpm install --prod --frozen-lockfile

# Same pinned base as the build stage, for the same supply-chain reason.
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
