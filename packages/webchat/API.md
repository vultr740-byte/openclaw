# WebChat Chat API

This document describes the WebSocket API surface used by `packages/webchat` to integrate chat
with OpenClaw Gateway.

## Endpoint

- WebSocket URL: `ws://<gateway-host>:<port>` or `wss://<gateway-host>:<port>`
- Protocol version: `3`

## Frame Shapes

### Request Frame

```json
{
  "type": "req",
  "id": "req-123",
  "method": "chat.send",
  "params": {}
}
```

### Response Frame

```json
{
  "type": "res",
  "id": "req-123",
  "ok": true,
  "payload": {}
}
```

Error response:

```json
{
  "type": "res",
  "id": "req-123",
  "ok": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "..."
  }
}
```

### Event Frame

```json
{
  "type": "event",
  "event": "chat",
  "payload": {},
  "seq": 10
}
```

## Handshake Flow

1. Connect to gateway WebSocket.
2. Gateway sends `connect.challenge` event:

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": {
    "nonce": "<uuid>",
    "ts": 1730000000000
  }
}
```

3. Client sends `connect` request as the first request frame:

```json
{
  "type": "req",
  "id": "connect-1",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "webchat-ui",
      "version": "webchat/0.1.0",
      "platform": "web",
      "mode": "webchat",
      "instanceId": "<uuid>"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "caps": ["tool-events"],
    "auth": {
      "token": "<gateway-token>"
    },
    "locale": "en-US",
    "userAgent": "Mozilla/5.0 ..."
  }
}
```

4. Gateway replies with `hello-ok` in `payload` on success:

```json
{
  "type": "res",
  "id": "connect-1",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 3,
    "server": { "version": "2026.x.y", "connId": "..." },
    "features": { "methods": ["chat.history", "chat.send", "chat.abort"], "events": ["chat"] },
    "snapshot": {},
    "policy": {
      "maxPayload": 10485760,
      "maxBufferedBytes": 10485760,
      "tickIntervalMs": 5000
    }
  }
}
```

## Chat Methods

### `chat.history`

Request params:

```json
{
  "sessionKey": "main",
  "limit": 200
}
```

Notes:

- `limit` optional, range `1..1000`.
- Server default limit is `200`.

Success payload (shape):

```json
{
  "sessionKey": "main",
  "sessionId": "...",
  "messages": [],
  "thinkingLevel": "low",
  "verboseLevel": "off"
}
```

### `chat.send`

Request params:

```json
{
  "sessionKey": "main",
  "message": "Hello",
  "idempotencyKey": "<uuid>",
  "deliver": false,
  "thinking": "low",
  "timeoutMs": 120000,
  "attachments": []
}
```

Notes:

- `sessionKey` max length is `512`.
- `idempotencyKey` is required and should be unique per run.
- `deliver` is optional. WebChat usually uses `false`.

Immediate success response payload:

```json
{
  "runId": "<idempotencyKey>",
  "status": "started"
}
```

Possible cached/in-flight payload:

```json
{
  "runId": "<idempotencyKey>",
  "status": "in_flight"
}
```

Cached-complete payload can also return:

```json
{
  "runId": "<idempotencyKey>",
  "status": "ok"
}
```

Final assistant output is delivered by `chat` events (not in this response frame).

### `chat.abort`

Request params:

```json
{
  "sessionKey": "main",
  "runId": "<optional-run-id>"
}
```

Notes:

- If `runId` is omitted, gateway aborts active runs in the session.

Success payload:

```json
{
  "ok": true,
  "aborted": true,
  "runIds": ["..."]
}
```

## `chat` Event Payload

The gateway emits `event = "chat"` while a run is executing.

Payload shape:

```json
{
  "runId": "...",
  "sessionKey": "main",
  "seq": 1,
  "state": "delta | final | aborted | error",
  "message": {},
  "errorMessage": "...",
  "usage": {},
  "stopReason": "..."
}
```

State semantics:

- `delta`: streaming partial assistant text
- `final`: completed assistant reply
- `aborted`: run stopped (user or system abort)
- `error`: run failed

## Minimal Sequence Example

1. Receive `connect.challenge`.
2. Send `connect`.
3. Call `chat.history`.
4. Call `chat.send`.
5. Consume `chat` events:
   - one or more `delta`
   - then `final` (or `aborted` / `error`)
6. Optionally call `chat.abort`.
