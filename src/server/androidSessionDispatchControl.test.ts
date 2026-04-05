import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android session dispatch control", () => {
  test("renders agent sessions button and dialog controls", () => {
    const mainLayoutXml = readAndroidFile("res/layout/activity_main.xml");
    const dialogLayoutXml = readAndroidFile("res/layout/dialog_session_dispatch.xml");
    const rowLayoutXml = readAndroidFile("res/layout/item_session_dispatch_row.xml");
    const rowSelectorXml = readAndroidFile("res/drawable/session_dispatch_row_selector.xml");

    expect(mainLayoutXml).toContain('android:id="@+id/agent_sessions_button"');
    expect(mainLayoutXml).toContain('android:text="Agent Sessions"');
    expect(mainLayoutXml).toContain('android:id="@+id/voice_to_agent_button"');
    expect(mainLayoutXml).toContain('android:id="@+id/send_to_agent_button"');
    expect(mainLayoutXml).toContain('android:src="@drawable/ic_send_24"');
    expect(mainLayoutXml).toContain('android:src="@drawable/ic_chat_bubble_outline_24"');
    expect(mainLayoutXml).toContain('android:id="@+id/active_agent_status_text"');
    expect(mainLayoutXml).toContain('android:id="@+id/theme_spinner"');

    expect(dialogLayoutXml).toContain('android:id="@+id/session_dispatch_filter_input"');
    expect(dialogLayoutXml).toContain('android:hint="Filter by workspace or resolved title"');
    expect(dialogLayoutXml).toContain('android:id="@+id/session_dispatch_list"');
    expect(dialogLayoutXml).toContain('android:id="@+id/session_dispatch_custom_message_input"');
    expect(dialogLayoutXml).toContain('android:hint="Message to selected session"');
    expect(dialogLayoutXml).toContain('android:id="@+id/session_dispatch_close_button"');
    expect(dialogLayoutXml).toContain('android:background="@drawable/bg_card"');
    expect(dialogLayoutXml).toContain('android:id="@+id/session_dispatch_send_button"');
    expect(dialogLayoutXml).toContain('android:layout_weight="1"');
    expect(dialogLayoutXml).not.toContain('android:id="@+id/session_dispatch_set_active_button"');
    expect(dialogLayoutXml).not.toContain("Make Active Agent");
    expect(dialogLayoutXml).not.toContain('android:id="@+id/session_dispatch_mode_spinner"');
    expect(rowLayoutXml).toContain('android:id="@android:id/text1"');
    expect(rowLayoutXml).toContain("<TextView");
    expect(rowLayoutXml).toContain('android:id="@+id/session_dispatch_row_voice_button"');
    expect(rowLayoutXml).toContain('android:id="@+id/session_dispatch_row_send_button"');
    expect(rowLayoutXml).toContain('android:src="@drawable/ic_send_24"');
    expect(rowLayoutXml).toContain('android:src="@drawable/ic_chat_bubble_outline_24"');
    expect(rowLayoutXml).toContain('android:singleLine="false"');
    expect(rowLayoutXml).not.toContain("listChoiceIndicatorSingle");
    expect(rowLayoutXml).toContain('android:background="@drawable/session_dispatch_row_selector"');
    expect(rowSelectorXml).toContain('android:state_activated="true"');
    expect(rowSelectorXml).toContain('android:color="@color/surface"');
  });

  test("main activity wires session dispatch dialog, filtering, and send flow", () => {
    const activityKt = readAndroidFile("java/com/agentvoiceadapter/android/MainActivity.kt");

    expect(activityKt).toContain("agentSessionsButton");
    expect(activityKt).toContain("currentTheme = AppTheme.resolve(this)");
    expect(activityKt).toContain("themeSpinner");
    expect(activityKt).toContain("setupThemeSpinner()");
    expect(activityKt).toContain("applyTheme()");
    expect(activityKt).toContain("openSessionDispatchDialog()");
    expect(activityKt).toContain("fetchSessionDispatchSessions(");
    expect(activityKt).toContain("parseSessionDispatchRows(");
    expect(activityKt).toContain("sendSessionDispatchMessage(");
    expect(activityKt).toContain("startVoiceCaptureForSession(");
    expect(activityKt).toContain("startVoiceCaptureForSession(row, sendVerbatim = true)");
    expect(activityKt).toContain("buildSessionDispatchCustomMessage(");
    expect(activityKt).toContain("sessionDispatchVoiceInstruction");
    expect(activityKt).toContain(
      '"$normalizedWorkspace, ${normalizedTitle.ifEmpty { "(no title)" }}"',
    );
    expect(activityKt).toContain("it.workspace.lowercase().contains(query)");
    expect(activityKt).toContain("it.resolvedTitle.lowercase().contains(query)");
    expect(activityKt).toContain("updateSendButtonState()");
    expect(activityKt).toContain("resolveSelectedSessionTarget()");
    expect(activityKt).toContain('statusText.text = "Select a non-Global session chip first."');
    expect(activityKt).toContain("activeAgentStatusText.text = if (selectedTarget == null)");
    expect(activityKt).toContain('"Selected session: Global"');
    expect(activityKt).toContain("requestVoiceToAgentCapture()");
    expect(activityKt).toContain("requestVoiceToAgentCapture(sendVerbatim = true)");
    expect(activityKt).toContain("sendToAgentButton.visibility = View.GONE");
    expect(activityKt).toContain("sendToAgentButton.visibility = View.VISIBLE");
    expect(activityKt).toContain("circularBackgroundColor = t.voiceCancelBg");
    expect(activityKt).toContain("circularBorderColor = t.voiceCancelBorder");
    expect(activityKt).toContain("renderSendToAgentButtonState(");
    expect(activityKt).toContain("R.drawable.ic_send_24");
    expect(activityKt).toContain("renderVoiceToAgentButtonState(");
    expect(activityKt).toContain("R.drawable.ic_chat_bubble_outline_24");
    expect(activityKt).toContain("R.drawable.ic_close_24");
    expect(activityKt).toContain(
      'if (role == "assistant" && model.turnId.isNotBlank() && hasRenderedAssistantBubbleForTurn(model.turnId))',
    );
    expect(activityKt).toContain("VoiceAdapterService.captureActiveAgentIntent(");
    expect(activityKt).toContain("VoiceAdapterService.EVENT_TYPE_ACTIVE_AGENT_CAPTURE_STATE");
    expect(activityKt).toContain("isSuppressedLegacyVoiceDispatchBubble(");
    expect(activityKt).toContain('lower.contains("sent transcript to active agent")');
    expect(activityKt).toContain('mode = "custom"');
    expect(activityKt).toContain("customMessageInput.addTextChangedListener(");
    expect(activityKt).toContain('.put("role", "user")');
    expect(activityKt).not.toContain('setTitle("Send Message")');
    expect(activityKt).toContain('dialogStatusText.text = "Sending..."');
    expect(activityKt).toContain("Session dispatch sent to ${formatWorkspaceAndTitle(");
    expect(activityKt).toContain("dialog?.dismiss()");
    expect(activityKt).toContain(
      "window.setLayout((metrics.widthPixels * 0.96f).toInt(), (metrics.heightPixels * 0.9f).toInt())",
    );
    expect(activityKt).toContain(
      "window.setBackgroundDrawableResource(android.R.color.transparent)",
    );
  });

  test("url utils provide session dispatch endpoint helpers", () => {
    const urlUtilsKt = readAndroidFile("java/com/agentvoiceadapter/android/UrlUtils.kt");

    expect(urlUtilsKt).toContain("fun sessionDispatchSessionsUrl(baseUrl: String): String");
    expect(urlUtilsKt).toContain("api/session-dispatch/sessions");
    expect(urlUtilsKt).toContain("fun sessionDispatchSendUrl(baseUrl: String): String");
    expect(urlUtilsKt).toContain("api/session-dispatch/send");
  });

  test("service exposes active-agent capture control action and event", () => {
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(serviceKt).toContain("ACTION_CAPTURE_ACTIVE_AGENT");
    expect(serviceKt).toContain("EVENT_TYPE_ACTIVE_AGENT_CAPTURE_STATE");
    expect(serviceKt).toContain("fun captureActiveAgentIntent(");
    expect(serviceKt).toContain("sendVerbatim: Boolean = false");
    expect(serviceKt).toContain("EXTRA_ACTIVE_AGENT_SEND_VERBATIM");
    expect(serviceKt).toContain("activeAgentSendVerbatimByCaptureTurnId");
    expect(serviceKt).toContain("sendVerbatim = sendVerbatim");
    expect(serviceKt).toContain("requestActiveAgentCaptureToggle()");
    expect(serviceKt).toContain("postActiveAgentMessage(");
    expect(serviceKt).toContain("activeAgentSessionIdByCaptureTurnId");
    expect(serviceKt).toContain("activeAgentSessionLabelByCaptureTurnId");
    expect(serviceKt).toContain(
      "formatLinkedSessionLabel(workspace = workspace, resolvedTitle = resolvedTitle)",
    );
    expect(serviceKt).toContain("emitBubble(");
    expect(serviceKt).toContain("linkedSessionId = linkedSessionId");
  });
});
