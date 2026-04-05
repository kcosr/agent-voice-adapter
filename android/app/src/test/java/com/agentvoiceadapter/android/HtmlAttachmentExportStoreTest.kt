package com.agentvoiceadapter.android

import org.junit.Assert.assertTrue
import org.junit.Test

class HtmlAttachmentExportStoreTest {
  @Test
  fun `keeps filename extension when present`() {
    val exportName = HtmlAttachmentExportStore.buildExportFileName(
      fileName = "notes.md",
      attachmentBytes = "# Notes\n- one".toByteArray(Charsets.UTF_8),
      contentType = "text/plain",
    )

    assertTrue(exportName.matches(Regex("^notes-[a-f0-9]{16}\\.md$")))
  }

  @Test
  fun `infers extension from content type when filename has no extension`() {
    val exportName = HtmlAttachmentExportStore.buildExportFileName(
      fileName = "report",
      attachmentBytes = "{\"ok\":true}".toByteArray(Charsets.UTF_8),
      contentType = "application/json; charset=utf-8",
    )

    assertTrue(exportName.matches(Regex("^report-[a-f0-9]{16}\\.json$")))
  }

  @Test
  fun `falls back to attachment txt name when filename is empty`() {
    val exportName = HtmlAttachmentExportStore.buildExportFileName(
      fileName = " ",
      attachmentBytes = "hello".toByteArray(Charsets.UTF_8),
      contentType = "",
    )

    assertTrue(exportName.matches(Regex("^attachment-[a-f0-9]{16}\\.txt$")))
  }
}
