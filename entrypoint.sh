#!/bin/sh
set -e

# ============================================================
# DeepSeek Harness Docker Entrypoint
# ============================================================
# 1. Generate Caddyfile from template (with optional Basic Auth)
# 2. Optionally update DSH to latest
# 3. Start DSH web on 127.0.0.1:${DSH_PORT}
# 4. Start Caddy on :${PROXY_PORT}
#
# API keys are configured directly in the DSH Web UI.

echo "=== DeepSeek Harness Docker ==="
echo "DSH Home:      ${DSH_HOME:-/opt/dsh-home}"
echo "DSH Version:   $(dsh --version 2>&1 || echo unknown)"
echo "Permission:    ${DSH_PERMISSION_MODE:-danger-full-access}"
echo "DSH listen:    127.0.0.1:${DSH_PORT:-3079}"
echo "Proxy listen:  :${PROXY_PORT:-3080}"
echo "Auto-update:   ${DSH_UPDATE_ON_START:-false}"
echo "HMR:           --expose-internals (direct node flag)"
if [ -n "${PROXY_USERNAME}" ] && [ -n "${PROXY_PASSWORD}" ]; then
    echo "Basic Auth:    enabled (user: ${PROXY_USERNAME})"
else
    echo "Basic Auth:    disabled"
fi
echo "================================"

# Ensure DSH home directories exist
mkdir -p "${DSH_HOME}/sessions" "${DSH_HOME}/storages" "${DSH_HOME}/profiles"

# --- Generate Caddyfile ---
DSH_PORT="${DSH_PORT:-3079}"
PROXY_PORT="${PROXY_PORT:-3080}"

if [ -n "${PROXY_USERNAME}" ] && [ -n "${PROXY_PASSWORD}" ]; then
    # Generate password hash for Caddy
    HASH=$(caddy hash-password --plaintext "${PROXY_PASSWORD}" 2>/dev/null || echo "")
    if [ -n "${HASH}" ]; then
        export PROXY_AUTH="basicauth {
            ${PROXY_USERNAME} ${HASH}
        }"
    else
        echo "WARNING: caddy hash-password failed, falling back to plaintext"
        export PROXY_AUTH="basicauth {
            ${PROXY_USERNAME} ${PROXY_PASSWORD}
        }"
    fi
else
    export PROXY_AUTH=""
fi

export DSH_PORT PROXY_PORT
envsubst '${DSH_PORT} ${PROXY_PORT} ${PROXY_AUTH}' \
    < /etc/caddy/Caddyfile.template \
    > /etc/caddy/Caddyfile


# --- Optional: update DSH inside the container ---
if [ "${DSH_UPDATE_ON_START}" = "true" ]; then
    echo "Updating DSH to latest..."
    npm install -g @deepseek-ai/dsh@latest 2>&1 || echo "WARNING: DSH update failed, continuing with current version"
    echo "DSH version: $(dsh --version 2>&1 || echo unknown)"
fi

# Updating replaces the frontend assets, so restore the LAN compatibility patch.
if [ "${DSH_UPDATE_ON_START}" = "true" ]; then
    node /opt/dsh-docker/inject-polyfill.js
fi

# The supervisor exchanges DSH's launch token on loopback, supplies the signed
# session to Caddy, refreshes it, and forwards shutdown to both services.
exec node /opt/dsh-docker/start-services.js
