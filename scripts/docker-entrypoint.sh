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

runtime_owner="node:node"
if [ "${OPENCLAW_RUN_AS_ROOT:-}" = "1" ]; then
  runtime_owner="root:root"
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
const rawTelegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
const rawControlUiAllowedOrigins = process.env.OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS?.trim() || "";
const rawRailwayStaticUrl = process.env.RAILWAY_STATIC_URL?.trim() || "";
const rawSessionDmScope = process.env.OPENCLAW_SESSION_DM_SCOPE?.trim() || "";
const rawXaiBaseUrl = process.env.XAI_BASE_URL?.trim() || "";
const rawXaiApiKey = process.env.XAI_API_KEY?.trim() || "";
const rawXaiModel = process.env.XAI_MODEL?.trim() || "";
const xaiConfigured = Boolean(rawXaiBaseUrl && rawXaiApiKey && rawXaiModel);

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

function normalizeOrigin(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  if (trimmed.includes("${") || trimmed.includes("}")) {
    return null;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return null;
  }
}

function normalizeOriginList(values) {
  const normalized = [];
  const seen = new Set();
  for (const value of values) {
    const origin = normalizeOrigin(value);
    if (!origin || seen.has(origin)) {
      continue;
    }
    seen.add(origin);
    normalized.push(origin);
  }
  return normalized;
}

function containsEnvReference(value) {
  return /\$\{[A-Z_][A-Z0-9_]*\}/.test(String(value ?? ""));
}

function normalizeConfiguredString(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || containsEnvReference(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function normalizeAllowFromEntries(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

function hasConfiguredTelegramToken(channelConfig) {
  if (!channelConfig || typeof channelConfig !== "object" || Array.isArray(channelConfig)) {
    return false;
  }
  if (rawTelegramBotToken) {
    return true;
  }
  if (
    normalizeConfiguredString(channelConfig.botToken) ||
    normalizeConfiguredString(channelConfig.tokenFile)
  ) {
    return true;
  }
  const accounts = channelConfig.accounts;
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) {
    return false;
  }
  return Object.values(accounts).some(
    (account) =>
      account &&
      typeof account === "object" &&
      !Array.isArray(account) &&
      (normalizeConfiguredString(account.botToken) ||
        normalizeConfiguredString(account.tokenFile)),
  );
}

let controlUiAllowedOrigins = null;
let shouldMergeDerivedControlUiAllowedOrigins = false;
if (rawControlUiAllowedOrigins) {
  controlUiAllowedOrigins = normalizeOriginList(
    rawControlUiAllowedOrigins
      .split(",")
      .map((entry) => String(entry).trim())
      .filter(Boolean),
  );
} else if (rawRailwayStaticUrl) {
  const derivedOrigins = normalizeOriginList([rawRailwayStaticUrl]);
  if (derivedOrigins.length > 0) {
    controlUiAllowedOrigins = derivedOrigins;
    shouldMergeDerivedControlUiAllowedOrigins = true;
  }
}

const replacement = JSON.stringify(allowFrom.map((entry) => String(entry).trim()).filter(Boolean));
const source = fs.readFileSync(configPath, "utf8");
let output = source.replace(/\"__TELEGRAM_ALLOW_FROM__\"/g, replacement);

if (rawSessionDmScope) {
  try {
    const parsed = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config root is not an object");
    }
    if (!parsed.session || typeof parsed.session !== "object" || Array.isArray(parsed.session)) {
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

try {
  const parsed = JSON.parse(output);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const root = parsed;
    const nextModels =
      root.models && typeof root.models === "object" && !Array.isArray(root.models)
        ? root.models
        : {};
    const nextProviders =
      nextModels.providers &&
      typeof nextModels.providers === "object" &&
      !Array.isArray(nextModels.providers)
        ? nextModels.providers
        : {};

    const nextAgents =
      root.agents && typeof root.agents === "object" && !Array.isArray(root.agents)
        ? root.agents
        : {};
    const nextDefaults =
      nextAgents.defaults &&
      typeof nextAgents.defaults === "object" &&
      !Array.isArray(nextAgents.defaults)
        ? nextAgents.defaults
        : {};
    const nextAgentModels =
      nextDefaults.models &&
      typeof nextDefaults.models === "object" &&
      !Array.isArray(nextDefaults.models)
        ? nextDefaults.models
        : {};

    const nextGateway =
      root.gateway && typeof root.gateway === "object" && !Array.isArray(root.gateway)
        ? root.gateway
        : {};
    const nextControlUi =
      nextGateway.controlUi &&
      typeof nextGateway.controlUi === "object" &&
      !Array.isArray(nextGateway.controlUi)
        ? nextGateway.controlUi
        : {};
    const nextChannels =
      root.channels && typeof root.channels === "object" && !Array.isArray(root.channels)
        ? root.channels
        : {};
    const nextTelegram =
      nextChannels.telegram &&
      typeof nextChannels.telegram === "object" &&
      !Array.isArray(nextChannels.telegram)
        ? nextChannels.telegram
        : null;

    if (controlUiAllowedOrigins !== null) {
      if (shouldMergeDerivedControlUiAllowedOrigins) {
        const existingAllowedOrigins = normalizeOriginList(
          Array.isArray(nextControlUi.allowedOrigins) ? nextControlUi.allowedOrigins : [],
        );
        nextControlUi.allowedOrigins = [...new Set([...existingAllowedOrigins, ...controlUiAllowedOrigins])];
      } else {
        nextControlUi.allowedOrigins = controlUiAllowedOrigins;
      }
      nextGateway.controlUi = nextControlUi;
      root.gateway = nextGateway;
    }

    if (nextTelegram) {
      const telegramAllowFrom = normalizeAllowFromEntries(nextTelegram.allowFrom);
      nextTelegram.allowFrom = telegramAllowFrom;

      if (!hasConfiguredTelegramToken(nextTelegram)) {
        nextTelegram.enabled = false;
        if (containsEnvReference(nextTelegram.botToken)) {
          delete nextTelegram.botToken;
        }
      }

      if (nextTelegram.dmPolicy === "allowlist" && telegramAllowFrom.length === 0) {
        nextTelegram.dmPolicy = "pairing";
      }

      nextChannels.telegram = nextTelegram;
      root.channels = nextChannels;
    }

    if (!xaiConfigured) {
      delete nextProviders.xai;
      for (const key of Object.keys(nextAgentModels)) {
        if (key.startsWith("xai/")) {
          delete nextAgentModels[key];
        }
      }
    } else {
      nextProviders.xai = {
        baseUrl: "${XAI_BASE_URL}",
        apiKey: "${XAI_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "${XAI_MODEL}",
            name: "${XAI_MODEL}",
          },
        ],
      };
      const xaiModelKey = "xai/${XAI_MODEL}";
      const existingXaiModel = nextAgentModels[xaiModelKey];
      nextAgentModels[xaiModelKey] =
        existingXaiModel &&
        typeof existingXaiModel === "object" &&
        !Array.isArray(existingXaiModel)
          ? { ...existingXaiModel, streaming: false }
          : { streaming: false };
    }

    nextDefaults.models = nextAgentModels;
    nextAgents.defaults = nextDefaults;
    root.agents = nextAgents;
    nextModels.providers = nextProviders;
    root.models = nextModels;
    output = JSON.stringify(root, null, 2);
  }
} catch (err) {
  console.error(`openclaw-entrypoint: failed to normalize optional XAI config: ${err}`);
}

if (output !== source) {
  fs.writeFileSync(configPath, output);
}
NODE
  fi
  chmod 600 "$config_path" || true
  if [ "$(id -u)" = "0" ]; then
    chown "$runtime_owner" "$config_path" || true
  fi
}

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data /data/.openclaw /data/workspace
  ensure_workspace
  ensure_legacy_workspace
  chown -R "$runtime_owner" /data
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
