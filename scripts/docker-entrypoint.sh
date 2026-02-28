#!/usr/bin/env bash
set -euo pipefail

if [ -z "${OPENCLAW_GATEWAY_PORT:-}" ] && [ -n "${PORT:-}" ]; then
  export OPENCLAW_GATEWAY_PORT="$PORT"
fi

if [ -z "${OPENCLAW_GATEWAY_BIND:-}" ]; then
  if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ] || [ -n "${OPENCLAW_GATEWAY_PASSWORD:-}" ]; then
    export OPENCLAW_GATEWAY_BIND="lan"
  fi
fi

if [ -z "${OPENCLAW_WORKSPACE_DIR:-}" ]; then
  export OPENCLAW_WORKSPACE_DIR="/data/workspace"
fi

should_inject_bind=false
has_bind=false
for arg in "$@"; do
  if [ "$arg" = "gateway" ]; then
    should_inject_bind=true
  fi
  case "$arg" in
    --bind|--bind=*) has_bind=true ;;
  esac
done

bind_args=()
if [ "$should_inject_bind" = "true" ] && [ "$has_bind" = "false" ] && [ -n "${OPENCLAW_GATEWAY_BIND:-}" ]; then
  bind_args=(--bind "$OPENCLAW_GATEWAY_BIND")
fi

ensure_workspace() {
  local workspace_dir="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
  mkdir -p "$workspace_dir"
  local memory_file="$workspace_dir/MEMORY.md"
  if [ ! -f "$memory_file" ]; then
    printf "# Memory\n" >"$memory_file"
  fi
}

ensure_legacy_workspace() {
  local legacy_dir="/home/node/.openclaw/workspace"
  if [ "$legacy_dir" = "${OPENCLAW_WORKSPACE_DIR:-/data/workspace}" ]; then
    return 0
  fi
  mkdir -p "$legacy_dir"
  local memory_file="$legacy_dir/MEMORY.md"
  if [ ! -f "$memory_file" ]; then
    printf "# Memory\n" >"$memory_file"
  fi
  if [ "$(id -u)" = "0" ]; then
    chown -R node:node "$legacy_dir" || true
  fi
}

bootstrap_config() {
  if [ -z "${OPENCLAW_CONFIG_TEMPLATE:-}" ]; then
    return 0
  fi

  local template_path="$OPENCLAW_CONFIG_TEMPLATE"
  if [ ! -f "$template_path" ]; then
    echo "openclaw-entrypoint: OPENCLAW_CONFIG_TEMPLATE not found: $template_path" >&2
    exit 1
  fi

  local state_dir="${OPENCLAW_STATE_DIR:-/data/.openclaw}"
  local config_path="${OPENCLAW_CONFIG_PATH:-$state_dir/openclaw.json}"
  local should_copy="false"
  if [ ! -f "$config_path" ] || [ "${OPENCLAW_CONFIG_TEMPLATE_FORCE:-}" = "1" ]; then
    should_copy="true"
  fi

  mkdir -p "$(dirname "$config_path")"
  if [ "$should_copy" = "true" ]; then
    cp "$template_path" "$config_path"
  fi
  if command -v node >/dev/null 2>&1; then
    node - "$config_path" <<'NODE'
const fs = require("node:fs");

const configPath =
  process.argv[2] && process.argv[2] !== "-" ? process.argv[2] : process.argv[1];
if (!configPath || configPath === "-") {
  console.error("openclaw-entrypoint: missing config path for bootstrap");
  process.exit(1);
}
const raw =
  process.env.TELEGRAM_ALLOW_FROM_JSON?.trim() ||
  process.env.TELEGRAM_ALLOW_FROM?.trim() ||
  "";
const rawSessionDmScope = process.env.OPENCLAW_SESSION_DM_SCOPE?.trim() || "";

let allowFrom = [];
if (raw) {
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        allowFrom = parsed;
      } else {
        throw new Error("TELEGRAM_ALLOW_FROM_JSON must be a JSON array");
      }
    } catch (err) {
      console.error(`openclaw-entrypoint: invalid TELEGRAM_ALLOW_FROM_JSON: ${err}`);
      process.exit(1);
    }
  } else {
    allowFrom = raw
      .split(",")
      .map((entry) => String(entry).trim())
      .filter(Boolean);
  }
}

const replacement = JSON.stringify(allowFrom.map((entry) => String(entry).trim()).filter(Boolean));
const source = fs.readFileSync(configPath, "utf8");
let output = source.replace(/\"__TELEGRAM_ALLOW_FROM__\"/g, replacement);

if (rawSessionDmScope) {
  try {
    const parsed = JSON.parse(output);
    const session =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed.session ?? {})
        : {};
    if (typeof session !== "object" || Array.isArray(session)) {
      parsed.session = {};
    }
    parsed.session.dmScope = rawSessionDmScope;
    output = JSON.stringify(parsed, null, 2);
  } catch (err) {
    console.error(
      `openclaw-entrypoint: failed to set session.dmScope from OPENCLAW_SESSION_DM_SCOPE: ${err}`,
    );
  }
}

if (output !== source) {
  fs.writeFileSync(configPath, output);
}
NODE
  fi
  chmod 600 "$config_path" || true
  if [ "$(id -u)" = "0" ]; then
    chown node:node "$config_path" || true
  fi
}

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data /data/.openclaw /data/workspace
  ensure_workspace
  ensure_legacy_workspace
  chown -R node:node /data
  bootstrap_config
  if [ "${OPENCLAW_RUN_AS_ROOT:-}" = "1" ]; then
    exec "$@" "${bind_args[@]}"
  fi
  exec gosu node "$@" "${bind_args[@]}"
fi

ensure_workspace
ensure_legacy_workspace
bootstrap_config
exec "$@" "${bind_args[@]}"
