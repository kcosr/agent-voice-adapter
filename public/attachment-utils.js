export const ATTACHMENT_PREVIEW_MAX_LINES = 12;
export const ATTACHMENT_PREVIEW_MAX_CHARS = 600;
const INVALID_BASE64 = "invalid_base64";
const PREVIEW_UNAVAILABLE = "preview_unavailable";
const OK = "ok";

function asOptionalTrimmedString(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isHtmlFileName(fileName) {
  const normalized = typeof fileName === "string" ? fileName.trim().toLowerCase() : "";
  return normalized.endsWith(".html") || normalized.endsWith(".htm");
}

export function resolveAttachmentContentType(contentType, fileName) {
  const normalized = asOptionalTrimmedString(contentType);
  if (normalized) {
    return normalized;
  }
  if (isHtmlFileName(fileName)) {
    return "text/html";
  }
  return undefined;
}

export function isHtmlAttachment(contentType, fileName) {
  const normalized = typeof contentType === "string" ? contentType.trim().toLowerCase() : "";
  if (normalized === "text/html" || normalized.startsWith("text/html;")) {
    return true;
  }
  return isHtmlFileName(fileName);
}

export function sanitizeAttachmentFileName(fileName, fallback = "attachment") {
  const normalized = typeof fileName === "string" ? fileName.trim() : "";
  const basename = normalized.split(/[\\/]/).pop() ?? "";
  const withoutControlChars = Array.from(basename)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join("");
  const sanitized = withoutControlChars
    .replace(/[<>:"|?*]+/g, "_")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .trim();
  return sanitized.length > 0 ? sanitized : fallback;
}

export function buildInvalidAttachmentFileName(fileName) {
  return `${sanitizeAttachmentFileName(fileName)}.invalid`;
}

function decodeBase64ToBytes(dataBase64) {
  try {
    const binary = atob(dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function decodeUtf8Text(bytes) {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

function normalizeMimeType(contentType) {
  return typeof contentType === "string" ? contentType.trim().toLowerCase() : "";
}

export function resolveAttachmentPreviewMode(contentType, fileName) {
  if (isHtmlAttachment(contentType, fileName)) {
    return "html";
  }

  const normalized = normalizeMimeType(contentType);
  const baseType = normalized.split(";", 1)[0].trim();
  if (baseType === "text/markdown") {
    return "markdown";
  }
  if (baseType.startsWith("text/") && baseType !== "text/html") {
    return "text";
  }
  return "none";
}

export function normalizeAttachment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const dataBase64 = asOptionalTrimmedString(value.dataBase64);
  if (!dataBase64) {
    return null;
  }

  const fileName = asOptionalTrimmedString(value.fileName);
  const contentType = resolveAttachmentContentType(value.contentType, fileName);
  const previewMode = resolveAttachmentPreviewMode(contentType, fileName);
  const decodedBytes = decodeBase64ToBytes(dataBase64);
  if (!decodedBytes) {
    return {
      dataBase64,
      decodeState: INVALID_BASE64,
      previewMode,
      ...(fileName ? { fileName } : {}),
      ...(contentType ? { contentType } : {}),
    };
  }

  if (previewMode === "markdown" || previewMode === "text") {
    const decodedText = decodeUtf8Text(decodedBytes);
    if (decodedText === null) {
      return {
        dataBase64,
        decodedBytes,
        decodeState: PREVIEW_UNAVAILABLE,
        previewMode,
        ...(fileName ? { fileName } : {}),
        ...(contentType ? { contentType } : {}),
      };
    }
    return {
      dataBase64,
      decodedBytes,
      decodeState: OK,
      previewMode,
      text: decodedText,
      ...(fileName ? { fileName } : {}),
      ...(contentType ? { contentType } : {}),
    };
  }

  return {
    dataBase64,
    decodedBytes,
    decodeState: OK,
    previewMode,
    ...(fileName ? { fileName } : {}),
    ...(contentType ? { contentType } : {}),
  };
}

export function buildAttachmentPreview(text, options = {}) {
  const maxLines =
    Number.isFinite(options.maxLines) && options.maxLines > 0
      ? Math.floor(options.maxLines)
      : ATTACHMENT_PREVIEW_MAX_LINES;
  const maxChars =
    Number.isFinite(options.maxChars) && options.maxChars > 0
      ? Math.floor(options.maxChars)
      : ATTACHMENT_PREVIEW_MAX_CHARS;

  const lines = String(text).split("\n");
  const clippedLines = lines.slice(0, maxLines);
  const lineTruncated = lines.length > maxLines;

  let previewText = clippedLines.join("\n");
  let charTruncated = false;
  if (previewText.length > maxChars) {
    previewText = previewText.slice(0, maxChars);
    charTruncated = true;
  }

  return {
    previewText,
    truncated: lineTruncated || charTruncated,
  };
}
