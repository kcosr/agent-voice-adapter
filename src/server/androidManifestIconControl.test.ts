import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android manifest icon wiring", () => {
  test("uses dedicated app icon resources instead of system default icon", () => {
    const manifestXml = readAndroidFile("AndroidManifest.xml");
    const iconDrawable = readAndroidFile("res/drawable/ic_app_icon.xml");

    expect(manifestXml).toContain('android:icon="@drawable/ic_app_icon"');
    expect(manifestXml).toContain('android:roundIcon="@drawable/ic_app_icon"');
    expect(manifestXml).not.toContain("@android:drawable/sym_def_app_icon");
    expect(iconDrawable).toContain(
      '<vector xmlns:android="http://schemas.android.com/apk/res/android"',
    );
  });
});
