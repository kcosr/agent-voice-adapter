import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidAppFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app", relativePath), "utf8");
}

describe("android debug version code control", () => {
  test("app gradle script auto-increments local debug version code", () => {
    const gradleKts = readAndroidAppFile("build.gradle.kts");

    expect(gradleKts).toContain('LOCAL_VERSION_CODE_FILE = "local-version-code.txt"');
    expect(gradleKts).toContain(
      "fun shouldIncrementLocalVersionCode(taskNames: List<String>): Boolean",
    );
    expect(gradleKts).toContain('normalized.contains("installdebug")');
    expect(gradleKts).toContain(
      "fun resolveLocalVersionCode(taskNames: List<String>, counterFile: java.io.File): Int",
    );
    expect(gradleKts).toContain('counterFile.writeText("$nextVersionCode\\n")');
    expect(gradleKts).toContain("versionCode = localVersionCode");
  });
});
