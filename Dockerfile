# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
ARG PI_VERSION=1.4.0

# Basic tools for pi's shell commands. Add project-specific tools in a derived image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && npm cache clean --force

ENV NODE_ENV=production \
    HOME=/home/node \
    LENTZ_HOST=0.0.0.0 \
    LENTZ_PORT=4317 \
    LENTZ_ROOT=/workspace \
    LENTZ_DATA_DIR=/var/lib/lentz
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/client ./dist/client
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared

RUN mkdir -p /workspace /var/lib/lentz /home/node/.pi \
    && chown -R node:node /workspace /var/lib/lentz /home/node/.pi
USER node

EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.LENTZ_PORT || '4317') + '/api/bootstrap', { signal: AbortSignal.timeout(3000) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "--import", "tsx", "server/index.ts"]
