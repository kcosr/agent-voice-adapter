import { describe, expect, test } from "vitest";

import {
  isMarkdownAttachment,
  isMarkdownContentType,
  isMarkdownFileName,
  renderMarkdownToSafeHtml,
} from "./markdown-renderer.js";

describe("isMarkdownContentType", () => {
  test("matches markdown mime types", () => {
    expect(isMarkdownContentType("text/markdown")).toBe(true);
    expect(isMarkdownContentType(" text/markdown; charset=utf-8 ")).toBe(true);
  });

  test("rejects non-markdown mime types", () => {
    expect(isMarkdownContentType("text/plain")).toBe(false);
    expect(isMarkdownContentType("")).toBe(false);
    expect(isMarkdownContentType(null)).toBe(false);
  });
});

describe("isMarkdownFileName", () => {
  test("matches markdown file extensions", () => {
    expect(isMarkdownFileName("README.md")).toBe(true);
  });

  test("rejects non-markdown file names", () => {
    expect(isMarkdownFileName("notes.markdown")).toBe(false);
    expect(isMarkdownFileName("notes.txt")).toBe(false);
    expect(isMarkdownFileName("")).toBe(false);
    expect(isMarkdownFileName(null)).toBe(false);
  });
});

describe("isMarkdownAttachment", () => {
  test("accepts markdown by content type or file name", () => {
    expect(isMarkdownAttachment("text/markdown", "")).toBe(true);
    expect(isMarkdownAttachment("text/plain", "README.md")).toBe(true);
    expect(isMarkdownAttachment("text/plain", "notes.txt")).toBe(false);
  });
});

describe("renderMarkdownToSafeHtml", () => {
  test("renders common markdown blocks", () => {
    const markdown = "# Title\n\n- one\n- two\n\n`inline`\n\n```js\nconst x = 1;\n```";
    const html = renderMarkdownToSafeHtml(markdown);

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<code>inline</code>");
    expect(html).toContain('<code class="language-js">');
    expect(html).toContain('class="code-token-keyword"');
    expect(html).toContain('class="code-token-number"');
  });

  test("escapes raw html and strips unsafe link protocols", () => {
    const markdown =
      '<script>alert("xss")</script>\n\n[bad](javascript:alert(1))\n\n[good](https://example.com)';
    const html = renderMarkdownToSafeHtml(markdown);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com/"');
  });

  test("renders markdown tables with alignment", () => {
    const markdown = [
      "| name | score |",
      "| :--- | ---: |",
      "| alice | 42 |",
      "| **bob** | `7` |",
    ].join("\n");
    const html = renderMarkdownToSafeHtml(markdown);

    expect(html).toContain("<table>");
    expect(html).toContain(
      '<thead><tr><th style="text-align:left;">name</th><th style="text-align:right;">score</th></tr></thead>',
    );
    expect(html).toContain(
      '<tbody><tr><td style="text-align:left;">alice</td><td style="text-align:right;">42</td></tr>',
    );
    expect(html).toContain("<strong>bob</strong>");
    expect(html).toContain("<code>7</code>");
  });

  test("renders yaml front matter as a fenced code block", () => {
    const markdown = [
      "---",
      "title: Sample",
      "tags:",
      "  - one",
      "  - two",
      "---",
      "",
      "# Heading",
    ].join("\n");
    const html = renderMarkdownToSafeHtml(markdown);

    expect(html).toContain('<code class="language-yaml">');
    expect(html).toContain("title");
    expect(html).toContain("<h1>Heading</h1>");
  });
});
