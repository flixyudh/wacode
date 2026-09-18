#!/usr/bin/env bash
# Single-image supervisor: runs `opencode serve` + the whatsapp bridge.
# - opencode must be healthy before the bridge boots (else every forward fails).
# - If either process exits, the other is stopped and the container exits
#   non-zero so the restart policy kicks in.
set -euo pipefail

OPENCODE_HOST="${OPENCODE_HOST:-127.0.0.1}"
OPENCODE_PORT="${OPENCODE_PORT:-4096}"
OPENCODE_URL="http://${OPENCODE_HOST}:${OPENCODE_PORT}"

# YOLO mode: there is no --yolo flag on `opencode serve`; the equivalent is
# auto-approve via config ("permission": "allow"). This matters headless:
# approval prompts can never be answered over the SDK, so any "ask"
# (e.g. external_directory) would stall the bridge forever.
# NOTE: explicit per-agent DENY rules still win — the whatsapp-bridge
# agent's no-bash/no-write/no-subagent stance stays intact. But any OTHER
# agent on this serve (e.g. build) would run fully unconstrained, so keep
# the serve port container-internal. Set OPENCODE_YOLO=false to disable.
if [ ! -f /app/opencode.json ] && [ "${OPENCODE_YOLO:-true}" = "true" ]; then
  echo "[entrypoint] yolo mode on (permission=allow, agent denies still enforced)"
  printf '%s' '{"$schema":"https://opencode.ai/config.json","permission":"allow"}' > /app/opencode.json
fi

echo "[entrypoint] starting opencode serve on ${OPENCODE_URL} (project: ${PWD})"
opencode serve --hostname "${OPENCODE_HOST}" --port "${OPENCODE_PORT}" &
OPENCODE_PID=$!

shutdown() {
  echo "[entrypoint] shutting down"
  kill "${OPENCODE_PID}" 2>/dev/null || true
  kill "${BRIDGE_PID:-}" 2>/dev/null || true
}
trap shutdown TERM INT

echo "[entrypoint] waiting for opencode health (up to 90s)"
HEALTHY=0
for _ in $(seq 1 90); do
  if curl -fs "${OPENCODE_URL}/global/health" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done
if [ "${HEALTHY}" != "1" ]; then
  echo "[entrypoint] opencode serve did not become healthy at ${OPENCODE_URL}/global/health" >&2
  kill "${OPENCODE_PID}" 2>/dev/null || true
  exit 1
fi
echo "[entrypoint] opencode healthy, starting bridge"
node dist/index.js &
BRIDGE_PID=$!

# Exit when the first of the two exits (bash 4.3+).
wait -n "${OPENCODE_PID}" "${BRIDGE_PID}"
CODE=$?
echo "[entrypoint] a supervised process exited (code ${CODE}), stopping the other"
kill "${OPENCODE_PID}" "${BRIDGE_PID}" 2>/dev/null || true
wait 2>/dev/null || true
exit "${CODE}"
