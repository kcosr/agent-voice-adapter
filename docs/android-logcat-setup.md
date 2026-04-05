# Android Logcat Setup (Wireless ADB)

This guide documents how to capture Android logs for `agent-voice-adapter` from a Linux shell without Android Studio UI.

## Prerequisites

- `adb` installed and on `PATH`
- Phone and Linux host on the same network
- Phone developer options enabled
- Phone wireless debugging enabled

## Pair Linux Host to Phone

On phone:

1. Open `Developer options` -> `Wireless debugging`.
2. Tap `Pair device with pairing code`.
3. Note the pairing `IP:port` and six-digit pairing code.

On Linux:

```bash
adb pair <PHONE_IP>:<PAIR_PORT>
```

Enter the six-digit code when prompted.

Example:

```bash
adb pair 192.168.50.155:33769
```

## Connect for Debugging

On phone wireless debugging screen, get the regular debug endpoint (`IP address & port`), then:

```bash
adb connect <PHONE_IP>:<DEBUG_PORT>
adb devices -l
```

Example:

```bash
adb connect 192.168.50.155:34247
adb devices -l
```

## Capture Focused Logs for Cue/Media Issues

Use a focused filter while reproducing the issue:

```bash
adb logcat -v time | rg "VoiceAdapterService|ExternalMediaController|cue_state|media_ctrl|AudioTrack|AudioManager"
```

For a clean repro window:

```bash
adb logcat -c
adb logcat -v time | rg "cue_state|media_ctrl|AudioTrack|AudioManager"
```

## Useful Notes

- No GUI is required for pairing/connection; command line pairing uses the six-digit code flow.
- QR pairing is optional and not required for CLI workflows.
- Pairing ports are temporary, and debug connect ports may change after wireless-debugging restarts, reboots, or network changes.
- If multiple transports are shown in `adb devices -l`, target one explicitly:

```bash
adb -s <SERIAL> logcat
```

## Local Device Naming (This Workspace)

For local debugging conversations, use these friendly names:

- `Pixel 9 WiFi` -> `192.168.50.227:36107` (mDNS: `adb-4A221FDAQ0008E-7re2Fy._adb-tls-connect._tcp`)
- `Pixel 9` -> `192.168.50.155:34247` (mDNS: `adb-54280DLAQ000T0-TPCOSU._adb-tls-connect._tcp`)

You can always refresh current endpoints with:

```bash
adb devices -l
```
