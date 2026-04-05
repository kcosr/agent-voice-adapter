import { describe, expect, test } from "vitest";
import { shouldRecoverStaleListen } from "./reliability-utils.js";

describe("reliability-utils", () => {
  test("returns true when listen state is stale beyond threshold", () => {
    expect(
      shouldRecoverStaleListen({
        activePhase: "listen",
        activeTurnId: "turn-1",
        lastListenEventAtMs: 1000,
        nowMs: 45000,
        staleThresholdMs: 30000,
      }),
    ).toBe(true);
  });

  test("returns false for non-listen or invalid state", () => {
    expect(
      shouldRecoverStaleListen({
        activePhase: "tts",
        activeTurnId: "turn-1",
        lastListenEventAtMs: 1000,
        nowMs: 45000,
        staleThresholdMs: 30000,
      }),
    ).toBe(false);

    expect(
      shouldRecoverStaleListen({
        activePhase: "listen",
        activeTurnId: "",
        lastListenEventAtMs: 1000,
        nowMs: 45000,
        staleThresholdMs: 30000,
      }),
    ).toBe(false);
  });
});
