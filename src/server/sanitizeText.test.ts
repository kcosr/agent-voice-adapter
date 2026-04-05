import { describe, expect, test } from "vitest";

import { sanitizeTtsText } from "./sanitizeText";

const baseConfig = {
  stripBackticks: true,
  stripMarkdownArtifacts: true,
  stripUrlProtocol: true,
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

  test("trims and truncates by max text chars", () => {
    const input = "   abcdefghij   ";
    const result = sanitizeTtsText(input, {
      ...baseConfig,
      maxTextChars: 5,
    });

    expect(result.sanitizedText).toBe("abcde");
  });
});
