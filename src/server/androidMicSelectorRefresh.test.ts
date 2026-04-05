import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android mic selector refresh behavior", () => {
  test("refreshes mic options on foreground resume and settings expand", () => {
    const activityKt = readAndroidFile("java/com/agentvoiceadapter/android/MainActivity.kt");

    expect(activityKt).toContain("private fun refreshMicOptionsFromCurrentSelection()");
    expect(activityKt).toContain("override fun onStart()");
    expect(activityKt).toContain("refreshMicOptionsFromCurrentSelection()");
    expect(activityKt).toContain(
      "private fun setSettingsExpanded(expanded: Boolean, persist: Boolean = true)",
    );
    expect(activityKt).toContain("if (expanded) {");
  });
});
