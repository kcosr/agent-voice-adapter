package com.agentvoiceadapter.android

object AttachmentSyntaxLanguageResolver {
  private val extensionToLanguage = mapOf(
    "kt" to "kotlin",
    "kts" to "kotlin",
    "java" to "java",
    "js" to "javascript",
    "mjs" to "javascript",
    "cjs" to "javascript",
    "ts" to "javascript",
    "tsx" to "javascript",
    "py" to "python",
    "json" to "json",
    "yaml" to "yaml",
    "yml" to "yaml",
    "xml" to "markup",
    "html" to "markup",
    "c" to "c",
    "cc" to "cpp",
    "cxx" to "cpp",
    "cpp" to "cpp",
    "h" to "cpp",
    "hpp" to "cpp",
    "hxx" to "cpp",
  )

  private val nonTextButHighlightableContentTypes = setOf(
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-javascript",
    "application/yaml",
    "application/x-yaml",
    "application/x-sh",
  )

  fun resolveLanguage(fileName: String): String? {
    val normalized = fileName.trim().lowercase()
    if (normalized.isEmpty()) {
      return null
    }
    val extension = normalized.substringAfterLast('.', missingDelimiterValue = "")
    if (extension.isEmpty() || extension == normalized) {
      return null
    }
    return extensionToLanguage[extension]
  }

  fun isTextLikeContentType(contentType: String): Boolean {
    val normalized = contentType.trim().lowercase()
    if (normalized.isEmpty()) {
      return true
    }
    val base = normalized.substringBefore(';').trim()
    if (base.isEmpty()) {
      return true
    }
    return base.startsWith("text/") || nonTextButHighlightableContentTypes.contains(base)
  }

  fun toFencedMarkdown(text: String, language: String): String {
    val fence = fenceDelimiter(text)
    val normalizedLanguage = language.trim()
    return buildString {
      append(fence)
      if (normalizedLanguage.isNotEmpty()) {
        append(normalizedLanguage)
      }
      append('\n')
      append(text)
      if (!text.endsWith('\n')) {
        append('\n')
      }
      append(fence)
    }
  }

  private fun fenceDelimiter(text: String): String {
    var maxTicks = 0
    var current = 0
    text.forEach { ch ->
      if (ch == '`') {
        current += 1
        if (current > maxTicks) {
          maxTicks = current
        }
      } else {
        current = 0
      }
    }
    return "`".repeat((maxTicks + 1).coerceAtLeast(3))
  }
}
