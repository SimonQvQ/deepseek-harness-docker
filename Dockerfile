# DeepSeek Harness Docker Image
# ===============================
# Multi-stage build: Node.js for DSH + Caddy for reverse proxy
#
# Base: node:24-trixie (Debian 13, current stable) — same Debian family as
# smanx/deepseek-harness (which uses node:24-bookworm), with apt packages.
#
# Build args:
#   DSH_VERSION  - DSH npm version to install (default: latest)
#   CACHE_BUST   - bust npm install cache (for scheduled builds)
#   BASE_IMAGE   - node base image tag (default: node:24-trixie)
#
# Environment variables:
#   DSH_PORT            - DSH internal listen port on 127.0.0.1 (default: 3079)
#   PROXY_PORT          - Caddy proxy external listen port (default: 3080)
#   PROXY_USERNAME      - Basic Auth username (optional; unset = no auth)
#   PROXY_PASSWORD      - Basic Auth password (optional; unset = no auth)
#   DSH_TRUSTED_HOSTS   - extra /api trusted hosts (only needed when direct)
#   DSH_UPDATE_ON_START - set "true" to npm-update DSH on container start

ARG BASE_IMAGE=node:24-trixie

FROM ${BASE_IMAGE} AS builder

ARG DSH_VERSION=latest
ARG CACHE_BUST=0

# Install DSH CLI globally
# --mount=type=cache reuses npm downloads across builds
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    echo "cache bust: ${CACHE_BUST}" && \
    npm install -g @deepseek-ai/dsh@${DSH_VERSION}

# Pre-create DSH home directories (profile auto-initializes on first boot)
ENV DSH_HOME=/opt/dsh-home
RUN mkdir -p "$DSH_HOME/profiles" "$DSH_HOME/sessions" "$DSH_HOME/storages"

# Inject a crypto.randomUUID() polyfill and the isLoopback override into the
# frontend index.html so the Web UI works over plain HTTP LAN access. See
# scripts/inject-polyfill.js.
COPY scripts/inject-polyfill.js /inject-polyfill.js
RUN node /inject-polyfill.js && rm /inject-polyfill.js


FROM ${BASE_IMAGE}

# Install Caddy (Debian official repo — trixie ships caddy 2.9), wget, gettext
# (envsubst for Caddyfile templating), everyday utilities for
# debugging/administration, and a development toolchain (Python, CMake,
# GCC build essentials) for running agent code inside the container.
# pip stays at the distro version — it cannot be upgraded in place (PEP 668
# / no RECORD file) — but the global.break-system-packages flag lets you
# `pip install` system-wide without venvs.
RUN apt-get update && apt-get install -y --no-install-recommends \
        caddy wget gettext \
        bash curl jq git \
        vim nano \
        procps coreutils ca-certificates \
        python3 python3-pip python3-venv \
        cmake build-essential \
        zip unzip \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip config set global.break-system-packages true

# Copy DSH node_modules from builder
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
# Recreate the dsh symlink — COPY follows symlinks, breaking import.meta.url
RUN ln -sf ../lib/node_modules/@deepseek-ai/dsh/lib/bin.js /usr/local/bin/dsh
COPY --from=builder /opt/dsh-home /opt/dsh-home

# Set DSH home
ENV DSH_HOME=/opt/dsh-home

# Passwordless mode: danger-full-access = no approval prompts
ENV DSH_PERMISSION_MODE=danger-full-access

# Default ports
ENV DSH_HOST=127.0.0.1
ENV DSH_PORT=3079
ENV PROXY_PORT=3080

# Caddy will listen on PROXY_PORT
EXPOSE 3080

# Copy Caddyfile template
COPY Caddyfile.template /etc/caddy/Caddyfile.template

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
COPY scripts /opt/dsh-docker
RUN chmod +x /entrypoint.sh

# Working directory for DSH sessions
WORKDIR /workspace
RUN mkdir -p /workspace

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["node", "/opt/dsh-docker/healthcheck.js"]

ENTRYPOINT ["/entrypoint.sh"]
