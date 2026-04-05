import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readPublicFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../public", relativePath), "utf8");
}

describe("widget loopback control", () => {
  test("renders a loopback test button in the header controls", () => {
    const html = readPublicFile("index.html");

    expect(html).toContain('id="loopback-test"');
    expect(html).toContain(">Loopback Test<");
  });

  test("wires loopback button click to a listen-enabled /api/turn request", () => {
    const appJs = readPublicFile("app.js");

    expect(appJs).toContain('const loopbackTestButton = document.getElementById("loopback-test")');
    expect(appJs).toContain('loopbackTestButton.addEventListener("click"');
    expect(appJs).toContain('fetch("/api/turn"');
    expect(appJs).toContain("listen: true");
    expect(appJs).toContain("LOOPBACK_TEST_PROMPT_TEXT");
  });
});
