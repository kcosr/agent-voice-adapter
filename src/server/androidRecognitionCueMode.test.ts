import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android recognition cue mode setting", () => {
  test("renders cue mode selector in settings", () => {
    const layoutXml = readAndroidFile("res/layout/activity_main.xml");

    expect(layoutXml).toContain("Recognition cue mode");
    expect(layoutXml).toContain('android:id="@+id/recognition_cue_mode_spinner"');
  });

  test("persists cue mode in adapter prefs and defaults", () => {
    const configKt = readAndroidFile("java/com/agentvoiceadapter/android/AdapterConfig.kt");

    expect(configKt).toContain("object RecognitionCueModes");
    expect(configKt).toContain('const val OFF = "off"');
    expect(configKt).toContain('const val ALWAYS = "always"');
    expect(configKt).toContain('const val MEDIA_INACTIVE_ONLY = "media_inactive_only"');
    expect(configKt).toContain(
      "const val RECOGNITION_CUE_MODE = RecognitionCueModes.MEDIA_INACTIVE_ONLY",
    );
    expect(configKt).toContain(
      'private const val KEY_RECOGNITION_CUE_MODE = "recognition_cue_mode"',
    );
    expect(configKt).toContain(
      ".putString(KEY_RECOGNITION_CUE_MODE, RecognitionCueModes.normalize(config.recognitionCueMode))",
    );
  });

  test("wires cue mode through activity and service runtime logic", () => {
    const activityKt = readAndroidFile("java/com/agentvoiceadapter/android/MainActivity.kt");
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(activityKt).toContain("recognitionCueModeSpinner");
    expect(activityKt).toContain("setupRecognitionCueModeSpinner(saved.recognitionCueMode)");
    expect(activityKt).toContain(
      "recognitionCueMode = RecognitionCueModes.normalize(selectedCueMode)",
    );
    expect(serviceKt).toContain(
      'private const val EXTRA_RECOGNITION_CUE_MODE = "recognition_cue_mode"',
    );
    expect(serviceKt).toContain("putExtra(EXTRA_RECOGNITION_CUE_MODE, config.recognitionCueMode)");
    expect(serviceKt).toContain("recognitionCueMode = RecognitionCueModes.normalize(");
    expect(serviceKt).toContain(
      "val cueMode = RecognitionCueModes.normalize(runtimeConfig.recognitionCueMode)",
    );
    expect(serviceKt).toContain("private fun handleRecognitionCompletionCue(");
    expect(serviceKt).toContain(
      "stopActiveAgentCapture(playCompletionCue = false, awaitResult = true)",
    );
    expect(serviceKt).toContain('else -> "cue_mode_media_inactive_only"');
    expect(serviceKt).toContain('"cue_state play_skip turnId=$turnId reason=$reason"');
  });
});
