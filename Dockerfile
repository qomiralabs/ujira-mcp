# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Qomira Labs
#
# The public MCP server over HTTP, Stellar testnet only. Keys and the mandate
# come from the environment at run time; nothing secret is baked in.

# The console web app, built on its own so its dependencies never reach the
# server image; only the static files in console/dist are copied over.
FROM node:22-slim AS console
WORKDIR /console
COPY console/package.json console/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY console/ ./
RUN npm run build

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8080 \
    UJIRA_NETWORK=testnet \
    UJIRA_RECEIPTS_FILE=/data/receipts.json \
    UJIRA_CONSOLE_DIR=/app/console/dist
WORKDIR /app
COPY package.json package-lock.json LICENSE ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=console /console/dist ./console/dist
COPY docker/entrypoint.sh /usr/local/bin/ujira-entrypoint
# setpriv is how the entrypoint drops to the node user; fail the build if the
# base image ever stops shipping it rather than run the server as root.
RUN chmod 0755 /usr/local/bin/ujira-entrypoint \
    && command -v setpriv \
    && mkdir -p /data \
    && chown node:node /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/ujira-entrypoint"]
CMD ["node", "dist/mcp/http-main.js"]
