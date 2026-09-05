#!/usr/bin/env bash
# Deterministic browser smoke runner for CI (mocks/disposable only).
#
# - Starts the production build (`next start`) on $PORT with mock-only env:
#   empty Razorpay keys (mock adapter), X402_MODE=mock,
#   X402_SETTLEMENT_ENABLED=false (kill-switch, no Devnet/Mainnet tx),
#   no DATABASE_URL (no settlement store), no production credentials.
# - Uses AGENTREADY_RUN_NONCE to prove the smoke talks to the server it
#   launched (stale-server rejection via /api/status runNonce).
# - Runs the main storefront smoke + the frozen ledger-prototype smoke.
# - Aborts external Razorpay/Solana egress inside the specs themselves.
set -euo pipefail

PORT="${PORT:-3101}"
APP_URL="http://localhost:${PORT}"
export PORT APP_URL

# Disposable mock-only environment for the server under test.
export NEXT_TELEMETRY_DISABLED="1"
export RAZORPAY_KEY_ID=""
export RAZORPAY_KEY_SECRET=""
export RAZORPAY_WEBHOOK_SECRET="mock_secret"
export ENVELOPE_SIGNING_SECRET="smoke-test-secret"
export X402_MODE="mock"
export X402_SETTLEMENT_ENABLED="false"
export X402_LIVE_DEVNET_TEST="0"
export LLM_API_KEY=""
unset DATABASE_URL X402_APP_DATABASE_URL X402_STORE_ENC_KEY || true

if [ -z "${AGENTREADY_RUN_NONCE:-}" ]; then
  AGENTREADY_RUN_NONCE="smoke-$(date +%s)-$RANDOM"
  export AGENTREADY_RUN_NONCE
fi

echo "smoke: starting production server on ${APP_URL} (nonce=${AGENTREADY_RUN_NONCE})"
pnpm --filter @agentready/web exec next start -p "${PORT}" > /tmp/agentready-smoke-server.log 2>&1 &
SERVER_PID=$!

cleanup() {
  echo "smoke: stopping server (pid=${SERVER_PID})"
  kill "${SERVER_PID}" 2>/dev/null || true
  wait "${SERVER_PID}" 2>/dev/null || true
}
trap cleanup EXIT

echo "smoke: waiting for /api/status with matching run nonce…"
READY=0
for _ in $(seq 1 60); do
  STATUS_JSON="$(curl -fsS "${APP_URL}/api/status" 2>/dev/null || true)"
  if [ -n "${STATUS_JSON}" ]; then
    NONCE_GOT="$(printf '%s' "${STATUS_JSON}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).runNonce||'')}catch{console.log('')}})")"
    if [ "${NONCE_GOT}" = "${AGENTREADY_RUN_NONCE}" ]; then
      echo "smoke: server ready (nonce verified)"
      READY=1
      break
    fi
  fi
  sleep 2
done
if [ "${READY}" != "1" ]; then
  echo "smoke: server did not become ready with nonce ${AGENTREADY_RUN_NONCE}"
  tail -n 100 /tmp/agentready-smoke-server.log || true
  exit 1
fi

echo "smoke: running main storefront smoke"
APP_URL="${APP_URL}" AGENTREADY_RUN_NONCE="${AGENTREADY_RUN_NONCE}" node test/browser-smoke.mjs

echo "smoke: running ledger-prototype smoke"
APP_URL="${APP_URL}" node test/ledger-prototype-smoke.mjs

echo "smoke: all browser smoke tests passed"
