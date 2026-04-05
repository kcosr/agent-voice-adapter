package com.agentvoiceadapter.android

object AttachmentContentTypeResolver {
  fun resolveContentType(fileName: String, contentType: String): String {
    val normalized = contentType.trim()
    if (normalized.isNotEmpty()) {
      return normalized
    }
    return if (isHtmlFileName(fileName)) {
      "text/html"
    } else {
      ""
    }
  }

  fun isHtmlAttachment(fileName: String, contentType: String): Boolean {
    val normalized = contentType.trim().lowercase()
    if (normalized == "text/html" || normalized.startsWith("text/html;")) {
      return true
    }
    return isHtmlFileName(fileName)
  }

  private fun isHtmlFileName(fileName: String): Boolean {
    val normalized = fileName.trim().lowercase()
    return normalized.endsWith(".html") || normalized.endsWith(".htm")
  }
}
