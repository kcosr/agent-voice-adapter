import { describe, expect, test } from "vitest";

import { sanitizeTtsText } from "./sanitizeText";

const baseConfig = {
  stripBackticks: true,
  stripMarkdownArtifacts: true,
  stripUrlProtocol: true,
  stripEmoji: true,
  collapseWhitespace: true,
  maxTextChars: 5000,
};

describe("sanitizeTtsText", () => {
  test("strips backticks and markdown artifacts", () => {
    const input = "Use `code` and **bold** text.";
    const result = sanitizeTtsText(input, baseConfig);

    expect(result.sanitizedText).toBe("Use code and bold text.");
    expect(result.changed).toBe(true);
  });

  test("removes url protocol only", () => {
    const input = "Visit https://example.com and http://localhost:4300";
    const result = sanitizeTtsText(input, baseConfig);

    expect(result.sanitizedText).toBe("Visit example.com and localhost:4300");
  });

  test("strips emoji including ZWJ sequences and variation selectors", () => {
    const input = "Hello 👋 world 👨‍👩‍👧 and ❤️ everyone 🎉";
    const result = sanitizeTtsText(input, baseConfig);

    expect(result.sanitizedText).toBe("Hello world and everyone");
    expect(result.changed).toBe(true);
  });

  test("strips skin-tone modifiers, flags, keycaps, and tag sequences", () => {
    const input = "wave 👋🏽 flag 🇺🇸 keycap 1️⃣ tag 🏴󠁧󠁢󠁳󠁣󠁴󠁿 end";
    const result = sanitizeTtsText(input, baseConfig);

    expect(result.sanitizedText).toBe("wave flag keycap tag end");
  });

  test("does not strip plain digits, asterisks, or hashes", () => {
    const input = "call 123 and use *stars* and #hash";
    const result = sanitizeTtsText(input, {
      ...baseConfig,
      stripMarkdownArtifacts: false,
    });

    expect(result.sanitizedText).toBe("call 123 and use *stars* and #hash");
  });

  test("preserves text when stripEmoji is disabled", () => {
    const input = "Hello 👋 world";
    const result = sanitizeTtsText(input, {
      ...baseConfig,
      stripEmoji: false,
    });

    expect(result.sanitizedText).toBe("Hello 👋 world");
  });

  test("trims and truncates by max text chars", () => {
    const input = "   abcdefghij   ";
    const result = sanitizeTtsText(input, {
      ...baseConfig,
      maxTextChars: 5,
    });

    expect(result.sanitizedText).toBe("abcde");
  });
});
