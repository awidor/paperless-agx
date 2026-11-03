# syntax=docker/dockerfile:1.7
# Build from the repository root: docker build -f agent/Dockerfile -t paperless-agent:local .
FROM oven/bun:1.4.4-slim
WORKDIR /opt/agent
COPY agent/package.json agent/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY agent/tsconfig.json ./
COPY agent/src ./src
COPY config/paperless-agent.toml ./config/paperless-agent.toml
USER bun
ENV PAPERLESS_AGENT_CONFIG=/opt/agent/config/paperless-agent.toml
EXPOSE 3100
CMD ["bun", "src/server.ts"]
