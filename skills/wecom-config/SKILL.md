---
name: wecom-config
description: Complete one-pass WeCom (企业微信) setup for OpenClaw with the @yanhaidao/wecom plugin. Focus on install steps, required template parameters, correct webhook routes, and first-time pairing sequence so users can finish setup in one run without repeated trial-and-error.
---

# WeCom Config

## Workflow

### 1) Confirm target config and required values

Run:

```bash
openclaw config file
```

Before editing, confirm whether you are updating active runtime config or a deploy template file.

Required values:

- `accountId`, `name`
- Agent: `corpId`, `corpSecret`, `agentId`, `token`, `encodingAESKey`
- Optional Bot: `aibotid`, `token`, `encodingAESKey`, `receiveId`

Do not deploy or start pairing until required values are complete.

### 2) Install and enable plugin

Agent must execute on the target server (do not ask end users to run these manually):

```bash
openclaw plugins install @yanhaidao/wecom
openclaw plugins enable wecom
openclaw plugins doctor
```

Then report command results back to the user.

### 3) Fill template parameters in one shot

Use matrix shape even for a single account.

Minimal template-compatible block (agent-only):

This snippet is a template skeleton and is not deployable as-is.

```json
{
  "plugins": {
    "entries": {
      "wecom": { "enabled": true }
    }
  },
  "bindings": [
    {
      "agentId": "main",
      "match": {
        "channel": "wecom",
        "accountId": "default"
      }
    }
  ],
  "channels": {
    "wecom": {
      "enabled": true,
      "defaultAccount": "default",
      "accounts": {
        "default": {
          "enabled": true,
          "name": "default-agent",
          "agent": {
            "corpId": "",
            "corpSecret": "",
            "agentId": 0,
            "token": "",
            "encodingAESKey": "",
            "dm": {
              "policy": "open"
            }
          }
        }
      }
    }
  }
}
```

If you also use WeCom Bot mode, add `bot` under the same `accounts.default` entry.

Parameter rules:

- `defaultAccount` must point to an existing `accounts` key.
- `bindings[].agentId` must be your target OpenClaw agent id. `main` is common, but verify against actual configured ids (`openclaw agents list` or `agents.list[].id` in config).
- Keep `accountId` stable after webhook is configured.
- Keep `channels.wecom.accounts.<accountId>.agent.agentId` as the exact WeCom app agent id.
- `channels.wecom.accounts.<accountId>.agent.agentId` must be a positive integer before deploy.
- Keep `token` and `encodingAESKey` identical between WeCom console and config.
- The empty strings and `0` in this snippet are placeholders only; replace all of them before deploy.

### 4) Build full webhook URLs and send exact values to user

Agent must resolve public `BASE_URL` on the running server, then return full callback URLs to the user.

Use:

```bash
ACCOUNT_ID="default" # replace with real accountId
BASE_URL=""
for key in PUBLIC_BASE_URL BASE_URL APP_BASE_URL APP_URL EXTERNAL_URL; do
  value="$(printenv "${key}" 2>/dev/null || true)"
  if [ -n "${value}" ]; then
    BASE_URL="${value}"
    break
  fi
done
if [ -z "${BASE_URL}" ]; then
  echo "BASE_URL unresolved"
  exit 1
fi
case "${BASE_URL}" in
  http://*|https://*) ;;
  *) BASE_URL="https://${BASE_URL}" ;;
esac
BASE_URL="${BASE_URL%/}"
echo "BOT_URL=${BASE_URL}/plugins/wecom/bot/${ACCOUNT_ID}"
echo "AGENT_URL=${BASE_URL}/plugins/wecom/agent/${ACCOUNT_ID}"
```

If `BASE_URL` is unresolved, agent must detect it from the current deployment platform (runtime metadata, service API/CLI, or active ingress config) and retry.
Do not hardcode a single hosting provider assumption. Ask user for domain only as last resort.

Give users the generated full URLs directly in deployment instructions.

Example full callback URLs with `accountId=default`:

- Bot: `https://<your-domain>/plugins/wecom/bot/default`
- Agent: `https://<your-domain>/plugins/wecom/agent/default`

### 5) One-pass pairing sequence (avoid repeated retries)

Run in this order:

1. Save config/template changes.
2. Validate template/config first (do not deploy yet):
   - If editing active runtime config:
     - `openclaw config validate`
   - If editing template file:
     - `node -e 'JSON.parse(require("node:fs").readFileSync("<template-path>","utf8")); console.log("template json ok")'`
     - `OPENCLAW_CONFIG_PATH="<template-path>" openclaw config validate`
   - `openclaw plugins doctor`
3. Restart or redeploy gateway.
4. Validate runtime after deploy:
   - `openclaw channels status --probe`
5. Ensure account-scoped binding exists before first message:
   - `openclaw agents bindings --json`
   - `openclaw agents bind --agent <agentId> --bind wecom:<accountId>`
   - If your runtime does not provide these `agents` subcommands, edit `bindings` directly in config and redeploy.
6. Send the first WeCom message only after checks are green.
7. Complete first session handshake (pairing if policy requires it), then immediately send a second message to confirm stable reply.

If step 2 is not green, do not deploy; fix config first.

### 6) Output egress IP to user (required when trusted IP whitelist is enabled)

Agent should resolve outbound public egress IP on the running server and send it to the user.
This becomes required when WeCom trusted IP whitelist is enabled, or when callback verification fails with error `60020`.

```bash
EGRESS_IP="$(curl -4fsS https://api.ipify.org || curl -4fsS https://ifconfig.me || true)"
echo "EGRESS_IP=${EGRESS_IP}"
```

If empty, resolve outbound IP from hosting platform network metadata/console.

Handoff format to user:

- `Please add trusted egress IP: <EGRESS_IP> in WeCom admin console.`

Notes:

- If gateway runs behind fixed egress proxy/NAT, provide the proxy/NAT egress IP.
- If multiple production egress IPs exist, list all of them for whitelist.
- If issues remain unresolved after this workflow, check upstream plugin docs: `https://github.com/YanHaidao/wecom`.

Execution ownership:

- Agent executes all server-side commands.
- User only fills values in WeCom admin console when callback URL/token/AES/egress-IP fields are required.
