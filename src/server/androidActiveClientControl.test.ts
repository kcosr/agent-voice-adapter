import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android active client control", () => {
  test("renders active-device status and activate icon button in activity layout", () => {
    const layoutXml = readAndroidFile("res/layout/activity_main.xml");

    expect(layoutXml).toContain('android:id="@+id/active_client_status_text"');
    expect(layoutXml).toContain('android:text="Active device: unknown"');
    expect(layoutXml).toContain('android:id="@+id/activate_client_button"');
    expect(layoutXml).toContain('android:src="@drawable/ic_active_client_outline_24"');
  });

  test("main activity wires activate action and active-device UI state", () => {
    const activityKt = readAndroidFile("java/com/agentvoiceadapter/android/MainActivity.kt");

    expect(activityKt).toContain("activateClientButton");
    expect(activityKt).toContain("activeClientStatusText");
    expect(activityKt).toContain("VoiceAdapterService.EVENT_TYPE_ACTIVE_CLIENT_STATE");
    expect(activityKt).toContain("parseActiveClientState(");
    expect(activityKt).toContain("renderActiveClientControls()");
    expect(activityKt).toContain("renderActivateClientButtonState(");
    expect(activityKt).toContain("requestClientActivationToggle()");
    expect(activityKt).toContain("VoiceAdapterService.deactivateClientIntent");
    expect(activityKt).toContain("VoiceAdapterService.activateClientIntent");
    expect(activityKt).toContain("VoiceAdapterService.snapshotIntent(this)");
    expect(activityKt).toContain("R.drawable.ic_active_client_filled_24");
    expect(activityKt).toContain("R.drawable.ic_active_client_outline_24");
  });

  test("main activity refreshes persisted bubbles when active playback turn is missing", () => {
    const activityKt = readAndroidFile("java/com/agentvoiceadapter/android/MainActivity.kt");

    expect(activityKt).toContain("maybeRefreshBubblesForActivePlaybackTurn()");
    expect(activityKt).toContain("hasRenderedAssistantBubbleForTurn(");
    expect(activityKt).toContain("renderPersistedBubbles()");
    expect(activityKt).toContain('runtimeStatusState.audio.equals("playback", ignoreCase = true)');
  });

  test("service supports activate/deactivate actions and emits active-client state events", () => {
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(serviceKt).toContain("ACTION_ACTIVATE_CLIENT");
    expect(serviceKt).toContain("ACTION_DEACTIVATE_CLIENT");
    expect(serviceKt).toContain("ACTION_SNAPSHOT");
    expect(serviceKt).toContain("ACTION_UPDATE ->");
    expect(serviceKt).toContain("EVENT_TYPE_ACTIVE_CLIENT_STATE");
    expect(serviceKt).toContain("private var wantActive = false");
    expect(serviceKt).toContain("fun activateClientIntent");
    expect(serviceKt).toContain("fun deactivateClientIntent");
    expect(serviceKt).toContain("requestClientActivation(");
    expect(serviceKt).toContain(
      '.put("type", if (activate) "client_activate" else "client_deactivate")',
    );
    expect(serviceKt).toContain("wantActive = true");
    expect(serviceKt).toContain("wantActive = false");
    expect(serviceKt).toContain("if (wantActive) {");
    expect(serviceKt).toContain('"client_activation_state" ->');
    expect(serviceKt).toContain("maybeHandleLostActiveOwnership(");
    expect(serviceKt).toContain("forceReleaseLocalCaptureState(");
    expect(serviceKt).toContain("capture_force_release_begin");
    expect(serviceKt).toContain("micStreamer.stop()");
    expect(serviceKt).toContain("active_client_state source=client_activation_state");
    expect(serviceKt).toContain("applyRuntimeConfig(updated)");
    expect(serviceKt).toContain("emitActiveClientState()");
  });

  test("service only lets the active speech-enabled client play or listen for broadcast turns", () => {
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(serviceKt).toContain("if (!runtimeClientActive || !runtimeConfig.speechEnabled) {");
    expect(serviceKt).toContain("private fun shouldHandleTurnPlayback(): Boolean {");
    expect(serviceKt).toContain("return runtimeClientActive && runtimeConfig.speechEnabled");
    expect(serviceKt).toContain("private fun shouldHandleTurnRecognition(): Boolean {");
    expect(serviceKt).toContain(
      "return runtimeClientActive && runtimeConfig.speechEnabled && runtimeConfig.listeningEnabled",
    );
    expect(serviceKt).toContain("if (!shouldHandleTurnPlayback()) {");
    expect(serviceKt).toContain("if (listenRequested && shouldHandleTurnRecognition()) {");
  });
});
