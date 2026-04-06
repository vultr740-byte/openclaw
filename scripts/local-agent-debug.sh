#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

DEV_STATE_DIR="${HOME}/.openclaw-dev"
DEV_CONFIG_PATH="${DEV_STATE_DIR}/openclaw.json"
DEV_AGENT_AUTH_PATH="${DEV_STATE_DIR}/agents/dev/agent/auth-profiles.json"
SOURCE_STATE_DIR="${OPENCLAW_DEBUG_SOURCE_STATE_DIR:-${HOME}/.openclaw}"
SOURCE_CONFIG_PATH="${SOURCE_STATE_DIR}/openclaw.json"
SOURCE_AGENT_AUTH_PATH="${SOURCE_STATE_DIR}/agents/main/agent/auth-profiles.json"
LOG_FILE="${DEV_STATE_DIR}/local-agent-debug.gateway.log"
HEALTH_TIMEOUT_SECONDS="${OPENCLAW_DEBUG_HEALTH_TIMEOUT_SECONDS:-90}"

cd "$REPO_ROOT"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/local-agent-debug.sh serve
  ./scripts/local-agent-debug.sh start
  ./scripts/local-agent-debug.sh smoke
  ./scripts/local-agent-debug.sh send "message"
  ./scripts/local-agent-debug.sh send-fresh "message"
  ./scripts/local-agent-debug.sh tui
  ./scripts/local-agent-debug.sh status
  ./scripts/local-agent-debug.sh stop

What it does:
  - Uses the built-in dev profile (~/.openclaw-dev)
  - Starts a local loopback Gateway on port 19001 with channels disabled
  - Mirrors model/provider config from the source profile
  - Copies the main agent auth store into the dev agent
  - Supports a 3-turn smoke test that proves session continuity
  - Supports a cold-start send path that forces a fresh derived session

Optional env:
  OPENCLAW_DEBUG_SOURCE_STATE_DIR=/path/to/source/state
  OPENCLAW_DEBUG_HEALTH_TIMEOUT_SECONDS=120
EOF
}

run_openclaw() {
  OPENCLAW_HIDE_BANNER=1 node scripts/run-node.mjs --dev "$@"
}

run_openclaw_dist() {
  env \
    OPENCLAW_PROFILE=dev \
    OPENCLAW_STATE_DIR="$DEV_STATE_DIR" \
    OPENCLAW_CONFIG_PATH="$DEV_CONFIG_PATH" \
    OPENCLAW_GATEWAY_PORT="$(gateway_port)" \
    OPENCLAW_HIDE_BANNER=1 \
    node dist/index.js "$@"
}

print_log_hint() {
  printf 'Gateway log: %s\n' "$LOG_FILE"
}

gateway_port() {
  DEV_CONFIG_PATH="$DEV_CONFIG_PATH" node <<'EOF'
const fs = require("node:fs");

const configPath = process.env.DEV_CONFIG_PATH;
const fallbackPort = 19001;

if (!configPath || !fs.existsSync(configPath)) {
  process.stdout.write(String(fallbackPort));
  process.exit(0);
}

try {
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const port = parsed?.gateway?.port;
  process.stdout.write(String(Number.isFinite(port) ? port : fallbackPort));
} catch {
  process.stdout.write(String(fallbackPort));
}
EOF
}

gateway_listener_pid() {
  local port
  local pid
  port=$(gateway_port)
  pid=$(lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)
  printf '%s' "$pid"
}

is_pid_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

stop_pid() {
  local pid="$1"
  if ! is_pid_running "$pid"; then
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if ! is_pid_running "$pid"; then
      return 0
    fi
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
}

stop_gateway_processes() {
  local tracked_pid="${1:-}"
  local listener_pid

  if [[ -n "$tracked_pid" ]]; then
    stop_pid "$tracked_pid"
  fi

  listener_pid=$(gateway_listener_pid)
  if [[ -n "$listener_pid" && "$listener_pid" != "$tracked_pid" ]]; then
    stop_pid "$listener_pid"
  fi
}

gateway_health_ok() {
  run_openclaw gateway health --json >/dev/null 2>&1
}

wait_for_gateway_health() {
  local timeout="${1:-$HEALTH_TIMEOUT_SECONDS}"
  local elapsed=0
  while (( elapsed < timeout )); do
    if gateway_health_ok; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

ensure_dev_bootstrap() {
  if [[ -f "$DEV_CONFIG_PATH" ]]; then
    return 0
  fi

  mkdir -p "$DEV_STATE_DIR"
  printf 'Seeding dev profile under %s\n' "$DEV_STATE_DIR"
  nohup env \
    OPENCLAW_SKIP_CHANNELS=1 \
    CLAWDBOT_SKIP_CHANNELS=1 \
    OPENCLAW_HIDE_BANNER=1 \
    node scripts/run-node.mjs --dev gateway run --force >"$LOG_FILE" 2>&1 &
  local bootstrap_pid=$!
  if ! wait_for_gateway_health; then
    printf 'Failed to bootstrap the dev profile.\n' >&2
    print_log_hint >&2
    tail -n 80 "$LOG_FILE" >&2 || true
    stop_gateway_processes "$bootstrap_pid"
    return 1
  fi
  stop_gateway_processes "$bootstrap_pid"
}

sync_dev_profile_from_source() {
  ensure_dev_bootstrap

  if [[ ! -f "$SOURCE_CONFIG_PATH" ]]; then
    printf 'Missing source config: %s\n' "$SOURCE_CONFIG_PATH" >&2
    return 1
  fi

  mkdir -p "$(dirname "$DEV_AGENT_AUTH_PATH")"
  if [[ -f "$SOURCE_AGENT_AUTH_PATH" ]]; then
    cp "$SOURCE_AGENT_AUTH_PATH" "$DEV_AGENT_AUTH_PATH"
  else
    printf 'Missing source auth store: %s\n' "$SOURCE_AGENT_AUTH_PATH" >&2
    return 1
  fi

  SOURCE_CONFIG_PATH="$SOURCE_CONFIG_PATH" DEV_CONFIG_PATH="$DEV_CONFIG_PATH" node <<'EOF'
const fs = require("node:fs");

const sourceConfigPath = process.env.SOURCE_CONFIG_PATH;
const devConfigPath = process.env.DEV_CONFIG_PATH;
if (!sourceConfigPath || !devConfigPath) {
  throw new Error("Missing config paths");
}

const source = JSON.parse(fs.readFileSync(sourceConfigPath, "utf8"));
const dev = JSON.parse(fs.readFileSync(devConfigPath, "utf8"));

dev.agents ||= {};
dev.agents.defaults ||= {};

if (Object.prototype.hasOwnProperty.call(source.agents?.defaults ?? {}, "model")) {
  dev.agents.defaults.model = source.agents.defaults.model;
} else {
  delete dev.agents.defaults.model;
}

if (Object.prototype.hasOwnProperty.call(source.agents?.defaults ?? {}, "models")) {
  dev.agents.defaults.models = source.agents.defaults.models;
} else {
  delete dev.agents.defaults.models;
}

dev.models ||= {};
if (Object.prototype.hasOwnProperty.call(source.models ?? {}, "providers")) {
  dev.models.providers = source.models.providers;
} else {
  delete dev.models.providers;
}

dev.auth ||= {};
if (Object.prototype.hasOwnProperty.call(source.auth ?? {}, "profiles")) {
  dev.auth.profiles = source.auth.profiles;
} else {
  delete dev.auth.profiles;
}

if (Object.prototype.hasOwnProperty.call(source.auth ?? {}, "order")) {
  dev.auth.order = source.auth.order;
} else {
  delete dev.auth.order;
}

fs.writeFileSync(devConfigPath, `${JSON.stringify(dev, null, 2)}\n`);
EOF
}

serve_gateway() {
  sync_dev_profile_from_source

  mkdir -p "$DEV_STATE_DIR"
  : >"$LOG_FILE"
  printf 'Starting local debug Gateway in the foreground...\n'
  printf 'Use a second terminal for smoke/send/tui commands.\n'
  print_log_hint
  env \
    OPENCLAW_SKIP_CHANNELS=1 \
    CLAWDBOT_SKIP_CHANNELS=1 \
    OPENCLAW_HIDE_BANNER=1 \
    node scripts/run-node.mjs --dev gateway run --force 2>&1 | tee -a "$LOG_FILE"
}

parse_agent_response_field() {
  local file="$1"
  local field="$2"
  node - "$file" "$field" <<'EOF'
const fs = require("node:fs");

const [file, field] = process.argv.slice(2);
const payload = JSON.parse(fs.readFileSync(file, "utf8"));
const fields = {
  text: payload.result?.payloads?.[0]?.text ?? "",
  sessionId: payload.result?.meta?.agentMeta?.sessionId ?? "",
  provider: payload.result?.meta?.agentMeta?.provider ?? "",
  model: payload.result?.meta?.agentMeta?.model ?? "",
};

if (!Object.prototype.hasOwnProperty.call(fields, field)) {
  throw new Error(`Unknown field: ${field}`);
}

process.stdout.write(String(fields[field]));
EOF
}

run_agent_json() {
  local message="$1"
  run_openclaw_dist agent --agent dev -m "$message" --thinking off --json
}

run_agent_json_fresh() {
  local message="$1"
  local nonce
  nonce=$(date +%s)-$RANDOM
  local session_key="agent:dev:debug-${nonce}"
  # Use an explicit dev-agent session key to avoid collapsing back to agent:main:main.
  run_openclaw_dist agent --agent dev --session-key "$session_key" -m "$message" --thinking off --json
}

run_smoke_test() {
  if ! gateway_health_ok; then
    printf 'Gateway is not healthy. Run ./scripts/local-agent-debug.sh start first.\n' >&2
    return 1
  fi

  local nonce
  nonce=$(date +%s)
  local exact_reply="SMOKE_OK_${nonce}"
  local phrase="blue-lobster-bicycle-${nonce}"
  local ack_reply="MEMORY_SET_${nonce}"

  local resp1 resp2 resp3
  resp1=$(mktemp)
  resp2=$(mktemp)
  resp3=$(mktemp)
  trap 'rm -f "$resp1" "$resp2" "$resp3"' RETURN

  printf 'Running smoke test turn 1/3...\n'
  run_agent_json "Reply with exactly: ${exact_reply}" >"$resp1"

  printf 'Running smoke test turn 2/3...\n'
  run_agent_json "Remember this phrase exactly for this session: ${phrase}. Reply with exactly: ${ack_reply}" >"$resp2"

  printf 'Running smoke test turn 3/3...\n'
  run_agent_json "What phrase did I ask you to remember in the previous message? Reply with the phrase only." >"$resp3"

  local text1 text2 text3 session1 session2 session3 provider model
  text1=$(parse_agent_response_field "$resp1" text)
  text2=$(parse_agent_response_field "$resp2" text)
  text3=$(parse_agent_response_field "$resp3" text)
  session1=$(parse_agent_response_field "$resp1" sessionId)
  session2=$(parse_agent_response_field "$resp2" sessionId)
  session3=$(parse_agent_response_field "$resp3" sessionId)
  provider=$(parse_agent_response_field "$resp1" provider)
  model=$(parse_agent_response_field "$resp1" model)

  if [[ "$text1" != "$exact_reply" ]]; then
    printf 'Smoke test failed on turn 1. Expected "%s", got "%s".\n' "$exact_reply" "$text1" >&2
    return 1
  fi
  if [[ "$text2" != "$ack_reply" ]]; then
    printf 'Smoke test failed on turn 2. Expected "%s", got "%s".\n' "$ack_reply" "$text2" >&2
    return 1
  fi
  if [[ "$text3" != "$phrase" ]]; then
    printf 'Smoke test failed on turn 3. Expected "%s", got "%s".\n' "$phrase" "$text3" >&2
    return 1
  fi
  if [[ -z "$session1" || "$session1" != "$session2" || "$session1" != "$session3" ]]; then
    printf 'Smoke test failed session continuity check. Session ids: %s | %s | %s\n' "$session1" "$session2" "$session3" >&2
    return 1
  fi

  printf 'Smoke test passed.\n'
  printf '  provider/model: %s/%s\n' "$provider" "$model"
  printf '  session id: %s\n' "$session1"
  printf '  remembered phrase: %s\n' "$phrase"
}

send_message() {
  if [[ $# -lt 1 ]]; then
    printf 'Usage: ./scripts/local-agent-debug.sh send "message"\n' >&2
    return 1
  fi
  if ! gateway_health_ok; then
    printf 'Gateway is not healthy. Run ./scripts/local-agent-debug.sh start first.\n' >&2
    return 1
  fi

  local response
  response=$(mktemp)
  trap 'rm -f "$response"' RETURN
  run_agent_json "$*" >"$response"

  local text session provider model
  text=$(parse_agent_response_field "$response" text)
  session=$(parse_agent_response_field "$response" sessionId)
  provider=$(parse_agent_response_field "$response" provider)
  model=$(parse_agent_response_field "$response" model)

  printf '%s\n' "$text"
  printf 'session=%s provider=%s model=%s\n' "$session" "$provider" "$model" >&2
}

send_message_fresh() {
  if [[ $# -lt 1 ]]; then
    printf 'Usage: ./scripts/local-agent-debug.sh send-fresh "message"\n' >&2
    return 1
  fi
  if ! gateway_health_ok; then
    printf 'Gateway is not healthy. Run ./scripts/local-agent-debug.sh start first.\n' >&2
    return 1
  fi

  local response
  response=$(mktemp)
  trap 'rm -f "$response"' RETURN
  run_agent_json_fresh "$*" >"$response"

  local text session provider model
  text=$(parse_agent_response_field "$response" text)
  session=$(parse_agent_response_field "$response" sessionId)
  provider=$(parse_agent_response_field "$response" provider)
  model=$(parse_agent_response_field "$response" model)

  printf '%s\n' "$text"
  printf 'session=%s provider=%s model=%s mode=fresh\n' "$session" "$provider" "$model" >&2
}

status() {
  local port
  local listener_pid=""
  port=$(gateway_port)

  if gateway_health_ok; then
    printf 'Gateway healthy on ws://127.0.0.1:%s\n' "$port"
  else
    printf 'Gateway not healthy on ws://127.0.0.1:%s\n' "$port"
  fi

  listener_pid=$(gateway_listener_pid)
  if [[ -n "$listener_pid" ]]; then
    printf 'listener_pid=%s (port %s)\n' "$listener_pid" "$port"
  else
    printf 'listener_pid=<none>\n'
  fi
  print_log_hint
}

stop() {
  local listener_pid=""
  listener_pid=$(gateway_listener_pid)

  if [[ -z "$listener_pid" ]]; then
    printf 'No tracked local debug Gateway to stop.\n'
    return 0
  fi

  stop_gateway_processes "$listener_pid"
  printf 'Stopped local debug Gateway.\n'
}

open_tui() {
  if ! gateway_health_ok; then
    printf 'Gateway is not healthy. Run ./scripts/local-agent-debug.sh start first.\n' >&2
    return 1
  fi
  exec node scripts/run-node.mjs --dev tui
}

cmd="${1:-}"
case "$cmd" in
  serve)
    shift
    serve_gateway
    ;;
  start)
    shift
    serve_gateway
    ;;
  smoke)
    shift
    run_smoke_test
    ;;
  send)
    shift
    send_message "$@"
    ;;
  send-fresh)
    shift
    send_message_fresh "$@"
    ;;
  tui)
    shift
    open_tui
    ;;
  status)
    shift
    status
    ;;
  stop)
    shift
    stop
    ;;
  ""|-h|--help|help)
    usage
    ;;
  *)
    printf 'Unknown command: %s\n\n' "$cmd" >&2
    usage >&2
    exit 1
    ;;
esac
