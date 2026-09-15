FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132 AS desktop-deps

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates dbus-x11 xvfb x11-utils x11vnc novnc websockify openbox \
    xdg-utils firefox-esr gnome-keyring libsecret-tools fonts-dejavu-core \
    procps curl tini python3 \
    && rm -rf /var/lib/apt/lists/*

FROM node:22.23.2-bookworm-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96 AS bridge-deps
RUN npm install --prefix /app --omit=dev --save-exact undici@7.15.0 \
    && npm install --global @playwright/mcp@0.0.79 \
    && PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node /usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright/cli.js install chromium

FROM desktop-deps
COPY .cache/chatgpt_amd64.deb /tmp/chatgpt.deb
ARG CHATGPT_SHA256=10ed0c1a880b9975d1f185bf7911a7f514e06b9863cd4ed9561d40063617c854
RUN echo "${CHATGPT_SHA256}  /tmp/chatgpt.deb" | sha256sum --check - \
    && apt-get update && apt-get install -y --no-install-recommends /tmp/chatgpt.deb scrot \
    && rm -f /tmp/chatgpt.deb && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 --shell /bin/bash desktop \
    && mkdir -p /workspace /home/desktop/.config \
    && chown -R desktop:desktop /workspace /home/desktop
RUN apt-get update && apt-get install -y --no-install-recommends git bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /home/desktop/board-data /data \
    && ln -s /usr/lib/chatgpt/resources/codex /usr/local/bin/codex \
    && ln -s /usr/lib/chatgpt/resources/codex-code-mode-host /usr/local/bin/codex-code-mode-host \
    && ln -s /usr/lib/chatgpt/resources/rg /usr/local/bin/rg
COPY --from=bridge-deps /usr/local/bin/node /usr/local/bin/node
COPY --from=bridge-deps /app/node_modules /opt/board/node_modules
COPY --from=bridge-deps /usr/local/lib/node_modules/@playwright /usr/local/lib/node_modules/@playwright
COPY --from=bridge-deps /ms-playwright /ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv jq \
    && python3 -m venv /opt/research \
    && /opt/research/bin/pip install --no-cache-dir kaggle==2.2.4 \
    && rm -rf /var/lib/apt/lists/*
RUN ln -s /usr/local/lib/node_modules/@playwright/mcp/cli.js /usr/local/bin/playwright-mcp
RUN PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node -e "const p=require('/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright');require('node:fs').symlinkSync(p.chromium.executablePath(),'/usr/local/bin/board-chromium')"
COPY bridge/ /opt/board/
COPY desktop.requirements.toml /etc/codex/requirements.toml
COPY --chmod=755 start-desktop.sh /usr/local/bin/start-desktop
COPY healthcheck.py /usr/local/bin/desktop-healthcheck.py
ENV HOME=/home/desktop DISPLAY=:99 XDG_RUNTIME_DIR=/tmp/runtime-desktop \
    BROWSER=firefox-esr
USER desktop
WORKDIR /workspace
EXPOSE 6080
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=3 \
    CMD ["python3", "/usr/local/bin/desktop-healthcheck.py"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-desktop"]
