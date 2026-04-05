package com.agentvoiceadapter.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AttachmentSyntaxLanguageResolverTest {
  @Test
  fun `resolves known extensions`() {
    assertEquals("javascript", AttachmentSyntaxLanguageResolver.resolveLanguage("snippet.ts"))
    assertEquals("kotlin", AttachmentSyntaxLanguageResolver.resolveLanguage("MainActivity.kt"))
    assertEquals("markup", AttachmentSyntaxLanguageResolver.resolveLanguage("layout.xml"))
  }

  @Test
  fun `returns null for unknown or missing extension`() {
    assertNull(AttachmentSyntaxLanguageResolver.resolveLanguage("README"))
    assertNull(AttachmentSyntaxLanguageResolver.resolveLanguage("notes.customext"))
    assertNull(AttachmentSyntaxLanguageResolver.resolveLanguage(""))
  }

  @Test
  fun `detects text-like content types`() {
    assertTrue(AttachmentSyntaxLanguageResolver.isTextLikeContentType("text/plain"))
    assertTrue(AttachmentSyntaxLanguageResolver.isTextLikeContentType("application/json"))
    assertTrue(AttachmentSyntaxLanguageResolver.isTextLikeContentType(""))
    assertFalse(AttachmentSyntaxLanguageResolver.isTextLikeContentType("image/png"))
  }

  @Test
  fun `creates fenced markdown with delimiter longer than embedded backticks`() {
    val body = "line one\n```json\n{\"a\":1}\n```\nline two"
    val rendered = AttachmentSyntaxLanguageResolver.toFencedMarkdown(body, "python")

    assertTrue(rendered.startsWith("````python\n"))
    assertTrue(rendered.endsWith("\n````"))
    assertTrue(rendered.contains(body))
  }
}
