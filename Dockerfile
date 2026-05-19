# syntax=docker/dockerfile:1
# Multi-stage: build relayer-cli from nyks-wallet, then run the dashboard with shared agents/ + configs/.

FROM rust:1-bookworm AS relayer-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    pkg-config \
    libssl-dev \
    protobuf-compiler \
    libprotobuf-dev \
    libpq-dev \
    cmake \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone --depth 1 https://github.com/twilight-project/nyks-wallet.git repo \
    && cd repo \
    && cargo build --release --bin relayer-cli

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=relayer-builder /build/repo/target/release/relayer-cli /app/tools/relayer-cli
RUN chmod +x /app/tools/relayer-cli

COPY agents/ /app/agents/
COPY configs/ /app/configs/
COPY scripts/ /app/scripts/
COPY dashboard/ /app/dashboard/

# Pre-place relayer binary so postinstall's install-relayer-cli.mjs is a no-op
ENV TWILIGHT_RELAYER_CLI=/app/tools/relayer-cli
# Skip Playwright browser download (not needed at runtime)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app/agents/twilight-strategy-monitor
RUN npm ci --omit=dev

WORKDIR /app/dashboard
# Full install includes devDeps (Tailwind); postinstall builds output.css automatically.
# Then prune devDeps to keep the final image lean.
RUN npm ci && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 3847

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3847/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
