import { escapeHtml, escapeHtmlAttribute } from "./html-utils.js";
import { highlightCodeToHtml } from "./syntax-highlight.js";

function isSafeRelativeUrl(url) {
  if (url.startsWith("#")) {
    return true;
  }
  if (url.startsWith("/")) {
    return !url.startsWith("//");
  }
  return !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("//");
}

function sanitizeLinkHref(rawHref) {
  const href = String(rawHref).trim();
  if (href.length === 0) {
    return null;
  }

  if (isSafeRelativeUrl(href)) {
    return href;
  }

  try {
    const parsed = new URL(href);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") {
      return parsed.toString();
    }
  } catch {
    // Invalid absolute URL; reject below.
  }

  return null;
}

function createToken(tokens, html) {
  const token = `@@MDTOKEN${tokens.length}@@`;
  tokens.push(html);
  return token;
}

function restoreTokens(text, tokens) {
  return text.replace(/@@MDTOKEN(\d+)@@/g, (_match, tokenIndex) => {
    const index = Number.parseInt(tokenIndex, 10);
    return Number.isInteger(index) && index >= 0 && index < tokens.length ? tokens[index] : "";
  });
}

function replaceMarkdownLinks(text, tokens) {
  let output = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (char !== "[") {
      output += char;
      index += 1;
      continue;
    }

    const labelEnd = text.indexOf("]", index + 1);
    if (labelEnd < 0 || text[labelEnd + 1] !== "(") {
      output += char;
      index += 1;
      continue;
    }

    let hrefIndex = labelEnd + 2;
    let depth = 1;
    while (hrefIndex < text.length && depth > 0) {
      const hrefChar = text[hrefIndex];
      if (hrefChar === "(") {
        depth += 1;
      } else if (hrefChar === ")") {
        depth -= 1;
      }
      hrefIndex += 1;
    }

    if (depth !== 0) {
      output += char;
      index += 1;
      continue;
    }

    const label = text.slice(index + 1, labelEnd);
    const href = text.slice(labelEnd + 2, hrefIndex - 1);
    const safeHref = sanitizeLinkHref(href);
    const labelHtml = escapeHtml(label);

    if (!safeHref) {
      output += createToken(tokens, labelHtml);
    } else {
      output += createToken(
        tokens,
        `<a href="${escapeHtmlAttribute(safeHref)}" target="_blank" rel="noopener noreferrer nofollow">${labelHtml}</a>`,
      );
    }

    index = hrefIndex;
  }

  return output;
}

function renderInlineMarkdown(rawText) {
  const tokens = [];
  let working = String(rawText);

  working = working.replace(/`([^`\n]+)`/g, (_match, codeText) => {
    return createToken(tokens, `<code>${escapeHtml(codeText)}</code>`);
  });

  working = replaceMarkdownLinks(working, tokens);

  let escaped = escapeHtml(working);
  escaped = escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/_([^_\n]+)_/g, "<em>$1</em>");

  return restoreTokens(escaped, tokens);
}

function isHorizontalRuleLine(line) {
  return /^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})\s*$/.test(line);
}

function isUnorderedListLine(line) {
  return /^\s*[-*+]\s+/.test(line);
}

function isOrderedListLine(line) {
  return /^\s*\d+\.\s+/.test(line);
}

function isHeadingLine(line) {
  return /^\s{0,3}#{1,6}\s+/.test(line);
}

function isBlockquoteLine(line) {
  return /^\s{0,3}>\s?/.test(line);
}

function isCodeFenceLine(line) {
  return /^\s*```/.test(line);
}

function parseTableCells(line) {
  const trimmed = String(line).trim();
  let content = trimmed;
  if (content.startsWith("|")) {
    content = content.slice(1);
  }
  if (content.endsWith("|")) {
    content = content.slice(0, -1);
  }
  if (content.length === 0) {
    return [];
  }

  const cells = [];
  let current = "";
  let escaping = false;
  for (const char of content) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function isTableSeparatorCell(cell) {
  return /^:?-{3,}:?$/.test(cell.trim());
}

function tableCellAlign(cell) {
  const normalized = cell.trim();
  const left = normalized.startsWith(":");
  const right = normalized.endsWith(":");
  if (left && right) {
    return "center";
  }
  if (right) {
    return "right";
  }
  if (left) {
    return "left";
  }
  return null;
}

function canRenderTableAt(lines, startIndex) {
  if (startIndex + 1 >= lines.length) {
    return false;
  }
  const headerLine = lines[startIndex];
  const separatorLine = lines[startIndex + 1];
  if (!headerLine.includes("|")) {
    return false;
  }
  const headers = parseTableCells(headerLine);
  const separators = parseTableCells(separatorLine);
  if (headers.length === 0 || separators.length === 0 || headers.length !== separators.length) {
    return false;
  }
  return separators.every((cell) => isTableSeparatorCell(cell));
}

function renderTable(lines, startIndex) {
  const headerCells = parseTableCells(lines[startIndex]);
  const separatorCells = parseTableCells(lines[startIndex + 1]);
  const alignments = separatorCells.map((cell) => tableCellAlign(cell));
  const alignStyle = (index) =>
    alignments[index] ? ` style="text-align:${alignments[index]};"` : "";

  const headerHtml = headerCells
    .map((cell, index) => `<th${alignStyle(index)}>${renderInlineMarkdown(cell)}</th>`)
    .join("");

  let index = startIndex + 2;
  const rowHtml = [];
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim().length === 0 || !line.includes("|")) {
      break;
    }
    const cells = parseTableCells(line);
    if (cells.length === 0) {
      break;
    }
    const normalized = headerCells.map((_, cellIndex) => cells[cellIndex] ?? "");
    rowHtml.push(
      `<tr>${normalized
        .map((cell, cellIndex) => `<td${alignStyle(cellIndex)}>${renderInlineMarkdown(cell)}</td>`)
        .join("")}</tr>`,
    );
    index += 1;
  }

  const bodyHtml = rowHtml.length > 0 ? `<tbody>${rowHtml.join("")}</tbody>` : "";
  return {
    html: `<table><thead><tr>${headerHtml}</tr></thead>${bodyHtml}</table>`,
    nextIndex: index,
  };
}

function isBlockStart(line) {
  return (
    isCodeFenceLine(line) ||
    isHeadingLine(line) ||
    isHorizontalRuleLine(line) ||
    isBlockquoteLine(line) ||
    isUnorderedListLine(line) ||
    isOrderedListLine(line)
  );
}

function renderCodeFence(lines, startIndex) {
  const openLine = lines[startIndex] ?? "";
  const languageMatch = openLine.match(/^\s*```([^\s`]*)\s*$/);
  const rawLanguage = languageMatch?.[1] ?? "";
  const safeLanguage = rawLanguage.replace(/[^a-z0-9_-]/gi, "");

  const codeLines = [];
  let index = startIndex + 1;
  while (index < lines.length && !/^\s*```/.test(lines[index])) {
    codeLines.push(lines[index]);
    index += 1;
  }

  if (index < lines.length && /^\s*```/.test(lines[index])) {
    index += 1;
  }

  const classAttribute =
    safeLanguage.length > 0 ? ` class="language-${escapeHtmlAttribute(safeLanguage)}"` : "";
  const highlightedCode = highlightCodeToHtml(codeLines.join("\n"), safeLanguage);
  const html = `<pre><code${classAttribute}>${highlightedCode}</code></pre>`;
  return { html, nextIndex: index };
}

function renderList(lines, startIndex, ordered) {
  const matcher = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
  const items = [];
  let index = startIndex;

  while (index < lines.length) {
    const match = lines[index].match(matcher);
    if (!match) {
      break;
    }
    items.push(`<li>${renderInlineMarkdown(match[1] ?? "")}</li>`);
    index += 1;
  }

  const listTag = ordered ? "ol" : "ul";
  return {
    html: `<${listTag}>${items.join("")}</${listTag}>`,
    nextIndex: index,
  };
}

function renderBlockquote(lines, startIndex) {
  const quoteLines = [];
  let index = startIndex;

  while (index < lines.length) {
    const match = lines[index].match(/^\s{0,3}>\s?(.*)$/);
    if (!match) {
      break;
    }
    quoteLines.push(match[1] ?? "");
    index += 1;
  }

  const body = quoteLines.map((line) => renderInlineMarkdown(line)).join("<br>");
  return {
    html: `<blockquote><p>${body}</p></blockquote>`,
    nextIndex: index,
  };
}

function renderParagraph(lines, startIndex) {
  const paragraphLines = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim().length === 0 || isBlockStart(line) || canRenderTableAt(lines, index)) {
      break;
    }
    paragraphLines.push(line.trimEnd());
    index += 1;
  }

  const body = paragraphLines.map((line) => renderInlineMarkdown(line)).join("<br>");
  return {
    html: `<p>${body}</p>`,
    nextIndex: index,
  };
}

export function isMarkdownContentType(contentType) {
  if (typeof contentType !== "string") {
    return false;
  }
  const normalized = contentType.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  return normalized === "text/markdown" || normalized.startsWith("text/markdown;");
}

export function isMarkdownFileName(fileName) {
  if (typeof fileName !== "string") {
    return false;
  }
  const normalized = fileName.trim().toLowerCase();
  return normalized.endsWith(".md");
}

export function isMarkdownAttachment(contentType, fileName) {
  return isMarkdownContentType(contentType) || isMarkdownFileName(fileName);
}

function normalizeMarkdownFrontMatter(text) {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return text;
  }

  const lines = text.split("\n");
  if (lines.length < 3 || lines[0].trim() !== "---") {
    return text;
  }

  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const marker = lines[index].trim();
    if (marker === "---" || marker === "...") {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex <= 1) {
    return text;
  }

  const frontMatterLines = lines.slice(1, closingIndex);
  const looksLikeYaml = frontMatterLines.some((line) => line.includes(":"));
  if (!looksLikeYaml) {
    return text;
  }

  const rest = lines.slice(closingIndex + 1).join("\n");
  const normalizedFrontMatter = ["```yaml", ...frontMatterLines, "```"].join("\n");
  if (rest.trim().length === 0) {
    return normalizedFrontMatter;
  }
  return `${normalizedFrontMatter}\n\n${rest}`;
}

export function renderMarkdownToSafeHtml(markdownText) {
  const text = normalizeMarkdownFrontMatter(String(markdownText ?? ""));
  const lines = text.split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      index += 1;
      continue;
    }

    if (isCodeFenceLine(line)) {
      const rendered = renderCodeFence(lines, index);
      blocks.push(rendered.html);
      index = rendered.nextIndex;
      continue;
    }

    if (canRenderTableAt(lines, index)) {
      const rendered = renderTable(lines, index);
      blocks.push(rendered.html);
      index = rendered.nextIndex;
      continue;
    }

    if (isHeadingLine(line)) {
      const match = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
      const level = match ? Math.min(match[1].length, 6) : 1;
      const headingText = match?.[2] ?? line.trim();
      blocks.push(`<h${level}>${renderInlineMarkdown(headingText)}</h${level}>`);
      index += 1;
      continue;
    }

    if (isHorizontalRuleLine(line)) {
      blocks.push("<hr>");
      index += 1;
      continue;
    }

    if (isBlockquoteLine(line)) {
      const rendered = renderBlockquote(lines, index);
      blocks.push(rendered.html);
      index = rendered.nextIndex;
      continue;
    }

    if (isUnorderedListLine(line)) {
      const rendered = renderList(lines, index, false);
      blocks.push(rendered.html);
      index = rendered.nextIndex;
      continue;
    }

    if (isOrderedListLine(line)) {
      const rendered = renderList(lines, index, true);
      blocks.push(rendered.html);
      index = rendered.nextIndex;
      continue;
    }

    const rendered = renderParagraph(lines, index);
    blocks.push(rendered.html);
    index = rendered.nextIndex;
  }

  return blocks.join("");
}
