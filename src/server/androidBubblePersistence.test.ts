import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android bubble persistence", () => {
  test("renders settings inside a collapsible section that is hidden by default", () => {
    const layoutXml = readAndroidFile("res/layout/activity_main.xml");

    expect(layoutXml).toContain('android:id="@+id/settings_toggle_button"');
    expect(layoutXml).toContain('android:id="@+id/settings_section"');
    expect(layoutXml).toContain('android:visibility="gone"');
    expect(layoutXml).toMatch(
      /android:id="@\+id\/settings_section"[\s\S]*?android:id="@\+id\/hint_text"[\s\S]*?android:id="@\+id\/mic_route_text"/,
    );
  });

  test("adds a clear responses button in activity layout", () => {
    const layoutXml = readAndroidFile("res/layout/activity_main.xml");

    expect(layoutXml).toContain('android:text="Agent Voice Adapter"');
    expect(layoutXml).not.toContain('android:text="Agent Voice Adapter (Android)"');
    expect(layoutXml).toContain('android:id="@+id/clear_chat_button"');
    expect(layoutXml).toContain('android:text="Clear Responses"');
    expect(layoutXml).toContain('android:id="@+id/chat_scroll_view"');
    expect(layoutXml).toMatch(
      /android:id="@\+id\/settings_section"[\s\S]*?android:id="@\+id\/clear_chat_button"/,
    );
  });

  test("persists bubbles in the service before broadcasting events", () => {
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(serviceKt).toContain("if (eventType == EVENT_TYPE_BUBBLE)");
    expect(serviceKt).toContain("BubbleHistoryStore.append(this, message)");
    expect(serviceKt).toContain("private fun emitBubble(");
    expect(serviceKt).toContain("linkedSessionId: String? = null");
    expect(serviceKt).toContain("linkedSessionTitle: String? = null");
    expect(serviceKt).toContain('payload.put("noWait", true)');
    expect(serviceKt).toContain("linkedSessionIdByTurnId[turnId]");
    expect(serviceKt).toContain("linkedSessionTitleByTurnId[turnId]");
    expect(serviceKt).toContain("EVENT_TYPE_LISTENING_STATE");
    expect(serviceKt).toContain('emitEvent(EVENT_TYPE_LISTENING_STATE, "active")');
    expect(serviceKt).toContain('emitEvent(EVENT_TYPE_LISTENING_STATE, "inactive")');
  });

  test("restores persisted bubbles, supports clear, and auto-scrolls to latest", () => {
    const activityKt = readAndroidFile("java/com/agentvoiceadapter/android/MainActivity.kt");

    expect(activityKt).toContain("BubbleHistoryStore.readAll(this)");
    expect(activityKt).toContain("BubbleHistoryStore.clear(this)");
    expect(activityKt).toContain("chatScrollView.fullScroll(View.FOCUS_DOWN)");
    expect(activityKt).toContain("BubbleHistoryStore.MAX_BUBBLES");
    expect(activityKt).toContain("setSettingsExpanded");
    expect(activityKt).toContain("loadSettingsExpandedPreference");
    expect(activityKt).toContain("private data class BubbleRenderModel");
    expect(activityKt).toContain('if (parsed != null && parsed.optString("kind", "") == "bubble")');
    expect(activityKt).toContain("BubbleFillColorResolver.resolve(");
    expect(activityKt).toContain("assistantColor = currentTheme.bubbleAssistant");
    expect(activityKt).toContain("assistantNoWaitColor = currentTheme.bubbleAssistantNoWait");
  });

  test("caps persisted bubble history to one hundred entries", () => {
    const storeKt = readAndroidFile("java/com/agentvoiceadapter/android/BubbleHistoryStore.kt");

    expect(storeKt).toContain("const val MAX_BUBBLES = 100");
    expect(storeKt).toContain("takeLast(MAX_BUBBLES)");
  });

  test("shows recognition-active indicator below chat and toggles from listening-state events", () => {
    const layoutXml = readAndroidFile("res/layout/activity_main.xml");
    const activityKt = readAndroidFile("java/com/agentvoiceadapter/android/MainActivity.kt");

    expect(layoutXml).toContain('android:id="@+id/recognition_indicator_text"');
    expect(layoutXml).toContain('android:visibility="gone"');
    expect(activityKt).toContain("VoiceAdapterService.EVENT_TYPE_LISTENING_STATE");
    expect(activityKt).toContain("setRecognitionIndicator");
    expect(activityKt).toContain('state.equals("active", ignoreCase = true)');
    expect(activityKt).toContain("if (active) {");
    expect(activityKt).toContain("scrollToLatestBubble()");
  });
});
