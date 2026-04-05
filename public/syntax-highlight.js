import { escapeHtml } from "./html-utils.js";

const LANGUAGE_BY_EXTENSION = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  h: "c",
  hpp: "cpp",
  html: "markup",
  htm: "markup",
  java: "java",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  kt: "kotlin",
  kts: "kotlin",
  py: "python",
  sh: "bash",
  ts: "typescript",
  tsx: "typescript",
  xml: "markup",
  yml: "yaml",
  yaml: "yaml",
};

const LANGUAGE_ALIASES = {
  "c++": "cpp",
  cxx: "cpp",
  htm: "markup",
  html: "markup",
  js: "javascript",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  py: "python",
  shell: "bash",
  sh: "bash",
  ts: "typescript",
  tsx: "typescript",
  xml: "markup",
  yml: "yaml",
};

const KEYWORDS = {
  javascript: new Set([
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "default",
    "delete",
    "do",
    "else",
    "export",
    "extends",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "let",
    "new",
    "return",
    "switch",
    "throw",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
    "null",
    "true",
    "false",
  ]),
  typescript: new Set([
    "abstract",
    "any",
    "as",
    "asserts",
    "await",
    "boolean",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "declare",
    "default",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "implements",
    "import",
    "in",
    "infer",
    "interface",
    "is",
    "keyof",
    "let",
    "module",
    "namespace",
    "never",
    "new",
    "null",
    "number",
    "object",
    "private",
    "protected",
    "public",
    "readonly",
    "return",
    "satisfies",
    "static",
    "string",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "type",
    "typeof",
    "undefined",
    "unknown",
    "void",
    "while",
  ]),
  kotlin: new Set([
    "as",
    "break",
    "class",
    "continue",
    "data",
    "do",
    "else",
    "false",
    "for",
    "fun",
    "if",
    "in",
    "interface",
    "is",
    "null",
    "object",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "super",
    "this",
    "throw",
    "true",
    "try",
    "typealias",
    "val",
    "var",
    "when",
    "while",
  ]),
  java: new Set([
    "abstract",
    "assert",
    "boolean",
    "break",
    "byte",
    "case",
    "catch",
    "char",
    "class",
    "const",
    "continue",
    "default",
    "do",
    "double",
    "else",
    "enum",
    "extends",
    "false",
    "final",
    "finally",
    "float",
    "for",
    "if",
    "implements",
    "import",
    "instanceof",
    "int",
    "interface",
    "long",
    "native",
    "new",
    "null",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "short",
    "static",
    "strictfp",
    "super",
    "switch",
    "synchronized",
    "this",
    "throw",
    "throws",
    "transient",
    "true",
    "try",
    "void",
    "volatile",
    "while",
  ]),
  python: new Set([
    "and",
    "as",
    "assert",
    "async",
    "await",
    "break",
    "class",
    "continue",
    "def",
    "del",
    "elif",
    "else",
    "except",
    "false",
    "finally",
    "for",
    "from",
    "global",
    "if",
    "import",
    "in",
    "is",
    "lambda",
    "none",
    "nonlocal",
    "not",
    "or",
    "pass",
    "raise",
    "return",
    "true",
    "try",
    "while",
    "with",
    "yield",
  ]),
  yaml: new Set(["true", "false", "null", "yes", "no", "on", "off"]),
  json: new Set(["true", "false", "null"]),
  bash: new Set([
    "case",
    "do",
    "done",
    "elif",
    "else",
    "esac",
    "fi",
    "for",
    "function",
    "if",
    "in",
    "local",
    "return",
    "then",
    "until",
    "while",
  ]),
  c: new Set([
    "auto",
    "break",
    "case",
    "char",
    "const",
    "continue",
    "default",
    "do",
    "double",
    "else",
    "enum",
    "extern",
    "float",
    "for",
    "goto",
    "if",
    "inline",
    "int",
    "long",
    "register",
    "restrict",
    "return",
    "short",
    "signed",
    "sizeof",
    "static",
    "struct",
    "switch",
    "typedef",
    "union",
    "unsigned",
    "void",
    "volatile",
    "while",
  ]),
  cpp: new Set([
    "alignas",
    "alignof",
    "auto",
    "bool",
    "break",
    "case",
    "catch",
    "char",
    "class",
    "const",
    "constexpr",
    "continue",
    "default",
    "delete",
    "do",
    "double",
    "else",
    "enum",
    "explicit",
    "export",
    "extern",
    "false",
    "float",
    "for",
    "friend",
    "if",
    "inline",
    "int",
    "long",
    "namespace",
    "new",
    "noexcept",
    "nullptr",
    "operator",
    "private",
    "protected",
    "public",
    "return",
    "short",
    "signed",
    "sizeof",
    "static",
    "struct",
    "switch",
    "template",
    "this",
    "throw",
    "true",
    "try",
    "typedef",
    "typename",
    "union",
    "unsigned",
    "using",
    "virtual",
    "void",
    "while",
  ]),
  markup: new Set([
    "a",
    "article",
    "aside",
    "body",
    "button",
    "code",
    "div",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "html",
    "img",
    "input",
    "label",
    "li",
    "link",
    "main",
    "meta",
    "nav",
    "ol",
    "option",
    "p",
    "pre",
    "script",
    "section",
    "select",
    "span",
    "style",
    "table",
    "tbody",
    "td",
    "textarea",
    "th",
    "thead",
    "title",
    "tr",
    "ul",
  ]),
};

const LANGUAGE_COMMENTS = {
  javascript: {
    line: ["//"],
    block: [["/*", "*/"]],
  },
  typescript: {
    line: ["//"],
    block: [["/*", "*/"]],
  },
  java: {
    line: ["//"],
    block: [["/*", "*/"]],
  },
  kotlin: {
    line: ["//"],
    block: [["/*", "*/"]],
  },
  c: {
    line: ["//"],
    block: [["/*", "*/"]],
  },
  cpp: {
    line: ["//"],
    block: [["/*", "*/"]],
  },
  python: {
    line: ["#"],
    block: [],
  },
  yaml: {
    line: ["#"],
    block: [],
  },
  bash: {
    line: ["#"],
    block: [],
  },
  json: {
    line: [],
    block: [],
  },
  markup: {
    line: [],
    block: [["<!--", "-->"]],
  },
};

const TEXT_LIKE_CONTENT_TYPES = new Set([
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/sql",
  "application/typescript",
  "application/x-httpd-php",
  "application/x-sh",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "text/css",
  "text/csv",
  "text/html",
  "text/javascript",
  "text/plain",
  "text/typescript",
  "text/x-python",
  "text/xml",
  "text/yaml",
]);

function startsWithAt(source, index, value) {
  return source.slice(index, index + value.length) === value;
}

function isWordStart(char) {
  return /[A-Za-z_]/.test(char);
}

function isWordBody(char) {
  return /[A-Za-z0-9_$-]/.test(char);
}

function parseQuotedString(source, startIndex, quoteChar) {
  let index = startIndex + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quoteChar) {
      index += 1;
      break;
    }
    index += 1;
  }
  return source.slice(startIndex, index);
}

function parseNumber(source, startIndex) {
  let index = startIndex;
  while (index < source.length && /[0-9_]/.test(source[index])) {
    index += 1;
  }
  if (source[index] === "." && /[0-9]/.test(source[index + 1] ?? "")) {
    index += 1;
    while (index < source.length && /[0-9_]/.test(source[index])) {
      index += 1;
    }
  }
  if ((source[index] === "e" || source[index] === "E") && /[-+0-9]/.test(source[index + 1] ?? "")) {
    index += 1;
    if (source[index] === "+" || source[index] === "-") {
      index += 1;
    }
    while (index < source.length && /[0-9_]/.test(source[index])) {
      index += 1;
    }
  }
  return source.slice(startIndex, index);
}

function highlightGeneric(source, language) {
  const keywords = KEYWORDS[language] ?? new Set();
  const comments = LANGUAGE_COMMENTS[language] ?? { line: [], block: [] };
  const lineCommentPrefixes = [...comments.line].sort((a, b) => b.length - a.length);
  const blockCommentDelimiters = [...comments.block].sort((a, b) => b[0].length - a[0].length);

  let index = 0;
  let highlighted = "";
  while (index < source.length) {
    const current = source[index];

    let matchedLineCommentPrefix = "";
    for (const prefix of lineCommentPrefixes) {
      if (startsWithAt(source, index, prefix)) {
        matchedLineCommentPrefix = prefix;
        break;
      }
    }
    if (matchedLineCommentPrefix) {
      let end = source.indexOf("\n", index);
      if (end < 0) {
        end = source.length;
      }
      const comment = source.slice(index, end);
      highlighted += `<span class="code-token-comment">${escapeHtml(comment)}</span>`;
      index = end;
      continue;
    }

    let blockMatch = null;
    for (const [open, close] of blockCommentDelimiters) {
      if (startsWithAt(source, index, open)) {
        blockMatch = [open, close];
        break;
      }
    }
    if (blockMatch) {
      const [open, close] = blockMatch;
      let end = source.indexOf(close, index + open.length);
      if (end < 0) {
        end = source.length;
      } else {
        end += close.length;
      }
      const comment = source.slice(index, end);
      highlighted += `<span class="code-token-comment">${escapeHtml(comment)}</span>`;
      index = end;
      continue;
    }

    if (current === '"' || current === "'" || current === "`") {
      const text = parseQuotedString(source, index, current);
      highlighted += `<span class="code-token-string">${escapeHtml(text)}</span>`;
      index += text.length;
      continue;
    }

    if (/[0-9]/.test(current)) {
      const numberText = parseNumber(source, index);
      highlighted += `<span class="code-token-number">${escapeHtml(numberText)}</span>`;
      index += numberText.length;
      continue;
    }

    if (isWordStart(current)) {
      let end = index + 1;
      while (end < source.length && isWordBody(source[end])) {
        end += 1;
      }
      const word = source.slice(index, end);
      const className = keywords.has(word.toLowerCase()) ? "code-token-keyword" : "";
      highlighted += className
        ? `<span class="${className}">${escapeHtml(word)}</span>`
        : escapeHtml(word);
      index = end;
      continue;
    }

    if (/[\[\]{}()=<>:+\-*/%&|!,.]/.test(current)) {
      highlighted += `<span class="code-token-operator">${escapeHtml(current)}</span>`;
      index += 1;
      continue;
    }

    highlighted += escapeHtml(current);
    index += 1;
  }

  return highlighted;
}

export function resolveSyntaxLanguage(fileName) {
  if (typeof fileName !== "string") {
    return null;
  }
  const normalized = fileName.trim().toLowerCase();
  if (!normalized || !normalized.includes(".")) {
    return null;
  }
  const extension = normalized.split(".").pop() ?? "";
  return LANGUAGE_BY_EXTENSION[extension] ?? null;
}

export function isTextLikeContentType(contentType) {
  const normalized = typeof contentType === "string" ? contentType.trim().toLowerCase() : "";
  if (!normalized) {
    return true;
  }
  if (normalized.startsWith("text/")) {
    return true;
  }
  const base = normalized.split(";")[0]?.trim() ?? normalized;
  return TEXT_LIKE_CONTENT_TYPES.has(base);
}

export function highlightCodeToHtml(source, language) {
  const normalizedLanguage = typeof language === "string" ? language.trim().toLowerCase() : "";
  if (!normalizedLanguage) {
    return escapeHtml(source);
  }
  const resolvedLanguage = LANGUAGE_ALIASES[normalizedLanguage] ?? normalizedLanguage;
  if (!KEYWORDS[resolvedLanguage]) {
    return escapeHtml(source);
  }
  return highlightGeneric(String(source ?? ""), resolvedLanguage);
}

export function renderCodeBlockHtml(source, language) {
  const safeLanguage = typeof language === "string" ? language.trim().toLowerCase() : "";
  const classAttribute = safeLanguage ? ` class="language-${safeLanguage}"` : "";
  return `<pre><code${classAttribute}>${highlightCodeToHtml(source, safeLanguage)}</code></pre>`;
}
