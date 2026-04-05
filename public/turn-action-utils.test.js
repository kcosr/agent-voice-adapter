import { describe, expect, test } from "vitest";
import { resolvePrimaryBubbleAction } from "./turn-action-utils.js";

describe("turn-action-utils", () => {
  test("maps tts phase to stop_tts", () => {
    expect(resolvePrimaryBubbleAction("tts")).toBe("stop_tts");
  });

  test("maps listen phase to cancel_turn", () => {
    expect(resolvePrimaryBubbleAction("listen")).toBe("cancel_turn");
  });

  test("returns null for idle or unknown phase", () => {
    expect(resolvePrimaryBubbleAction("idle")).toBeNull();
    expect(resolvePrimaryBubbleAction("other")).toBeNull();
  });
});
