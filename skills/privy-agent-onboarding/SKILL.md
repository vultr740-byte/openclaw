---
name: privy-agent-onboarding
description: Set up Privy agent wallets for login, funding, signing, and onchain transactions. Use when an agent needs Ethereum or Solana wallet access through Privy on the gateway host.
homepage: https://agents.privy.io
metadata:
  {
    "openclaw":
      {
        "homepage": "https://agents.privy.io",
        "requires": { "anyBins": ["pnpm", "corepack"] },
        "install":
          [
            {
              "id": "pnpm",
              "kind": "node",
              "package": "pnpm",
              "bins": ["pnpm"],
              "label": "Install pnpm",
            },
          ],
      },
  }
---

# Privy Agent Wallets

Use Privy to give the agent Ethereum and Solana wallets on the OpenClaw gateway host.

The upstream reference for this skill lives at `https://agents.privy.io/skill.md`.
Re-fetch it if commands, auth flow, or supported RPC methods change.

## Guardrails

- Commands run on the gateway host, not on the user's laptop unless OpenClaw is running there.
- Treat the returned wallet credentials blob like a secret. Do not paste it into logs, commits, or public chats.
- Prefer `pnpm dlx @privy-io/agent-wallet-cli ...` for ad hoc use. If only `corepack` exists, use `corepack pnpm dlx ...`.
- Step 1 login must happen before Step 2 completion. The pending session from Step 1 is required.

## CLI entrypoint

Use the Privy CLI through `pnpm dlx`:

```bash
pnpm dlx @privy-io/agent-wallet-cli <command>
```

If `pnpm` is not installed but `corepack` is available, use:

```bash
corepack pnpm dlx @privy-io/agent-wallet-cli <command>
```

Do not switch this workflow to `npx`.

## Optional host prerequisites

macOS needs no extra setup.

Linux:

```bash
sudo apt install -y libsecret-tools
```

Windows PowerShell:

```powershell
Install-Module Microsoft.PowerShell.SecretManagement -Scope CurrentUser
Install-Module Microsoft.PowerShell.SecretStore -Scope CurrentUser
```

Without a working keychain or secret store, the CLI falls back to `~/.privy/session.json`.

## Login flow

Run the login flow yourself from OpenClaw when commands execute on the real target host.
Do not tell the user to run the command manually unless OpenClaw cannot access the correct machine.
When you run Step 1, send the command output to the user as its own standalone message.
Do not merge that output into a summary, tool narration, or any other combined reply.

### Step 1: initiate login

```bash
pnpm dlx @privy-io/agent-wallet-cli login --non-interactive
```

This creates a pending session and opens the browser authentication flow.
The output from this command is user-facing and must be delivered as one separate message by itself so the user can follow the browser step and copy the next credentials blob correctly.

### Step 2: finish login with the credentials blob

After the user completes browser authentication and sends back the JSON blob, run:

```bash
pnpm dlx @privy-io/agent-wallet-cli login --non-interactive '{"ethereum":{"wallet_id":"...","address":"0x..."},"solana":{"wallet_id":"...","address":"..."}}'
```

### Backup the session immediately

After a successful login, back up the session because some environments fail to persist keychain state reliably:

```bash
cat ~/.privy/session.json > ~/.privy/session.backup.json 2>/dev/null || security find-generic-password -s "privy-agent-cli" -w | tee ~/.privy/session.backup.json > /dev/null
```

If later commands report that the agent is logged out, restore from the backup:

```bash
cp ~/.privy/session.backup.json ~/.privy/session.json && chmod 600 ~/.privy/session.json
```

## Persist wallet details to memory

After login succeeds, record the wallet addresses in agent memory or deployment notes so later conversations know wallet access exists:

```text
Privy Agent Wallets (via @privy-io/agent-wallet-cli):
  Ethereum: 0x<address>
  Solana:   <address>
  Logged in: <date>
  Session expires: about 7 days from login
```

## Common commands

Fund the wallets:

```bash
pnpm dlx @privy-io/agent-wallet-cli fund
```

List wallets:

```bash
pnpm dlx @privy-io/agent-wallet-cli list-wallets
```

Send RPC payloads:

```bash
pnpm dlx @privy-io/agent-wallet-cli rpc --json '<body>'
```

Or from stdin:

```bash
echo '<body>' | pnpm dlx @privy-io/agent-wallet-cli rpc
```

## Supported RPC categories

Ethereum:

- `personal_sign`
- `eth_sendTransaction`
- `eth_signTransaction`
- `eth_signTypedData_v4`
- `secp256k1_sign`
- `eth_sign7702Authorization`
- `eth_signUserOperation`

Solana:

- `signTransaction`
- `signAndSendTransaction`
- `signMessage`

## Examples

Sign an Ethereum message:

```bash
pnpm dlx @privy-io/agent-wallet-cli rpc --json '{
  "method": "personal_sign",
  "params": {
    "message": "Hello from OpenClaw"
  }
}'
```

Send an Ethereum transaction:

```bash
pnpm dlx @privy-io/agent-wallet-cli rpc --json '{
  "method": "eth_sendTransaction",
  "params": {
    "transaction": {
      "to": "0xRecipientAddress",
      "value": "0x2386F26FC10000",
      "chainId": 1
    }
  }
}'
```

Sign and send a Solana transaction:

```bash
pnpm dlx @privy-io/agent-wallet-cli rpc --json '{
  "method": "signAndSendTransaction",
  "params": {
    "transaction": "<base64-encoded-transaction>"
  }
}'
```
