import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android quick reply control", () => {
  test("wires quick-reply service action and websocket payload", () => {
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(serviceKt).toContain("ACTION_SEND_QUICK_REPLY");
    expect(serviceKt).toContain("EXTRA_QUICK_REPLY_TURN_ID");
    expect(serviceKt).toContain("EXTRA_QUICK_REPLY_TEXT");
    expect(serviceKt).toContain("fun quickReplyIntent(");
    expect(serviceKt).toContain("requestTurnQuickReply(");
    expect(serviceKt).toContain("quickReplyCaptureSuppressedTurnIds.add(turnId)");
    expect(serviceKt).toContain(
      "cue_state listen_capture_skip_after_drain turnId=$turnId reason=quick_reply_selected",
    );
    expect(serviceKt).toContain(
      'forceLocalPlaybackCancel(turnId = turnId, reason = "local_quick_reply")',
    );
    expect(serviceKt).toContain('.put("type", "turn_listen_quick_reply")');
    expect(serviceKt).toContain('.put("text", text)');
    expect(serviceKt).toContain('message.put("quickReplyId", normalizedQuickReplyId)');
    expect(serviceKt).toContain('normalizedQuickReply.put("defaultResume", true)');
  });

  test("forwards turn_start quick replies into bubble payload and renders controls", () => {
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");
    const activityKt = readAndroidFile("java/com/agentvoiceadapter/android/MainActivity.kt");

    expect(serviceKt).toContain('val quickReplies = payload.optJSONArray("quickReplies")');
    expect(serviceKt).toContain("quickReplies = quickReplies");
    expect(serviceKt).toContain('payload.put("quickReplies", normalizedQuickReplies)');

    expect(activityKt).toContain("private data class BubbleQuickReply(");
    expect(activityKt).toContain("val quickReplies: List<BubbleQuickReply>");
    expect(activityKt).toContain('parseBubbleQuickReplies(parsed.opt("quickReplies"))');
    expect(activityKt).toContain("buildBubbleQuickReplyRow(model)");
    expect(activityKt).toContain("topMargin = (12 * density).toInt()");
    expect(activityKt).toContain("val hasSingleDefaultResume = model.quickReplies.size == 1");
    expect(activityKt).toContain(
      "gravity = if (hasSingleDefaultResume) Gravity.END else Gravity.START",
    );
    expect(activityKt).toContain("isFillViewport = hasSingleDefaultResume");
    expect(activityKt).toContain("private fun setBubbleQuickReplyButtonsEnabled(");
    expect(activityKt).toContain("private fun markBubbleQuickReplyConsumed(turnId: String)");
    expect(activityKt).toContain("setBubbleQuickReplyButtonsEnabled(bubble, quickRepliesEnabled)");
    expect(activityKt).toContain("allowInactiveQuickReply = allowInactiveQuickReply");
    expect(activityKt).toContain("markBubbleQuickReplyConsumed(model.turnId)");
    expect(activityKt).toContain('defaultResume = item.optBoolean("defaultResume", false)');
    expect(activityKt).toContain("VoiceAdapterService.quickReplyIntent(");
  });
});
