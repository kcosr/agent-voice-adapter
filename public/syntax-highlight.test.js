import { describe, expect, test } from "vitest";

import {
  highlightCodeToHtml,
  isTextLikeContentType,
  renderCodeBlockHtml,
  resolveSyntaxLanguage,
} from "./syntax-highlight.js";

describe("resolveSyntaxLanguage", () => {
  test("resolves known extensions", () => {
    expect(resolveSyntaxLanguage("index.ts")).toBe("typescript");
    expect(resolveSyntaxLanguage("MainActivity.kt")).toBe("kotlin");
    expect(resolveSyntaxLanguage("layout.xml")).toBe("markup");
  });

  test("returns null for unknown extensions", () => {
    expect(resolveSyntaxLanguage("README")).toBeNull();
    expect(resolveSyntaxLanguage("notes.customext")).toBeNull();
  });
});

describe("isTextLikeContentType", () => {
  test("accepts empty and text mime types", () => {
    expect(isTextLikeContentType("")).toBe(true);
    expect(isTextLikeContentType("text/plain")).toBe(true);
    expect(isTextLikeContentType("application/json")).toBe(true);
  });

  test("rejects binary-like mime types", () => {
    expect(isTextLikeContentType("image/png")).toBe(false);
    expect(isTextLikeContentType("audio/wav")).toBe(false);
  });
});

describe("highlightCodeToHtml", () => {
  test("highlights keywords, numbers, and strings", () => {
    const html = highlightCodeToHtml('const value = 42;\nconsole.log("ok");', "javascript");
    expect(html).toContain('class="code-token-keyword"');
    expect(html).toContain('class="code-token-number"');
    expect(html).toContain('class="code-token-string"');
  });

  test("escapes html for unknown languages", () => {
    const html = highlightCodeToHtml("<script>alert(1)</script>", "unknown");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("renderCodeBlockHtml", () => {
  test("wraps highlighted code with pre/code and language class", () => {
    const html = renderCodeBlockHtml("return true;", "javascript");
    expect(html).toContain("<pre><code");
    expect(html).toContain('class="language-javascript"');
    expect(html).toContain('class="code-token-keyword"');
  });
});
