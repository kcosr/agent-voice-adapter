import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android bubble reference actions", () => {
  test("renders reusable assistant bubble header actions for contextual responses", () => {
    const activityKt = readAndroidFile("java/com/agentvoiceadapter/android/MainActivity.kt");

    expect(activityKt).toContain("private val bubbleReferenceCannedResponseText =");
    expect(activityKt).toContain("private val bubbleHeaderActionTagPrefix =");
    expect(activityKt).toContain(
      "private fun buildBubbleReferenceActionRow(model: BubbleRenderModel): View?",
    );
    expect(activityKt).toContain("R.drawable.ic_reply_24");
    expect(activityKt).toContain("android.R.drawable.ic_btn_speak_now");
    expect(activityKt).toContain("sendBubbleReferenceCannedResponse(model)");
    expect(activityKt).toContain("startBubbleReferencedVoiceCapture(model)");
    expect(activityKt).toContain("buildBubbleReferenceDispatchMessage(");
    expect(activityKt).toContain('private var localCaptureSourceBubbleTurnId: String = ""');
    expect(activityKt).toContain("sourceBubbleTurnId: String? = null");
    expect(activityKt).toContain("sourceBubbleTurnId = model.turnId");
    expect(activityKt).toContain(
      "private fun isLocalCaptureSourceAssistantTurn(state: BubbleViewState): Boolean",
    );
    expect(activityKt).toContain(
      "private fun isLocalCaptureSourceTurnInProgress(turnId: String): Boolean",
    );
    expect(activityKt).toContain("private fun cancelLocalCaptureFromBubbleAction()");
    expect(activityKt).toContain("Use the mic action to cancel this in-progress capture.");
    expect(activityKt).toContain("cancelLocalCaptureFromBubbleAction()");
    expect(activityKt).toContain("allowSourceBubbleCancelAction");
    expect(activityKt).toContain("setBubbleHeaderActionButtonsEnabled(");
    expect(activityKt).toContain("This action is available after the turn closes.");
    expect(activityKt).toContain("User is responding to a previous assistant message.");
    expect(activityKt).toContain("Assistant message:");
    expect(activityKt).toContain("User response:");
  });

  test("passes quoted assistant context through active-agent capture dispatch", () => {
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(serviceKt).toContain("EXTRA_ACTIVE_AGENT_QUOTED_ASSISTANT_TEXT");
    expect(serviceKt).toContain("quotedAssistantText: String? = null");
    expect(serviceKt).toContain("activeAgentQuotedAssistantTextByCaptureTurnId");
    expect(serviceKt).toContain("activeAgentQuotedAssistantText =");
    expect(serviceKt).toContain(
      "activeAgentQuotedAssistantTextByCaptureTurnId[requestId] = quotedAssistantText",
    );
    expect(serviceKt).toContain("postActiveAgentMessage(");
    expect(serviceKt).toContain("sendVerbatim: Boolean = false");
    expect(serviceKt).toContain("private fun buildActiveAgentDispatchMessage(");
    expect(serviceKt).toContain("quotedAssistantText: String? = null");
    expect(serviceKt).toContain("User is responding to a previous assistant message.");
  });
});
