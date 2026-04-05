import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

describe("widget wake-intent cue parity", () => {
  test("uses the shared wake trigger regex for browser cue playback", () => {
    const appJs = readFileSync(path.resolve(__dirname, "../../public/app.js"), "utf8");

    expect(appJs).toContain("const WAKE_TRIGGER_REGEX = /\\b(agent|assistant)\\b/i;");
    expect(appJs).toContain("const playWakeCues = WAKE_TRIGGER_REGEX.test(transcript);");
    expect(appJs).toContain('player.playWakeCommandBeep("start")');
    expect(appJs).toContain('player.playWakeCommandBeep("end")');
  });
});
