import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android recognition cue gain setting", () => {
  test("renders recognition cue gain controls in settings", () => {
    const layoutXml = readAndroidFile("res/layout/activity_main.xml");

    expect(layoutXml).toContain('android:id="@+id/recognition_cue_gain_slider"');
    expect(layoutXml).toContain('android:id="@+id/recognition_cue_gain_value_text"');
    expect(layoutXml).toContain("Recognition cue gain: 100%");
  });

  test("persists cue gain and wires it through activity and service", () => {
    const configKt = readAndroidFile("java/com/agentvoiceadapter/android/AdapterConfig.kt");
    const activityKt = readAndroidFile("java/com/agentvoiceadapter/android/MainActivity.kt");
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(configKt).toContain("const val RECOGNITION_CUE_GAIN = 1.0f");
    expect(configKt).toContain(
      'private const val KEY_RECOGNITION_CUE_GAIN = "recognition_cue_gain"',
    );
    expect(configKt).toContain(
      ".putFloat(KEY_RECOGNITION_CUE_GAIN, config.recognitionCueGain.coerceIn(0.25f, 5.0f))",
    );
    expect(activityKt).toContain("recognitionCueGainSlider");
    expect(activityKt).toContain("setRecognitionCueGainLabel");
    expect(activityKt).toContain(
      "recognitionCueGain = (recognitionCueGainSlider.progress.coerceIn(25, 500) / 100f)",
    );
    expect(serviceKt).toContain(
      'private const val EXTRA_RECOGNITION_CUE_GAIN = "recognition_cue_gain"',
    );
    expect(serviceKt).toContain("putExtra(EXTRA_RECOGNITION_CUE_GAIN, config.recognitionCueGain)");
    expect(serviceKt).toContain("player.setRecognitionCueGain(config.recognitionCueGain)");
  });
});
