# Android App

Native Android client for `agent-voice-adapter` with:

- foreground service for background execution
- foreground service startup tied to saved `Run foreground service` toggle (default ON on first launch)
- WebSocket protocol client (`/ws`)
- streamed PCM playback plus streamed microphone capture for `listen=true` turns
- optional ambient wake capture loop (`agent`/`assistant` wake match -> `/api/wake-intent`)
- phase-aware assistant bubble actions:
  - single tap during TTS -> `Stop TTS`
  - single tap during recognition -> `Cancel turn`
  - long-press -> action menu with both options
- active-client ownership controls for multi-client routing (`client_activate`/`client_deactivate`) with reconnect-time reactivation while local ownership intent remains set
- optional continuous speech-focus reservation mode across TTS -> recognition
- optional external media pause/resume control for turn windows (with playback-drain aligned resume for no-listen turns)
- recognition cue mode selector (`Only when media inactive` / `Always` / `Off`)
- adjustable in-app TTS gain control (independent of system media volume)
- selectable microphone input device in UI
- active mic-route status reporting
- in-app response bubbles for turn/listen events with persisted history and `Clear Responses`
- role-oriented chat bubbles (`Assistant` / `You` / `System`) with no-wait visual distinction
- cue playback via media-path probe + Android notification-sound wake cues
- in-app `Agent Sessions` dialog (`/api/session-dispatch/sessions` + `/api/session-dispatch/send`)
- in-app server settings panel (`/api/server-settings`)
- battery-optimization exemption request flow and quick access to background reliability settings
- foreground notification tap opens the app (`MainActivity`)
- TLS trust anchored to Android system and user CA stores (for private/local cert deployments)

Default API base URL:

- `http://10.0.2.2:4300` — the Android emulator's loopback to your development host on port `4300`. Change it via the **API URL** field in the in-app settings panel when running on a physical device or a different server.

## Build

No system `gradle` install is required; use the checked-in wrapper:

```bash
cd android
./gradlew :app:assembleDebug
```

Debug APK:

```bash
app/build/outputs/apk/debug/app-debug.apk
```

Install to device:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Use Android Studio to open `android/` for development/debugging.

Local debug versioning:

- `versionCode` auto-increments for `installDebug`/`assembleDebug` style tasks.
- Counter file: `android/local-version-code.txt` (created automatically, git-ignored).
- Verify installed build metadata with:

```bash
adb -s "<SERIAL>" shell dumpsys package com.agentvoiceadapter.android | rg "versionCode=|versionName=|lastUpdateTime="
```

For full runtime behavior and state-machine details:

- [Android Client section in README](../README.md#android-client)
- `docs/android-architecture.md`
