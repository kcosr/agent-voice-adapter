import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android safe-area insets", () => {
  test("applies bottom safe-area padding to chat and dialogs", () => {
    const activityKt = readAndroidFile("java/com/agentvoiceadapter/android/MainActivity.kt");

    expect(activityKt).toContain(
      "private fun resolveBottomSafeInset(insets: WindowInsetsCompat): Int",
    );
    expect(activityKt).toContain("WindowInsetsCompat.Type.systemGestures()");
    expect(activityKt).toContain("WindowInsetsCompat.Type.tappableElement()");
    expect(activityKt).toContain("chatScrollView.clipToPadding = false");
    expect(activityKt).toContain(
      "val extraChatBottomPadding = (12 * resources.displayMetrics.density).toInt()",
    );
    expect(activityKt).toContain(
      "chatScrollViewBaseBottomPadding + bottomSafeInset + extraChatBottomPadding",
    );
    expect(activityKt).toContain("content.paddingBottom + bottomInset");
    expect(activityKt).toContain("resolveBottomSafeInset(it)");
  });
});
