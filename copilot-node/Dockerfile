FROM node:22.23.2-bookworm-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 python3-venv tini procps util-linux \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/copilot-node
COPY copilot-node/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && ln -s /opt/copilot-node/node_modules/.bin/copilot /usr/local/bin/copilot
COPY desktop-container/bridge/ /opt/desktop-container/bridge/
COPY copilot-node/*.mjs ./
RUN mkdir -p /workspace /home/node/board-data \
    && chown -R node:node /workspace /home/node \
    && ln -s /home/node/board-data /data
ENV HOME=/home/node NODE_ENV=production OUTBOX_ROOT=/data/outbox
USER node
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=3 \
    CMD ["node", "/opt/copilot-node/control.mjs", "health"]
CMD ["/usr/bin/flock", "--nonblock", "/data/node.lock", "node", "/opt/copilot-node/runner.mjs"]
