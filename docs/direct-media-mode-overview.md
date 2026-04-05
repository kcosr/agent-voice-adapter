# Direct Media Mode Overview

Status note:
- historical design/proposal document
- useful for rationale and tradeoff context
- not the source of truth for the current implementation
- for the current backend contract, see `docs/direct-media-backend-contract.md` and `README.md`

## Purpose

This document describes a possible next evolution of `agent-voice-adapter` that is not tied to any
specific client integration.

Today, the application is centered around a turn model:

- a caller submits `POST /api/turn`
- the server selects an eligible client
- that client plays TTS
- the same turn may optionally continue into microphone capture and recognition
- the caller may wait for the listen result

That model is useful when some external caller needs a deterministic request/response boundary.

It is less ideal for clients that already own the interaction lifecycle themselves and only need:

- text-to-speech from backend models
- speech-to-text from backend models
- playback/capture control initiated entirely by the client

This document proposes a second, simpler operating mode for the application: `direct media mode`.

## Initial Delivery Scope

The initial direct-media rollout should be intentionally narrow:

- one native Android client
- direct TTS and direct STT only
- no browser direct-media client support yet
- no desktop direct-media client support yet
- existing `/api/turn` clients remain unchanged

This is not because the protocol must remain Android-specific long term. It is to keep the first
backend cut focused on the one client that actually needs the feature now.

## Current State

The current implementation exposes:

- HTTP turn APIs:
  - `POST /api/turn`
  - `POST /api/turn/cancel`
  - `POST /api/turn/stop-tts`
- websocket messages centered on `turn_*`
- queue semantics that hold work open across TTS and optional recognition
- client-side playback/capture ownership rules tied to a turn ID

This remains a good fit for:

- CLI usage
- external agents
- integrations where the caller must block on a spoken prompt and a recognized response

## Problem

Some clients do not need server-owned conversational turns.

Instead, they want the backend to behave more like a media service:

- client decides when to speak text
- client decides when to start microphone capture
- client decides where recognized text should go
- client may still want native playback/capture and backend-hosted models
- the agent or UI layer above the client does not need to know anything about turn orchestration

For those clients, the current turn model introduces extra coupling:

- every TTS request must be modeled as a turn
- every recognition flow must be modeled as post-turn listening
- stop/barge-in behavior is phrased as turn control instead of media control
- queue semantics and caller expectations are heavier than needed

## Recommendation

Keep the existing turn model intact.

Add a second API family for direct client-driven media operations.

This creates two valid operating modes:

1. `Turn mode`
   - existing behavior
   - optimized for external request/response flows

2. `Direct media mode`
   - new behavior
   - optimized for clients that already own the interaction lifecycle

The two modes should share the same underlying TTS and ASR provider implementations.

For the first implementation, direct media mode only needs to support a native Android client that:

- explicitly identifies itself as direct-media-capable
- explicitly targets itself for media requests
- owns higher-level interaction behavior locally

## What Needs To Change

### 1. Add a direct media API surface

The application needs a new API family that is not turn-centric.

At minimum, that means:

- start TTS for a client-owned request ID
- stream PCM audio for that request ID
- stop/cancel active TTS for that request ID
- start STT capture for a client-owned request ID
- accept streamed or blob audio for that request ID
- return a transcript or recognition failure for that request ID

Important: this still needs IDs for correlation, cancellation, and observability. The change is not
"no IDs"; it is "no server-owned conversational turn abstraction."

### 2. Introduce direct-media websocket messages

The current websocket protocol only knows about turn lifecycle messages.

Direct media mode needs parallel message types, for example:

- server to client:
  - `media_tts_start`
  - `media_tts_audio_chunk`
  - `media_tts_end`
  - `media_stt_started`
  - `media_stt_stopped`
  - `media_stt_result`
- client to server:
  - `media_stt_start`
  - `media_stt_chunk`
  - `media_stt_end`
  - optional `media_tts_terminal`

These should be distinct from `turn_*` messages rather than overloading the current protocol.

### 3. Separate turn orchestration from model execution

The current codebase combines:

- request validation
- queue semantics
- turn ownership
- playback/capture coordination
- provider invocation

Direct media mode will be much easier to add cleanly if the internals are split into clearer layers:

- TTS execution layer
  - sanitize text
  - invoke provider
  - stream PCM
- ASR execution layer
  - accept streamed/blob audio
  - manage endpointing / recognition
  - produce transcript/result
- orchestration layer
  - current turn queue behavior
  - future direct-media request tracking

The provider code already exists. The main work is reducing the amount of orchestration logic that
is hard-coded around turns.

### 4. Add a direct-media request registry

Turn mode uses queue items and turn IDs as the unit of state.

Direct media mode needs a separate registry for active media requests:

- active TTS requests by request ID
- active STT streams by request ID
- owning websocket for each request
- current phase for each request
- cancellation handles
- timestamps and metrics

This registry should be independent from the turn queue.

### 5. Define direct-media serialization rules

The current queue provides deterministic ordering across TTS and recognition.

Direct media mode needs a simpler concurrency policy. The server should explicitly define:

- whether one client may run multiple TTS requests concurrently
- whether STT requests must be single-active per client
- whether TTS and STT may overlap for the same client
- what happens on client disconnect
- whether stop is local to one request or all requests for a client

Recommendation:

- allow at most one active direct TTS request per client
- allow at most one active direct STT request per client
- reject conflicting new requests explicitly in the initial rollout
- do not introduce a global direct-media queue
- keep rules simple and observable

This matches the intended initial Android client model:

- one selected voice target in the app
- one active playback
- one active capture

### 6. Preserve compatibility with turn mode

The new mode should not break the existing one.

That means:

- keep `/api/turn` behavior stable
- keep `turn_*` websocket protocol stable
- keep existing CLI and Android/browser clients working
- avoid changing current queue semantics for callers that depend on them

Direct media mode should be additive.

### 7. Expand status and observability

Current `/api/status` is turn/queue oriented.

Direct media mode will need additional observability:

- active direct-media TTS requests
- active direct-media STT requests
- direct-media capable clients
- ownership and request counts by client
- stop/cancel/error counts
- provider timings by operation type

Logs should also distinguish clearly between:

- turn mode events
- direct media mode events

### 8. Clarify client capability advertisement

Current client state is phrased in terms of accepting turns, speech, listening, and in-turn state.

Direct media mode may need richer or more explicit capability/state fields, for example:

- supports turn mode
- supports direct TTS playback
- supports direct STT upload
- currently speaking
- currently capturing

This does not necessarily require removing the existing `client_state_update` shape, but it likely
requires extending it or defining a second capability message.

Initial recommendation:

- extend `client_state_update` rather than replace it
- add capability flags for direct TTS and direct STT
- allow the server to exclude direct-media-only clients from turn routing

### 9. Decide on ownership model

Turn mode currently has active-client semantics for routing.

Direct media mode needs a similarly explicit ownership model. Questions to settle:

- does every direct-media request name its intended client explicitly?
- does the server still route based on one active client?
- can multiple direct-media clients coexist if requests are client-scoped?

Recommendation:

- require explicit request ownership for direct-media operations whenever multiple clients may be
  connected
- keep the current active-client concept for turn mode
- do not rely on ambiguous implicit routing

For the initial rollout:

- direct-media requests should always target an explicit client ID
- direct-media requests should not use active-client routing
- turn mode should continue to use the current active-client rules

### 10. Reuse the current STT implementation, but de-turnify it

The current recognition path already supports:

- streamed PCM capture
- one-shot blob upload
- server-side endpointing
- final recognition results

That is valuable and should be reused.

The main refactor is to remove the assumption that recognition is always a continuation of a prior
TTS turn.

### 11. Reuse the current TTS implementation, but de-turnify it

The current TTS path already supports:

- model/voice selection
- text sanitization
- streaming PCM output
- stop/cancel behavior

That should also be reused.

The main refactor is to support a request that means only:

- "speak this text"

rather than:

- "create a conversational turn that may later become a recognition flow"

## Suggested API Direction

The exact route names are still open, but the backend should add something like:

- `POST /api/media/tts`
- `POST /api/media/tts/stop`
- `POST /api/media/stt` for blob upload
- `GET /api/media/status` or extend `/api/status`
- websocket `media_tts_*`
- websocket `media_stt_*`

Possible client-side STT protocol:

- `media_stt_start`
- `media_stt_chunk`
- `media_stt_end`
- `media_stt_result`

Possible server-side TTS protocol:

- `media_tts_start`
- `media_tts_audio_chunk`
- `media_tts_end`

The exact naming is less important than keeping it clearly separate from `turn_*`.

## Implementation Order

### Phase 1: Internal refactor

- isolate provider-facing TTS and ASR execution from turn orchestration
- add reusable execution helpers for direct request IDs
- keep behavior unchanged externally

### Phase 2: Client identity and capability groundwork

- extend websocket client capability/state advertisement
- add explicit client identity for direct-media targeting
- ensure `/api/turn` excludes direct-media-only clients

### Phase 3: Direct TTS

- add direct TTS request lifecycle
- add direct TTS websocket stream messages
- add stop/cancel handling

### Phase 4: Direct STT

- add direct STT request lifecycle
- accept streamed/blob audio without prior turn creation
- emit transcript results independent of turn state

### Phase 5: Status, logging, and hardening

- add status/metrics for direct media requests
- harden disconnect/cancel semantics

### Phase 6: Documentation and client rollout

- document dual-mode behavior
- publish protocol examples
- adopt first in the native Android client only

## Concrete Backend Plan

The first backend implementation should do the minimum needed to unblock a native Android client.

### Step 1: Add capability-aware client registration

- extend websocket state so clients can advertise:
  - `supportsTurnMode`
  - `supportsDirectTts`
  - `supportsDirectStt`
- keep existing turn clients working if they do not send new fields
- ensure turn routing only considers turn-capable clients

### Step 2: Add explicit direct-media client targeting

- give each websocket client a stable server-side client identity
- expose that identity to the client
- require direct-media requests to target that identity explicitly

### Step 3: Add direct TTS endpoints and events

- `POST /api/media/tts`
- `POST /api/media/tts/stop`
- websocket:
  - `media_tts_start`
  - `media_tts_audio_chunk`
  - `media_tts_end`

### Step 4: Add direct STT endpoints and events

- websocket:
  - `media_stt_start`
  - `media_stt_chunk`
  - `media_stt_end`
  - `media_stt_result`
- HTTP fallback:
  - `POST /api/media/stt`

### Step 5: Add request tracking

- active direct TTS request by request ID
- active direct STT request by request ID
- owning websocket and client ID
- cancellation handles
- request timestamps for status/logging

### Step 6: Add direct-media observability

- extend `/api/status` or add `/api/media/status`
- expose:
  - direct-media-capable client counts
  - active direct TTS request counts
  - active direct STT request counts
  - active requests by client ID

### Step 7: Keep scope narrow

- do not add browser direct-media support yet
- do not add desktop direct-media support yet
- do not redesign `/api/turn`
- do not add a global direct-media queue

## Open Questions

- Should direct TTS start over HTTP and stream over websocket, or be websocket-only?
- Should direct STT be websocket-only, or also support HTTP blob uploads?
- Should direct-media requests be scoped to a specific websocket client ID?
- Should queueing exist at all for direct media mode, or only per-client conflict rules?
- How much of the current `client_state_update` contract should be reused versus replaced?

## Summary

`agent-voice-adapter` should remain a turn-capable system, but it should also grow a second mode
that exposes its TTS and STT capabilities directly to clients that do not need conversational turn
orchestration.

The major work is not in the providers themselves. The major work is:

- decoupling model execution from turn orchestration
- defining a clean direct-media protocol
- tracking request ownership and lifecycle independently from the turn queue
- preserving backward compatibility for the current turn-driven clients
