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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=relayer-builder /build/repo/target/release/relayer-cli /app/tools/relayer-cli
RUN chmod +x /app/tools/relayer-cli

COPY agents/ /app/agents/
COPY configs/ /app/configs/
COPY scripts/ /app/scripts/
COPY dashboard/ /app/dashboard/

WORKDIR /app/agents/twilight-strategy-monitor
RUN npm ci --omit=dev

WORKDIR /app/dashboard
RUN npm ci --omit=dev

ENV TWILIGHT_RELAYER_CLI=/app/tools/relayer-cli
ENV NODE_ENV=production
EXPOSE 3847
WORKDIR /app/dashboard
CMD ["node", "server.mjs"]
