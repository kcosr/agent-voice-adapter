import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android external media control", () => {
  test("uses retry-based pause/resume dispatch with playback-drain end scheduling", () => {
    const controllerKt = readAndroidFile(
      "java/com/agentvoiceadapter/android/ExternalMediaController.kt",
    );
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(controllerKt).toContain("startedWithActiveMedia");
    expect(controllerKt).toContain("pauseDispatched");
    expect(controllerKt).toContain("media_ctrl_begin");
    expect(controllerKt).toContain("media_ctrl_pause_attempt");
    expect(controllerKt).toContain("media_ctrl_end");
    expect(controllerKt).toContain("media_ctrl_play_attempt");
    expect(controllerKt).toContain("isMusicActiveAtStart=");
    expect(controllerKt).toContain("startedWithActiveMedia = activeAtStart");
    expect(controllerKt).toContain("pauseDispatched = true");
    expect(controllerKt).toContain("MAX_PAUSE_ATTEMPTS = 3");
    expect(controllerKt).toContain("attempt=$attempt/$MAX_PAUSE_ATTEMPTS");
    expect(controllerKt).toContain("shouldAttemptResume =");
    expect(controllerKt).toContain(
      "startedWithActiveMedia && pauseDispatched && (pausedByUs || !isMusicActiveAtEndStart)",
    );
    expect(controllerKt).toContain("dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_PLAY)");
    expect(controllerKt).toContain("MAX_PLAY_ATTEMPTS = 3");
    expect(controllerKt).toContain("attempt=$attempt/$MAX_PLAY_ATTEMPTS activeBefore=");
    expect(controllerKt).toContain("val resumedFromInactive = !activeBefore && activeAfter");
    expect(controllerKt).toContain("startedWithActiveMedia = false");
    expect(controllerKt).toContain("pauseDispatched = false");
    expect(serviceKt).toContain("scheduleExternalMediaEndAfterPlayback(turnId)");
    expect(serviceKt).toContain("player.estimatedPlaybackRemainingMs()");
    expect(serviceKt).toContain("player.onPlaybackDrained");
    expect(serviceKt).toContain("media_pause_end_schedule");
    expect(serviceKt).toContain(
      "val nextAudioState = if (activeTurnCaptureId != null || activeAgentCaptureId != null)",
    );
    expect(serviceKt).toContain("audioState = nextAudioState");
  });
});
