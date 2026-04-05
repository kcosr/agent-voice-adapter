# Direct Media Backend Contract

This document defines the backend contract for direct-media mode in `agent-voice-adapter`.

Status:
- backend/protocol contract for the current rollout
- additive to existing turn mode
- initial client target is the native Android client

Non-goals for this phase:
- changing existing `/api/turn` behavior
- migrating existing browser or standalone Android turn-mode clients
- introducing a direct-media queue
- moving Android runtime code in this phase

Recognition timing note:
- runtime defaults are shared across both `/api/turn` listen turns and direct-media STT: `asrListenStartTimeoutMs`, `asrListenCompletionTimeoutMs`, and `asrRecognitionEndSilenceMs`
- `/api/turn` may override them per request with `listenStartTimeoutMs`, `listenCompletionTimeoutMs`, and `endSilenceMs`
- `media_stt_start` may override them per request with `startTimeoutMs`, `completionTimeoutMs`, and `endSilenceMs`

## Product Decisions

These decisions are fixed for the initial backend rollout:

- Direct media is additive. Existing `/api/turn` APIs and `turn_*` websocket messages stay intact.
- Initial direct-media rollout is for the native Android client model.
- Backend scope is direct TTS and direct STT primitives only.
- Direct media does not use active-client routing.
- Direct media requests target an explicit client identity.
- Client capability advertisement is extended so direct-media-only clients are excluded from turn routing.
- Direct TTS starts over HTTP and streams over websocket.
- Direct STT supports websocket streaming as the primary path and HTTP blob upload as the secondary path.
- There is no global direct-media queue in this phase.
- At most one active direct TTS request per client is allowed.
- At most one active direct STT request per client is allowed.
- Conflicting direct-media requests are rejected explicitly.

## Client Identity

Each websocket connection receives a server-issued client identity:

```json
{
  "type": "client_identity",
  "clientId": "uuid"
}
```

Rules:
- `clientId` is opaque and server-generated.
- `clientId` is scoped to the current websocket connection.
- reconnecting yields a new `clientId`.
- HTTP direct-media routes must target a currently connected `clientId`.
- direct STT websocket messages do not include `clientId`; ownership is derived from the sending socket.

The server also exposes current direct-media-capable clients via `GET /api/status`.

## Capability Advertisement

Clients still use `client_state_update`, now with additive direct-media capability fields:

```json
{
  "type": "client_state_update",
  "acceptingTurns": false,
  "speechEnabled": true,
  "listeningEnabled": false,
  "inTurn": false,
  "turnModeEnabled": false,
  "directTtsEnabled": true,
  "directSttEnabled": true
}
```

Field meanings:
- `acceptingTurns`: runtime willingness to accept turn-mode traffic
- `speechEnabled`: turn-mode TTS playback capability/state
- `listeningEnabled`: turn-mode post-TTS listen capability/state
- `inTurn`: turn-mode busy state
- `turnModeEnabled`: whether this client should ever be eligible for `/api/turn` routing
- `directTtsEnabled`: whether this client accepts `/api/media/tts` requests
- `directSttEnabled`: whether this client accepts direct STT requests

Compatibility rules:
- legacy clients that do not send `turnModeEnabled` are treated as `true`
- legacy clients that do not send `directTtsEnabled` / `directSttEnabled` are treated as `false`
- direct-media-only clients should set `turnModeEnabled=false`

## HTTP API

## `POST /api/media/tts`

Start a direct TTS request for a specific connected client.

Request:

```json
{
  "clientId": "uuid",
  "requestId": "uuid",
  "text": "Hello world",
  "model": "optional-model-id",
  "voice": "optional-voice-id"
}
```

Success response: `202`

```json
{
  "accepted": true,
  "clientId": "uuid",
  "requestId": "uuid",
  "providerId": "elevenlabs",
  "modelId": "eleven_multilingual_v2",
  "voiceId": "voice-id",
  "textChangedBySanitizer": false
}
```

Error cases:
- `400` missing/invalid fields
- `404` target `clientId` not connected
- `409` target client does not advertise `directTtsEnabled`
- `409` target client already has an active direct TTS request

## `POST /api/media/tts/stop`

Stop the active direct TTS request for a specific client.

Request:

```json
{
  "clientId": "uuid",
  "requestId": "uuid"
}
```

Success response: `200`

```json
{
  "ok": true,
  "clientId": "uuid",
  "requestId": "uuid",
  "stopped": true
}
```

Error cases:
- `400` missing fields
- `404` matching active direct TTS request not found

Semantics:
- this is a media stop, not a turn-mode handoff
- stopping direct TTS ends the request with websocket status `stopped`

## `POST /api/media/stt`

Secondary/fallback direct STT path for uploading one audio blob over HTTP.

Request:

```json
{
  "clientId": "uuid",
  "requestId": "uuid",
  "audioBase64": "...",
  "mimeType": "audio/wav",
  "modelId": "optional-asr-model-id"
}
```

Success response: `200`

```json
{
  "accepted": true,
  "clientId": "uuid",
  "requestId": "uuid",
  "success": true,
  "text": "recognized speech",
  "providerId": "parakeet_local",
  "modelId": "nvidia/parakeet-ctc-0.6b",
  "durationMs": 1203
}
```

Terminal failure response after the request becomes active: `409`, `502`, or `504`

```json
{
  "accepted": false,
  "clientId": "uuid",
  "requestId": "uuid",
  "success": false,
  "error": "no_usable_speech",
  "retryable": true,
  "providerId": "parakeet_local",
  "modelId": "nvidia/parakeet-ctc-0.6b",
  "durationMs": 0
}
```

Error cases:
- `400` invalid request body
- `400` ASR provider not configured
- `404` target `clientId` not connected
- `409` target client does not advertise `directSttEnabled`
- `409` target client already has an active direct STT request
- `409` direct STT `requestId` is already active
- `409` request canceled due to client or HTTP caller disconnect
- `502` transcription failure
- `504` timeout-class failure

Side effects:
- if the target websocket is still connected, the server also emits `media_stt_started` and `media_stt_result`

## `POST /api/media/stt/cancel`

Cancel the active direct STT request for a specific client.

Request:

```json
{
  "clientId": "uuid",
  "requestId": "uuid"
}
```

Success response: `200`

```json
{
  "ok": true,
  "clientId": "uuid",
  "requestId": "uuid",
  "canceled": true
}
```

Error cases:
- `400` missing fields
- `404` matching active direct STT request not found

Semantics:
- valid for both websocket-stream and HTTP-blob direct STT requests
- cancellation is best-effort once provider recognition has started; late provider completions are dropped

## WebSocket Protocol

## Server -> Client

### `client_identity`

```json
{
  "type": "client_identity",
  "clientId": "uuid"
}
```

### `media_tts_start`

```json
{
  "type": "media_tts_start",
  "clientId": "uuid",
  "requestId": "uuid",
  "providerId": "elevenlabs",
  "modelId": "eleven_multilingual_v2",
  "voiceId": "voice-id",
  "textChangedBySanitizer": false,
  "outputSampleRate": 24000
}
```

### `media_tts_audio_chunk`

```json
{
  "type": "media_tts_audio_chunk",
  "clientId": "uuid",
  "requestId": "uuid",
  "sampleRate": 24000,
  "encoding": "pcm_s16le",
  "chunkBase64": "..."
}
```

### `media_tts_end`

```json
{
  "type": "media_tts_end",
  "clientId": "uuid",
  "requestId": "uuid",
  "status": "completed",
  "providerId": "elevenlabs",
  "modelId": "eleven_multilingual_v2",
  "voiceId": "voice-id"
}
```

`status` values:
- `completed`
- `stopped`
- `failed`
- `canceled`

### `media_stt_started`

```json
{
  "type": "media_stt_started",
  "clientId": "uuid",
  "requestId": "uuid",
  "inputMode": "stream",
  "providerId": "parakeet_local",
  "modelId": "nvidia/parakeet-ctc-0.6b"
}
```

### `media_stt_stopped`

```json
{
  "type": "media_stt_stopped",
  "clientId": "uuid",
  "requestId": "uuid",
  "inputMode": "stream",
  "reason": "silence"
}
```

`reason` values:
- `silence`
- `max_duration`
- `client_end`
- `max_bytes`
- `socket_closed`
- `client_cancel`

### `media_stt_result`

Success:

```json
{
  "type": "media_stt_result",
  "clientId": "uuid",
  "requestId": "uuid",
  "inputMode": "stream",
  "success": true,
  "text": "recognized speech",
  "providerId": "parakeet_local",
  "modelId": "nvidia/parakeet-ctc-0.6b",
  "durationMs": 1203
}
```

Failure:

```json
{
  "type": "media_stt_result",
  "clientId": "uuid",
  "requestId": "uuid",
  "inputMode": "stream",
  "success": false,
  "error": "no_usable_speech",
  "retryable": true,
  "providerId": "parakeet_local",
  "modelId": "nvidia/parakeet-ctc-0.6b",
  "durationMs": 0
}
```

Cancellation:

```json
{
  "type": "media_stt_result",
  "clientId": "uuid",
  "requestId": "uuid",
  "inputMode": "blob",
  "success": false,
  "error": "canceled",
  "canceled": true,
  "cancelReason": "client_cancel",
  "providerId": "parakeet_local",
  "modelId": "nvidia/parakeet-ctc-0.6b",
  "durationMs": 0
}
```

`cancelReason` values:
- `client_cancel`
- `client_disconnect`
- `request_disconnected`

## Client -> Server

## `media_stt_start`

Start a websocket-streaming direct STT request owned by the sending client.

```json
{
  "type": "media_stt_start",
  "requestId": "uuid",
  "sampleRate": 48000,
  "channels": 1,
  "encoding": "pcm_s16le",
  "modelId": "optional-asr-model-id",
  "startTimeoutMs": 30000,
  "completionTimeoutMs": 60000,
  "endSilenceMs": 1200
}
```

Rules:
- no `clientId` field is sent; ownership is implicit from the websocket
- only one active direct STT request per client is allowed
- `encoding` must be `pcm_s16le`
- each timing override is optional and must be a positive integer when present
- absent timing overrides fall back to the current runtime server settings

## `media_stt_chunk`

```json
{
  "type": "media_stt_chunk",
  "requestId": "uuid",
  "chunkBase64": "..."
}
```

`chunkBase64` must be valid base64 for PCM bytes. Malformed chunk payloads fail that direct STT request immediately.

## `media_stt_end`

```json
{
  "type": "media_stt_end",
  "requestId": "uuid"
}
```

## `media_stt_cancel`

```json
{
  "type": "media_stt_cancel",
  "requestId": "uuid"
}
```

## Error and Disconnect Semantics

- Direct-media requests are never routed through the active-client mechanism.
- Targeting for HTTP direct-media routes is explicit by `clientId`.
- If a target client disconnects during direct TTS, the active request is canceled and removed; no replay or queueing occurs.
- If a client disconnects during direct STT, the request is canceled and any late ASR completion is ignored.
- Invalid `audioBase64` in `POST /api/media/stt` is rejected with HTTP `400`.
- Invalid `/api/turn` timing overrides (`listenStartTimeoutMs`, `listenCompletionTimeoutMs`, `endSilenceMs`) are rejected with HTTP `400`.
- Invalid or conflicting direct STT websocket operations result in an immediate `media_stt_result` failure on that socket when a `requestId` is available.
- Invalid direct STT websocket timing overrides (`startTimeoutMs`, `completionTimeoutMs`, `endSilenceMs`) result in an immediate `media_stt_result` failure for that `requestId`.
- Conflicting direct TTS or HTTP direct STT requests return HTTP `409`.

## Stop and Cancel Semantics

- Direct TTS uses `POST /api/media/tts/stop`.
- Direct STT uses websocket `media_stt_cancel` or `POST /api/media/stt/cancel`.
- There is no direct-media queue in this phase.
- A stopped or canceled request frees the per-client slot immediately.

## Status and Observability

`GET /api/status` now includes:
- `directTtsCapableClients`
- `directSttCapableClients`
- `activeDirectTtsRequests`
- `activeDirectSttRequests`
- `directClients[]`

Each `directClients[]` entry exposes:
- `clientId`
- `turnModeEnabled`
- `acceptingTurns`
- `speechEnabled`
- `listeningEnabled`
- `directTtsEnabled`
- `directSttEnabled`
- `inTurn`
- `activeDirectTtsRequestId`
- `activeDirectSttRequestId`

`server_state` websocket messages also include the direct-media capability and active-request counts.
