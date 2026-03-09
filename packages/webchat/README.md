# WebChat

Minimal browser chat UI for OpenClaw Gateway over WebSocket.

## Run

```bash
pnpm --dir packages/webchat install
pnpm --dir packages/webchat dev --host 127.0.0.1 --port 4173
```

Open `http://127.0.0.1:4173/`.

## Features (MVP)

- `connect.challenge` -> `connect` handshake
- `chat.history`
- `chat.send`
- `chat.abort`
- stream event handling: `delta` / `final` / `aborted` / `error`

## URL Params

You can prefill settings from query or hash params:

- `gatewayUrl`: WebSocket endpoint, e.g. `ws://127.0.0.1:18789`
- `token`: gateway token
- `session`: chat session key (default `main`)

Example:

```text
http://127.0.0.1:4173/?gatewayUrl=ws://127.0.0.1:18789&session=main&token=YOUR_TOKEN
```

After reading parameters, the page removes them from the URL.
