import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android playback terminal ack protocol", () => {
  test("service tracks pending no-wait playback ack turns and emits terminal websocket events", () => {
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(serviceKt).toContain("pendingPlaybackTerminalAckTurnIds");
    expect(serviceKt).toContain('"type", "turn_playback_terminal"');
    expect(serviceKt).toContain("turn_playback_terminal_send");
    expect(serviceKt).toContain(
      'sendPlaybackTerminalAckIfPending(turnId = turnId, status = "done")',
    );
    expect(serviceKt).toContain('status = "aborted"');
    expect(serviceKt).toContain("preempted_by_new_turn");
  });
});
