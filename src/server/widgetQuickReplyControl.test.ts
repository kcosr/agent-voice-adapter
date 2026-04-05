import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

describe("widget quick reply control", () => {
  test("renders quick-reply buttons and sends websocket quick-reply payload", () => {
    const appJs = readFileSync(path.resolve(__dirname, "../../public/app.js"), "utf8");

    expect(appJs).toContain("function normalizeQuickReplies(rawQuickReplies)");
    expect(appJs).toContain(
      "function appendBubbleQuickRepliesSection(bubble, turnId, quickReplies)",
    );
    expect(appJs).toContain('type: "turn_listen_quick_reply"');
    expect(appJs).toContain("entry.requestRecognition = false");
    expect(appJs).toContain("entry.quickReplySelected = true");
    expect(appJs).toContain("entry.quickRepliesConsumed = true");
    expect(appJs).toContain("persistQuickRepliesAfterTts: payload.listenRequested !== true");
    expect(appJs).toContain("quickReplies.length === 1 && quickReplies[0]?.defaultResume === true");
    expect(appJs).toContain('section.classList.add("bubble-quick-replies-default-resume")');
    expect(appJs).toContain('forceLocalPlaybackCancel(turnId, "quick_reply")');
    expect(appJs).toContain("setBubbleQuickReplyButtonsEnabled(bubble, false)");
    expect(appJs).toContain("pendingRecognitionRequestIds.delete(turnId)");
    expect(appJs).toContain("recorder.stopSession(turnId)");
  });

  test("includes widget quick-reply styling hooks", () => {
    const stylesCss = readFileSync(path.resolve(__dirname, "../../public/styles.css"), "utf8");

    expect(stylesCss).toContain(".bubble-quick-replies");
    expect(stylesCss).toContain(".bubble-quick-replies-default-resume");
    expect(stylesCss).toContain(".bubble-quick-reply-btn");
    expect(stylesCss).toContain(".bubble-quick-reply-btn:disabled");
  });
});
