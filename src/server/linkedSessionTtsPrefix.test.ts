import { describe, expect, test } from "vitest";

import {
  applyLinkedSessionPrefixToTurnText,
  formatLinkedSessionPrefixLabel,
} from "./linkedSessionTtsPrefix";

describe("linkedSessionTtsPrefix", () => {
  test("formats workspace/title session labels", () => {
    expect(
      formatLinkedSessionPrefixLabel({
        workspace: "voice",
        resolvedTitle: "Agent One",
        sessionId: "abc",
      }),
    ).toBe("voice, Agent One");
  });

  test("falls back to title/session id when workspace is missing", () => {
    expect(
      formatLinkedSessionPrefixLabel({
        workspace: " ",
        resolvedTitle: "",
        sessionId: "session-123",
      }),
    ).toBe("session-123");
  });

  test("prefixes only sanitized text when enabled", () => {
    const result = applyLinkedSessionPrefixToTurnText({
      originalText: "Hello world",
      sanitizedText: "Hello world",
      sessionLabel: "voice, Agent One",
      prependEnabled: true,
    });

    expect(result).toEqual({
      originalText: "Hello world",
      sanitizedText: "voice, Agent One. Hello world",
      prefixed: true,
    });
  });
});
