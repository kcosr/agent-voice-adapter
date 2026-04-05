# Client Integration Notes

This document is for another application that wants to act as a turn-mode voice client for the existing Node.js backend.

Scope:
- receive server-driven TTS turns over WebSocket
- play streamed PCM audio locally
- optionally capture microphone audio and send it back for STT
- optionally submit turns over HTTP from the same app or a separate agent

This is not a full SDK contract. It is the minimum integration behavior a custom client must implement against the current server.

For the separate non-turn direct-media contract (`/api/media/*`, `media_*` websocket messages, explicit `clientId` targeting), see [direct-media-backend-contract.md](direct-media-backend-contract.md).

## Architecture

There are two separate channels:

1. HTTP control plane
   - `POST /api/turn`
   - `POST /api/turn/cancel`
   - `POST /api/turn/stop-tts`
   - `GET /api/status`

2. WebSocket media/runtime plane
   - connect to `/ws`
   - advertise client capabilities and availability
   - receive turn lifecycle events and audio chunks
   - optionally upload microphone audio for listen turns

Typical flow:

1. Client connects to `/ws`.
2. Client sends `client_state_update`.
3. Optional but recommended: client sends `client_activate` if more than one voice client may be connected.
4. Some caller submits `POST /api/turn`.
5. Server selects one eligible WebSocket client as the turn owner.
6. Server broadcasts `turn_start`.
7. Server sends `turn_audio_chunk` only to the owner client.
8. Server broadcasts `turn_tts_end`.
9. If `listenRequested=true`, the owner client captures mic audio and sends it back over WebSocket.
10. Server emits `turn_listen_result`.

## Startup Requirements

On WebSocket connect, send:

```json
{
  "type": "client_state_update",
  "acceptingTurns": true,
  "speechEnabled": true,
  "listeningEnabled": true,
  "inTurn": false,
  "turnModeEnabled": true,
  "directTtsEnabled": false,
  "directSttEnabled": false
}
```

Meaning:
- `acceptingTurns`: this client is eligible for dispatch
- `speechEnabled`: this client can play TTS audio
- `listeningEnabled`: this client can capture/send mic audio for listen turns
- `inTurn`: this client is currently busy; when `true`, dispatch may be held
- `turnModeEnabled`: whether this client should ever receive `/api/turn` traffic
- `directTtsEnabled` / `directSttEnabled`: direct-media capabilities; set these only if the client also implements the direct-media contract

If multiple voice-capable clients may be connected, send:

```json
{ "type": "client_activate" }
```

Without an active client, `POST /api/turn` can still route to any eligible turn-mode client. Use `client_activate` when you need deterministic device ownership rather than best-effort eligible-client routing.

## Minimum TTS Client

To support text-to-speech only, a client must implement:

- WebSocket connect to `/ws`
- `client_state_update`
- receive `turn_start`
- receive `turn_audio_chunk`
- receive `turn_tts_end`

### `turn_start`

Example:

```json
{
  "type": "turn_start",
  "turnId": "uuid",
  "createdAt": "2026-03-29T12:00:00.000Z",
  "originalText": "Hello",
  "sanitizedText": "Hello",
  "providerId": "elevenlabs",
  "modelId": "eleven_multilingual_v2",
  "voiceId": "voice-id",
  "listenRequested": false,
  "listenModelId": null
}
```

Practical meaning:
- all clients receive this
- only the selected owner should play TTS
- non-owner clients can still render UI state for the turn

### `turn_audio_chunk`

Example:

```json
{
  "type": "turn_audio_chunk",
  "turnId": "uuid",
  "sampleRate": 24000,
  "encoding": "pcm_s16le",
  "chunkBase64": "..."
}
```

Requirements:
- decode `chunkBase64`
- treat bytes as signed 16-bit little-endian PCM
- play at the provided `sampleRate`
- current server encoding is only `pcm_s16le`

### `turn_tts_end`

Example:

```json
{
  "type": "turn_tts_end",
  "turnId": "uuid",
  "success": true
}
```

If `success=false`, the client should stop local playback and mark the turn failed.

## Recommended TTS Completion Ack

For non-listen turns, a client should send a playback terminal ack after local playback actually finishes or is aborted:

```json
{
  "type": "turn_playback_terminal",
  "turnId": "uuid",
  "status": "done"
}
```

Abort example:

```json
{
  "type": "turn_playback_terminal",
  "turnId": "uuid",
  "status": "aborted",
  "reason": "local_stop"
}
```

Why it matters:
- the server can treat TTS generation as finished before the client has drained buffered playback
- for no-listen turns, this ack lets the server align turn completion with real local playback completion
- if omitted, the server falls back to timeout behavior

## Minimum STT / Listen Client

To support `listen=true` turns, a client must implement everything above plus:

- receive `turn_tts_end`
- detect `listenRequested=true` from `turn_start`
- start local capture after playback handoff
- send either streaming capture messages or a one-shot blob
- handle `turn_listen_start`
- handle `turn_listen_stop`
- handle `turn_listen_result`

The current browser and Android clients use streaming capture.

## Streaming Listen Protocol

Start capture:

```json
{
  "type": "turn_listen_stream_start",
  "turnId": "uuid",
  "sampleRate": 48000,
  "channels": 1,
  "encoding": "pcm_s16le",
  "modelId": "optional-asr-model-override"
}
```

Send chunks:

```json
{
  "type": "turn_listen_stream_chunk",
  "turnId": "uuid",
  "chunkBase64": "..."
}
```

End capture:

```json
{
  "type": "turn_listen_stream_end",
  "turnId": "uuid"
}
```

Requirements:
- use the same `turnId` from `turn_start`
- audio encoding must be `pcm_s16le`
- the same WebSocket that sent `turn_listen_stream_start` must send the chunks and end message
- owner-only semantics apply; a non-owner socket is ignored

Server behavior:
- server buffers PCM chunks
- server performs endpointing based on RMS and trailing silence
- server converts buffered PCM to WAV internally before ASR

## One-Shot Listen Protocol

If your app already records a clip locally, it can skip streaming and upload one blob:

```json
{
  "type": "turn_listen_blob",
  "turnId": "uuid",
  "audioBase64": "...",
  "mimeType": "audio/wav",
  "modelId": "optional-asr-model-override"
}
```

This is simpler to implement, but you lose server-side live endpointing during capture.

## Listen Lifecycle Events

### `turn_listen_start`

Example:

```json
{
  "type": "turn_listen_start",
  "turnId": "uuid",
  "providerId": "parakeet_local",
  "modelId": "nvidia/parakeet-ctc-0.6b"
}
```

Meaning:
- server accepted recognition work
- useful for UI state only; capture usually already started locally

### `turn_listen_stop`

Example:

```json
{
  "type": "turn_listen_stop",
  "turnId": "uuid",
  "reason": "silence"
}
```

Common reasons:
- `silence`
- `max_duration`
- `client_end`
- `max_bytes`
- `socket_closed`

Meaning:
- stop local capture if it is still running

### `turn_listen_result`

Success example:

```json
{
  "type": "turn_listen_result",
  "turnId": "uuid",
  "success": true,
  "text": "recognized speech",
  "providerId": "parakeet_local",
  "modelId": "nvidia/parakeet-ctc-0.6b",
  "durationMs": 1203
}
```

Retryable no-speech example:

```json
{
  "type": "turn_listen_result",
  "turnId": "uuid",
  "success": false,
  "error": "no_usable_speech",
  "retryable": true,
  "providerId": "parakeet_local",
  "modelId": "nvidia/parakeet-ctc-0.6b",
  "durationMs": 0
}
```

Client expectations:
- if `success=true`, treat `text` as the recognition result
- if `retryable=true`, you may re-arm capture for the same turn
- cancellation metadata may be included: `canceled=true`, `cancelReason`
- timeout fallback may be included: `timeoutFallbackUsed=true`

## HTTP Calls Another App May Use

### `POST /api/turn`

Minimum TTS request:

```json
{
  "text": "Hello world"
}
```

TTS plus listen:

```json
{
  "text": "What do you want to do next?",
  "listen": true
}
```

Response shapes:
- `202` for `listen=false`
- `200` for `listen=true` after recognition reaches terminal state

### `POST /api/turn/stop-tts`

Use to skip the rest of local playback:

```json
{
  "turnId": "uuid"
}
```

For `listen=true` turns, this transitions toward recognition rather than canceling the turn.

### `POST /api/turn/cancel`

Use to fully cancel a queued or active turn:

```json
{
  "turnId": "uuid"
}
```

## Integration Profiles

### Profile A: Playback-only client

Implement:
- WebSocket connect
- `client_state_update` with `speechEnabled=true`, `listeningEnabled=false`
- `turn_start`
- `turn_audio_chunk`
- `turn_tts_end`
- recommended `turn_playback_terminal`

Use when:
- another device/app handles mic capture
- you only want spoken output

### Profile B: Full duplex voice client

Implement:
- everything in Profile A
- local microphone capture
- `turn_listen_stream_start`
- `turn_listen_stream_chunk`
- `turn_listen_stream_end`
- `turn_listen_result`

Use when:
- the app should act like the browser widget or Android service

### Profile C: Recorded-clip recognition client

Implement:
- everything in Profile A
- local recording UX
- `turn_listen_blob`
- `turn_listen_result`

Use when:
- streaming capture is inconvenient
- batch upload is acceptable

## Operational Notes

- Keep the WebSocket alive for the whole client session.
- Send updated `client_state_update` values whenever speech/listen availability changes.
- Set `inTurn=true` while your app is actively handling a turn; set it back to `false` when done.
- If multiple clients can be connected, explicitly manage ownership with `client_activate` / `client_deactivate`.
- If your app buffers playback locally, implement `turn_playback_terminal`.
- For `listen=true`, wait until local playback is actually out of the way before opening the mic, otherwise the app can capture its own TTS.

## Good First Test Plan

1. Connect one client and send `client_state_update`.
2. Submit `POST /api/turn` with `listen=false`.
3. Verify `turn_start`, `turn_audio_chunk*`, `turn_tts_end`.
4. Add `turn_playback_terminal` and verify no regressions.
5. Submit `POST /api/turn` with `listen=true`.
6. Verify capture start, chunk upload, `turn_listen_stop`, and `turn_listen_result`.
7. Test `POST /api/turn/stop-tts`.
8. Test disconnect/reconnect and `client_activate`.
