import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android turn-start capture barrier", () => {
  test("service synchronizes turn_start dispatch and enforces capture teardown before playback", () => {
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(serviceKt).toContain('if (type == "turn_start")');
    expect(serviceKt).toContain("runOnMainAndWait(TURN_START_MAIN_SYNC_TIMEOUT_MS)");
    expect(serviceKt).toContain("private fun prepareForIncomingTurnPlayback(turnId: String)");
    expect(serviceKt).toContain("turn_start_capture_barrier");
    expect(serviceKt).toContain(
      "stopActiveAgentCapture(playCompletionCue = false, awaitResult = false, restartAmbient = false)",
    );
    expect(serviceKt).toContain("player.endRecognitionCaptureFocus()");
  });

  test("defers listen capture start until local playback drain after turn_tts_end", () => {
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(serviceKt).toContain("scheduleTurnCaptureAfterPlaybackDrain(turnId)");
    expect(serviceKt).toContain(
      "private fun scheduleTurnCaptureAfterPlaybackDrain(turnId: String)",
    );
    expect(serviceKt).toContain("cue_state listen_capture_schedule_after_drain");
    expect(serviceKt).toContain("cue_state listen_capture_start_after_drain");
    expect(serviceKt).toContain("player.onPlaybackDrained");
  });
});
