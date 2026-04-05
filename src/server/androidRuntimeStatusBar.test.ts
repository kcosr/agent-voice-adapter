import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android runtime status bar", () => {
  test("renders status bar controls and chips in activity layout", () => {
    const layoutXml = readAndroidFile("res/layout/activity_main.xml");

    expect(layoutXml).toContain('android:id="@+id/status_bar_switch"');
    expect(layoutXml).toContain('android:text="Show status bar"');
    expect(layoutXml).toContain('android:id="@+id/status_bar_container"');
    expect(layoutXml).toContain('android:id="@+id/status_chip_ws"');
    expect(layoutXml).toContain('android:id="@+id/status_chip_audio"');
    expect(layoutXml).toContain('android:id="@+id/status_chip_media"');
    expect(layoutXml).toContain('android:id="@+id/status_chip_music"');
  });

  test("main activity persists status bar visibility and handles runtime state events", () => {
    const activityKt = readAndroidFile("java/com/agentvoiceadapter/android/MainActivity.kt");

    expect(activityKt).toContain("statusBarVisiblePrefsKey");
    expect(activityKt).toContain("showStatusBarSwitch");
    expect(activityKt).toContain("setStatusBarVisible(");
    expect(activityKt).toContain("loadStatusBarVisiblePreference()");
    expect(activityKt).toContain("VoiceAdapterService.EVENT_TYPE_RUNTIME_STATE");
    expect(activityKt).toContain("parseRuntimeStatusState(");
    expect(activityKt).toContain("renderRuntimeStatusBar()");
    expect(activityKt).toContain('payload.optString("music", runtimeStatusState.music)');
    expect(activityKt).toContain('"pause_pending" -> "Pausing"');
    expect(activityKt).toContain('"start_active" -> "Start active"');
    expect(activityKt).toContain('"end_inactive" -> "End inactive"');
    expect(activityKt).toContain('renderStatusChip(statusChipMusicText, "Music"');
  });

  test("voice adapter service emits structured runtime state updates", () => {
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(serviceKt).toContain("EVENT_TYPE_RUNTIME_STATE");
    expect(serviceKt).toContain("updateRuntimeState(");
    expect(serviceKt).toContain("emitRuntimeState(");
    expect(serviceKt).toContain('.put("ws", runtimeWsState)');
    expect(serviceKt).toContain('.put("audio", runtimeAudioState)');
    expect(serviceKt).toContain('.put("media", runtimeMediaState)');
    expect(serviceKt).toContain('.put("music", runtimeMusicState)');
    expect(serviceKt).toContain('.put("turnId", activeTurnId)');
    expect(serviceKt).toContain("mediaPauseExecutor");
    expect(serviceKt).toContain(
      'updateRuntimeState(mediaState = "pause_pending", turnId = turnId)',
    );
    expect(serviceKt).toContain(
      'val startMusicState = if (begin.isMusicActiveAtStart) "start_active" else "start_inactive"',
    );
    expect(serviceKt).toContain(
      'musicState = if (end.isMusicActiveAtEnd) "end_active" else "end_inactive"',
    );
  });
});
