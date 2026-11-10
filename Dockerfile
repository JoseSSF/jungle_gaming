# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.4 AS base
WORKDIR /app

# ---------------------------------------------------------------- dependencies
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS deps-dev
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---------------------------------------------------------------- test image (all deps + tests)
FROM base AS test
ENV NODE_ENV=test
COPY --from=deps-dev /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json bunfig.toml ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
CMD ["bun", "test", "test/unit"]

# ---------------------------------------------------------------- runtime
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
USER bun
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Bun forwards SIGTERM to the app: NestJS shutdown hooks drain the consumer and workers.
CMD ["bun", "run", "src/main.ts"]
