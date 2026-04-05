package com.agentvoiceadapter.android

import android.content.Context
import java.io.File
import java.io.IOException
import java.security.MessageDigest

object HtmlAttachmentExportStore {
  private const val EXPORT_DIR = "attachment_exports"

  fun getOrCreate(
    context: Context,
    fileName: String,
    attachmentBytes: ByteArray,
    contentType: String = "",
  ): File {
    val dir = File(context.filesDir, EXPORT_DIR)
    if (!dir.exists() && !dir.mkdirs()) {
      throw IOException("Failed to create attachment export directory.")
    }

    val exportFile = File(dir, buildExportFileName(fileName, attachmentBytes, contentType))
    if (!exportFile.exists()) {
      exportFile.writeBytes(attachmentBytes)
    }
    return exportFile
  }

  fun clear(context: Context): Int {
    val dir = File(context.filesDir, EXPORT_DIR)
    if (!dir.exists()) {
      return 0
    }
    val files = dir.listFiles() ?: return 0
    var deleted = 0
    for (file in files) {
      val removed = if (file.isDirectory) {
        file.deleteRecursively()
      } else {
        file.delete()
      }
      if (removed) {
        deleted += 1
      }
    }
    return deleted
  }

  internal fun buildExportFileName(
    fileName: String,
    attachmentBytes: ByteArray,
    contentType: String = "",
  ): String {
    val trimmedFileName = fileName.trim()
    val cleanedFileName = trimmedFileName
      .substringAfterLast('/')
      .substringAfterLast('\\')
    val baseName = cleanedFileName
      .substringBeforeLast('.')
      .lowercase()
      .replace(Regex("[^a-z0-9_-]+"), "-")
      .trim('-')
      .ifEmpty { "attachment" }
    val extension = resolveExtension(cleanedFileName, contentType)
    val hash = sha256Hex(fileName, contentType, attachmentBytes).take(16)
    return "$baseName-$hash.$extension"
  }

  private fun sha256Hex(fileName: String, contentType: String, attachmentBytes: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256")
    digest.update("$fileName\n$contentType\n".toByteArray(Charsets.UTF_8))
    digest.update(attachmentBytes)
    val hash = digest.digest()
    return hash.joinToString(separator = "") { byte -> "%02x".format(byte) }
  }

  private fun resolveExtension(fileName: String, contentType: String): String {
    val fromFileName = fileName
      .trim()
      .substringAfterLast('.', "")
      .lowercase()
      .replace(Regex("[^a-z0-9]+"), "")
    if (fromFileName.isNotEmpty()) {
      return fromFileName
    }
    return extensionFromContentType(contentType) ?: "txt"
  }

  private fun extensionFromContentType(contentType: String): String? {
    val mimeType = contentType.trim().lowercase().substringBefore(';').trim()
    if (mimeType.isEmpty()) {
      return null
    }

    return when (mimeType) {
      "text/markdown", "text/x-markdown" -> "md"
      "text/html" -> "html"
      "text/plain" -> "txt"
      "application/json", "text/json" -> "json"
      "text/csv" -> "csv"
      "application/xml", "text/xml" -> "xml"
      "application/yaml", "text/yaml", "text/x-yaml" -> "yaml"
      else -> {
        val subtype = mimeType
          .substringAfter('/', "")
          .substringBefore('+')
          .lowercase()
          .replace(Regex("[^a-z0-9]+"), "")
        subtype.ifEmpty { null }
      }
    }
  }
}
