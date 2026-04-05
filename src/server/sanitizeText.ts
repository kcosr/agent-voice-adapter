import type { SanitizerConfig } from "./config";

const BACKTICKS_RE = /`+/g;
const MARKDOWN_ARTIFACTS_RE = /[*_~>#]/g;
const URL_PROTOCOL_RE = /\bhttps?:\/\//gi;
// Matches complete emoji sequences via \p{RGI_Emoji} (covers ZWJ families, skin
// tones, flags, keycaps, tag sequences), plus \p{Extended_Pictographic} for
// lone pictographs, plus lone ZWJ/VS-16 stragglers. The `v` flag is required
// for the \p{RGI_Emoji} string property (ES2024, Node 20+).
const EMOJI_RE = /\p{RGI_Emoji}|\p{Extended_Pictographic}|\u200D|\uFE0F/gv;
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

  if (config.stripEmoji) {
    output = output.replace(EMOJI_RE, "");
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
