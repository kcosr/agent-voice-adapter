package com.agentvoiceadapter.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AttachmentContentTypeResolverTest {
  @Test
  fun `keeps explicit content type when provided`() {
    assertEquals(
      "text/plain",
      AttachmentContentTypeResolver.resolveContentType("index.html", "text/plain"),
    )
  }

  @Test
  fun `infers html content type from file extension when absent`() {
    assertEquals(
      "text/html",
      AttachmentContentTypeResolver.resolveContentType("index.html", ""),
    )
    assertEquals(
      "text/html",
      AttachmentContentTypeResolver.resolveContentType("snippet.HTM", " "),
    )
  }

  @Test
  fun `detects html attachments by content type or file extension`() {
    assertTrue(AttachmentContentTypeResolver.isHtmlAttachment("notes.txt", "text/html"))
    assertTrue(AttachmentContentTypeResolver.isHtmlAttachment("index.htm", ""))
    assertFalse(AttachmentContentTypeResolver.isHtmlAttachment("README.md", "text/markdown"))
  }
}
