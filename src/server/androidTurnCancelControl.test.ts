import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android turn cancel control", () => {
  test("wires active-turn bubble outline and menu in MainActivity", () => {
    const activityKt = readAndroidFile("java/com/agentvoiceadapter/android/MainActivity.kt");

    expect(activityKt).toContain("turnId: String");
    expect(activityKt).toContain("updateActiveTurnBubbleOutline()");
    expect(activityKt).toContain("activeBubbleStaticStrokeWidthPx()");
    expect(activityKt).toContain("activeBubblePulseMaxStrokeWidthPx()");
    expect(activityKt).toContain("bubblePulseMinAlphaFraction");
    expect(activityKt).toContain("currentTheme.bubbleActiveBorder");
    expect(activityKt).toContain("handleBubblePrimaryAction(turnId = model.turnId)");
    expect(activityKt).toContain("showBubbleMenu(anchor = bubble, turnId = model.turnId)");
    expect(activityKt).toContain('menu.menu.add(0, 1, 0, "Stop TTS")');
    expect(activityKt).toContain('menu.menu.add(0, 2, 1, "Cancel turn")');
    expect(activityKt).toContain("when (runtimeStatusState.audio.lowercase())");
    expect(activityKt).toContain('"playback" -> requestTurnStopTts(turnId)');
    expect(activityKt).toContain('"capture" ->');
    expect(activityKt).toContain("showTurnCancelConfirmationDialog(");
    expect(activityKt).toContain('title = "Cancel Turn"');
    expect(activityKt).toContain('title = "Cancel Recognition"');
    expect(activityKt).toContain('setPositiveButton("Yes")');
    expect(activityKt).toContain('setNegativeButton("No", null)');
    expect(activityKt).toContain("requestTurnCancel(turnId)");
    expect(activityKt).toContain("requestTurnStopTts(turnId)");
  });

  test("wires service-side stop-tts/cancel actions and API calls", () => {
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(serviceKt).toContain("ACTION_ABORT_TURN");
    expect(serviceKt).toContain("ACTION_STOP_TTS");
    expect(serviceKt).toContain("fun abortTurnIntent");
    expect(serviceKt).toContain("fun stopTtsIntent");
    expect(serviceKt).toContain("requestTurnStopTts(");
    expect(serviceKt).toContain("postTurnStopTts(");
    expect(serviceKt).toContain("requestTurnAbort(");
    expect(serviceKt).toContain(
      'forceLocalPlaybackCancel(turnId = turnId, reason = "local_stop_tts")',
    );
    expect(serviceKt).toContain(
      'forceLocalPlaybackCancel(turnId = turnId, reason = "local_cancel")',
    );
    expect(serviceKt).toContain(
      "private fun forceLocalPlaybackCancel(turnId: String, reason: String): Boolean",
    );
    expect(serviceKt).toContain("private val locallyCanceledTurnIds = mutableSetOf<String>()");
    expect(serviceKt).toContain(
      "private fun cancellationReasonFromListenResult(payload: JSONObject, rawError: String): String?",
    );
    expect(serviceKt).toContain("locallyCanceledTurnIds.add(turnId)");
    expect(serviceKt).toContain('emitEvent(EVENT_TYPE_STATUS, "Voice to Agent canceled.")');
    expect(serviceKt).toContain('emitEvent(EVENT_TYPE_STATUS, "Recognition canceled.")');
    expect(serviceKt).toContain('payload.optBoolean("canceled", false)');
    expect(serviceKt).toContain('payload.optString("cancelReason", "").trim()');
    expect(serviceKt).toContain("postTurnCancel(");
    expect(serviceKt).toContain("UrlUtils.turnStopTtsUrl");
    expect(serviceKt).toContain("UrlUtils.turnCancelUrl");
  });

  test("url utils expose turn stop/cancel endpoint helpers", () => {
    const urlUtilsKt = readAndroidFile("java/com/agentvoiceadapter/android/UrlUtils.kt");

    expect(urlUtilsKt).toContain("fun turnCancelUrl(baseUrl: String): String");
    expect(urlUtilsKt).toContain("api/turn/cancel");
    expect(urlUtilsKt).toContain("fun turnStopTtsUrl(baseUrl: String): String");
    expect(urlUtilsKt).toContain("api/turn/stop-tts");
  });
});
