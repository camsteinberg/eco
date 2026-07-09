# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Bos Computing LLC

# Stage 1: Prune monorepo for this package
FROM node:22-alpine AS pruner
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
RUN npm install -g turbo@2.8.9
WORKDIR /app
COPY . .
RUN turbo prune @eco/api --docker

# Stage 2: Install dependencies
FROM node:22-alpine AS installer
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# Stage 3: Build
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
COPY --from=installer /app/ .
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo build --filter=@eco/api

# Stage 4: Production runtime
FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
RUN apk add --no-cache curl
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=builder /app/ .

RUN addgroup --system --gid 1001 eco && \
    adduser --system --uid 1001 -G eco eco
USER eco

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3001/health || exit 1

CMD ["sh", "-c", "node apps/api/dist/db/migrate.js && node apps/api/dist/index.js"]
