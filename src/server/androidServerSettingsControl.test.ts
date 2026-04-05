import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android server settings control", () => {
  test("renders server settings section controls in activity layout", () => {
    const layoutXml = readAndroidFile("res/layout/activity_main.xml");

    expect(layoutXml).toContain("Server Settings");
    expect(layoutXml).toContain("Server-side defaults that affect all clients");
    expect(layoutXml).toContain("NestedScrollView");
    expect(layoutXml).toContain('android:maxHeight="400dp"');
    expect(layoutXml).toContain('android:id="@+id/load_server_settings_button"');
    expect(layoutXml).toContain('android:id="@+id/server_listen_start_timeout_input"');
    expect(layoutXml).toContain('android:id="@+id/server_listen_completion_timeout_input"');
    expect(layoutXml).toContain('android:id="@+id/server_end_silence_input"');
    expect(layoutXml).toContain('android:id="@+id/server_queue_advance_delay_input"');
    expect(layoutXml).toContain('android:id="@+id/server_prepend_linked_session_label_switch"');
    expect(layoutXml).toContain('android:id="@+id/apply_server_settings_button"');
    expect(layoutXml).toContain("Start timeout (ms)");
    expect(layoutXml).toContain("Completion timeout (ms)");
    expect(layoutXml).toContain("End silence (ms)");
    expect(layoutXml).toContain("Queue delay (ms)");
    expect(layoutXml).toContain("Prefix linked-session label in spoken TTS");
  });

  test("wires server settings load/apply flow in MainActivity", () => {
    const activityKt = readAndroidFile("java/com/agentvoiceadapter/android/MainActivity.kt");

    expect(activityKt).toContain("loadServerSettingsButton");
    expect(activityKt).toContain("applyServerSettingsButton");
    expect(activityKt).toContain("loadServerSettings()");
    expect(activityKt).toContain("applyServerSettings()");
    expect(activityKt).toContain("fetchServerRuntimeSettings(");
    expect(activityKt).toContain("updateServerRuntimeSettings(");
    expect(activityKt).toContain("parseServerRuntimeSettings(");
    expect(activityKt).toContain("Server settings must be numeric");
    expect(activityKt).toContain('statusText.text = "Service running."');
    expect(activityKt).not.toContain('statusText.text = "Service running. URL=');
  });

  test("url utils provide server settings endpoint helper", () => {
    const urlUtilsKt = readAndroidFile("java/com/agentvoiceadapter/android/UrlUtils.kt");

    expect(urlUtilsKt).toContain("fun serverSettingsUrl(baseUrl: String): String");
    expect(urlUtilsKt).toContain("api/server-settings");
  });
});
