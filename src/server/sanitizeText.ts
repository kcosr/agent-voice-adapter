import type { SanitizerConfig } from "./config";

const BACKTICKS_RE = /`+/g;
const MARKDOWN_ARTIFACTS_RE = /[*_~>#]/g;
const URL_PROTOCOL_RE = /\bhttps?:\/\//gi;
const WHITESPACE_RE = /\s+/g;

export interface SanitizationResult {
  originalText: string;
  sanitizedText: string;
  changed: boolean;
}

export function sanitizeTtsText(input: string, config: SanitizerConfig): SanitizationResult {
  const originalText = input;
  let output = input;

  if (config.stripBackticks) {
    output = output.replace(BACKTICKS_RE, "");
  }

  if (config.stripMarkdownArtifacts) {
    output = output.replace(MARKDOWN_ARTIFACTS_RE, "");
  }

  if (config.stripUrlProtocol) {
    output = output.replace(URL_PROTOCOL_RE, "");
  }

  if (config.collapseWhitespace) {
    output = output.replace(WHITESPACE_RE, " ");
  }

  output = output.trim();

  if (output.length > config.maxTextChars) {
    output = output.slice(0, config.maxTextChars);
  }

  return {
    originalText,
    sanitizedText: output,
    changed: output !== originalText,
  };
}
