import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android loopback control", () => {
  test("renders loopback and cue-test buttons in activity layout", () => {
    const layoutXml = readAndroidFile("res/layout/activity_main.xml");

    expect(layoutXml).toContain('android:id="@+id/loopback_test_button"');
    expect(layoutXml).toContain('android:text="Loopback"');
    expect(layoutXml).toContain('android:id="@+id/test_cue_button"');
    expect(layoutXml).toContain('android:text="Test Cue"');
  });

  test("wires loopback and cue-test buttons to service intents", () => {
    const activityKt = readAndroidFile("java/com/agentvoiceadapter/android/MainActivity.kt");

    expect(activityKt).toContain("loopbackTestButton");
    expect(activityKt).toContain("submitLoopbackTest");
    expect(activityKt).toContain("VoiceAdapterService.loopbackIntent(this, config)");
    expect(activityKt).toContain("testCueButton");
    expect(activityKt).toContain("submitCueTest");
    expect(activityKt).toContain("VoiceAdapterService.testCueIntent(this, config)");
  });

  test("service loopback and cue actions are wired", () => {
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(serviceKt).toContain("ACTION_LOOPBACK");
    expect(serviceKt).toContain("ACTION_TEST_CUE");
    expect(serviceKt).toContain("submitLoopbackTurn");
    expect(serviceKt).toContain("playManualCue()");
    expect(serviceKt).toContain(
      "fun testCueIntent(context: Context, config: AdapterRuntimeConfig)",
    );
    expect(serviceKt).toContain("UrlUtils.turnUrl(runtimeConfig.apiBaseUrl)");
    expect(serviceKt).toContain('.put("listen", true)');
    expect(serviceKt).toContain("loopbackPromptText");
    expect(serviceKt).toContain(".readTimeout(5, TimeUnit.MINUTES)");
    expect(serviceKt).toContain("playRecognitionCueWithRetry(success, attempt = 0)");
    expect(serviceKt).toContain("val played = player.playCueProbe(success)");
    expect(serviceKt).toContain("Recognition cue unavailable: playback focus denied.");
  });
});
