import { describe, expect, test } from "vitest";

import {
  ATTACHMENT_PREVIEW_MAX_CHARS,
  ATTACHMENT_PREVIEW_MAX_LINES,
  buildAttachmentPreview,
  buildInvalidAttachmentFileName,
  isHtmlAttachment,
  normalizeAttachment,
  resolveAttachmentContentType,
  resolveAttachmentPreviewMode,
  sanitizeAttachmentFileName,
} from "./attachment-utils.js";

describe("normalizeAttachment", () => {
  test("returns null for invalid values", () => {
    expect(normalizeAttachment(null)).toBeNull();
    expect(normalizeAttachment("text")).toBeNull();
    expect(normalizeAttachment({})).toBeNull();
    expect(normalizeAttachment({ dataBase64: "" })).toBeNull();
  });

  test("normalizes valid markdown attachment metadata and decodes preview text", () => {
    const normalized = normalizeAttachment({
      dataBase64: "aGVsbG8=",
      fileName: " notes.md ",
      contentType: " text/markdown ",
    });

    expect(normalized).toMatchObject({
      dataBase64: "aGVsbG8=",
      fileName: "notes.md",
      contentType: "text/markdown",
      decodeState: "ok",
      previewMode: "markdown",
      text: "hello",
    });
    expect(normalized?.decodedBytes).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
  });

  test("infers html content type when filename is html and type is omitted", () => {
    const normalized = normalizeAttachment({
      dataBase64: "PGgxPkhlbGxvPC9oMT4=",
      fileName: "preview.html",
    });

    expect(normalized).toMatchObject({
      dataBase64: "PGgxPkhlbGxvPC9oMT4=",
      fileName: "preview.html",
      contentType: "text/html",
      decodeState: "ok",
      previewMode: "html",
    });
    expect(normalized).not.toHaveProperty("text");
  });

  test("marks invalid base64 payloads and keeps raw data for fallback download", () => {
    expect(
      normalizeAttachment({
        dataBase64: "not base64 !!",
        fileName: "notes.md",
        contentType: "text/markdown",
      }),
    ).toMatchObject({
      dataBase64: "not base64 !!",
      fileName: "notes.md",
      contentType: "text/markdown",
      decodeState: "invalid_base64",
      previewMode: "markdown",
    });
  });

  test("marks preview unavailable when utf-8 decode fails for previewable text MIME", () => {
    expect(
      normalizeAttachment({
        dataBase64: "//8=",
        fileName: "notes.txt",
        contentType: "text/plain",
      }),
    ).toMatchObject({
      dataBase64: "//8=",
      fileName: "notes.txt",
      contentType: "text/plain",
      decodeState: "preview_unavailable",
      previewMode: "text",
    });
  });

  test("keeps valid decoded bytes for non-previewable MIME and marks preview mode none", () => {
    const normalized = normalizeAttachment({
      dataBase64: "AAECAwQ=",
      fileName: "bundle.zip",
      contentType: "application/zip",
    });

    expect(normalized).toMatchObject({
      dataBase64: "AAECAwQ=",
      fileName: "bundle.zip",
      contentType: "application/zip",
      decodeState: "ok",
      previewMode: "none",
    });
    expect(normalized?.decodedBytes).toEqual(new Uint8Array([0, 1, 2, 3, 4]));
    expect(normalized).not.toHaveProperty("text");
  });
});

describe("attachment content type helpers", () => {
  test("resolves explicit content type first", () => {
    expect(resolveAttachmentContentType("text/plain", "preview.html")).toBe("text/plain");
  });

  test("resolves html content type from file extension when empty", () => {
    expect(resolveAttachmentContentType("", "preview.html")).toBe("text/html");
    expect(resolveAttachmentContentType(undefined, "preview.HTM")).toBe("text/html");
  });

  test("detects html attachment by content type or file extension", () => {
    expect(isHtmlAttachment("text/html", "notes.txt")).toBe(true);
    expect(isHtmlAttachment("", "notes.html")).toBe(true);
    expect(isHtmlAttachment("text/plain", "notes.txt")).toBe(false);
  });

  test("resolves preview mode per locked policy", () => {
    expect(resolveAttachmentPreviewMode("text/markdown", "notes.md")).toBe("markdown");
    expect(resolveAttachmentPreviewMode("text/plain", "notes.txt")).toBe("text");
    expect(resolveAttachmentPreviewMode("text/html", "notes.html")).toBe("html");
    expect(resolveAttachmentPreviewMode("application/json", "payload.json")).toBe("none");
  });
});

describe("attachment filename helpers", () => {
  test("sanitizes file names for download usage", () => {
    expect(sanitizeAttachmentFileName(" ../../foo:bar?.zip ")).toBe("foo_bar_.zip");
    expect(sanitizeAttachmentFileName("foo\u0001bar.txt")).toBe("foobar.txt");
    expect(sanitizeAttachmentFileName("...")).toBe("attachment");
  });

  test("builds invalid download filename suffix", () => {
    expect(buildInvalidAttachmentFileName("bundle.zip")).toBe("bundle.zip.invalid");
  });
});

describe("buildAttachmentPreview", () => {
  test("returns full text when under limits", () => {
    const text = "line one\nline two";
    expect(buildAttachmentPreview(text)).toEqual({
      previewText: text,
      truncated: false,
    });
  });

  test("truncates by line limit", () => {
    const lines = Array.from({ length: ATTACHMENT_PREVIEW_MAX_LINES + 2 }, (_, index) => {
      return `line-${index + 1}`;
    }).join("\n");

    const preview = buildAttachmentPreview(lines);
    expect(preview.truncated).toBe(true);
    expect(preview.previewText.split("\n")).toHaveLength(ATTACHMENT_PREVIEW_MAX_LINES);
  });

  test("truncates by character limit", () => {
    const longText = "x".repeat(ATTACHMENT_PREVIEW_MAX_CHARS + 50);
    const preview = buildAttachmentPreview(longText);

    expect(preview.truncated).toBe(true);
    expect(preview.previewText).toHaveLength(ATTACHMENT_PREVIEW_MAX_CHARS);
  });
});
