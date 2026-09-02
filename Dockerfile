# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.13 AS web
WORKDIR /src/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY openapi.json /src/openapi.json
COPY web/ ./
RUN bun run build

FROM rust:1.96-bookworm AS server
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential clang cmake pkg-config libssl-dev libprotobuf-dev protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY openapi.json ./
COPY crates/ crates/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p paperless-server \
    && cp /src/target/release/paperless-server /usr/local/bin/paperless-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libgomp1 poppler-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/paperless
COPY --from=server /usr/local/bin/paperless-server /usr/local/bin/paperless-server
COPY --from=web /src/web/dist ./web/dist
COPY config/paperless-agx.docker.toml ./config/paperless-agx.toml
RUN useradd --system --uid 10001 --home /nonexistent --shell /usr/sbin/nologin paperless \
    && mkdir -p /data \
    && chown paperless:paperless /data
USER paperless
ENV PAPERLESS_CONFIG=/opt/paperless/config/paperless-agx.toml
EXPOSE 3000
VOLUME ["/data"]
ENTRYPOINT ["paperless-server"]
